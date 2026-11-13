// The runtime directory, the names of every file the bar's processes share, the daemon's address,
// process identity and the atomic write. Shared by the hook, the render path, the daemon and the
// installer. No spawns.

import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync, lstatSync, mkdirSync, chmodSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PACKAGE_ROOT } from "../package-root.js";

// Filesystem-safe session key, shared by hook + statusline so they agree on file names.
export const sidKey = (id) => String(id || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);

// The directory every file of the bar lives in. On Windows that is the temp directory, which
// belongs to one user. On Linux and macOS /tmp is shared by every user, so the bar uses a private
// per-user directory instead. The client (src/doombar-client.sh) applies the same rule with bash
// builtins, so every process of a session lands in the same place:
//   1. DOOMBAR_RUNTIME_DIR when set (tests, custom setups), on every platform;
//   2. Windows: the temp directory;
//   3. $XDG_RUNTIME_DIR/doombar when XDG_RUNTIME_DIR is absolute and either missing or owned by
//      this user. A missing one keeps its path: the bar then shows offline rather than moving to
//      another directory in the middle of a session (an ssh logout removes /run/user/<uid>);
//   4. macOS: $TMPDIR/doombar when TMPDIR is absolute and owned by this user (it is per user);
//   5. otherwise /tmp/doombar-<effective uid>.
const ownerUid = (p) => { try { return statSync(p).uid; } catch { return null; } };
const absolute = (p) => typeof p === "string" && p.startsWith("/");
// The daemon looks the directory up many times per render; with this process's own uid and
// filesystem, the answer for an environment is kept rather than stat-ed again.
const resolvedDirs = new Map();
export function runtimeDir(env = process.env, opts = {}) {
  const { platform = process.platform, euid = process.geteuid ? process.geteuid() : null, ownerOf = ownerUid } = opts;
  if (env.DOOMBAR_RUNTIME_DIR) return env.DOOMBAR_RUNTIME_DIR;
  if (platform === "win32") return os.tmpdir();
  const cacheable = opts.ownerOf === undefined && opts.euid === undefined;
  const key = `${platform}|${env.XDG_RUNTIME_DIR}|${env.TMPDIR}`;
  if (cacheable && resolvedDirs.has(key)) return resolvedDirs.get(key);
  let dir = `/tmp/doombar-${euid}`;
  const xdg = env.XDG_RUNTIME_DIR, tmp = env.TMPDIR;
  const xdgOwner = absolute(xdg) ? ownerOf(xdg) : undefined;
  if (absolute(xdg) && (xdgOwner === null || xdgOwner === euid)) dir = path.posix.join(xdg, "doombar");
  else if (platform === "darwin" && absolute(tmp) && ownerOf(tmp) === euid) dir = path.posix.join(tmp, "doombar");
  if (cacheable) resolvedDirs.set(key, dir);
  return dir;
}

// The runtime directory when it is safe to use, else null. On Linux and macOS it is created with
// mode 0700 (never its parent, so a removed /run/user/<uid> stays removed) and accepted only as a
// real directory, not a link, owned by this user; group or world bits on it are cleared. Nothing
// may be read from or written to a refused directory: another user may have planted it. On
// Windows the temp directory is used as it is. A success is remembered for the process.
const ensured = new Set();
export function ensureRuntimeDir(env = process.env, { platform = process.platform } = {}) {
  const dir = runtimeDir(env, { platform });
  if (platform === "win32" || ensured.has(dir)) return dir;
  try {
    try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.geteuid()) return null;
    if (st.mode & 0o077) chmodSync(dir, 0o700);
  } catch { return null; }
  ensured.add(dir);
  return dir;
}

// Checkpoint (statusline-owned folded state) + journal (hook-appended events) live next to
// each other so both processes derive the same pair from the session id. MUGSHOT_STATE
// overrides the checkpoint path (tests, custom setups); the journal hangs off it.
export function statePaths(sessionId, env = process.env) {
  const base = env.MUGSHOT_STATE || path.join(runtimeDir(env), `mugshot_${sidKey(sessionId)}.json`);
  return { checkpoint: base, journal: base + ".jsonl" };
}

// Install-root hash: a stable short id of the directory this package runs from, so two
// installations (say a repo checkout and a global npm copy) never read or write each other's
// daemon files. Normalized to forward slashes and lower case, so spelling differences of the
// same Windows path give the same hash. Only Node computes it; the installer bakes it into the
// statusLine command.
export const ROOT_HASH_LEN = 10;
export function rootHash(root = PACKAGE_ROOT) {
  const norm = path.resolve(root).replace(/\\/g, "/").toLowerCase();
  return createHash("sha1").update(norm).digest("hex").slice(0, ROOT_HASH_LEN);
}
const ROOT_HASH = rootHash();

export const pipePath = (hash) => `\\\\.\\pipe\\doombar-${hash}`;

// The address the render daemon listens on, so only one runs. On Windows a named pipe, one per
// installation. Elsewhere a Unix socket file in the private runtime directory, one per
// installation and runtime directory: an abstract socket would carry no permissions, and any
// user could take the name first.
export const daemonSocket = (hash, env = process.env, platform = process.platform) =>
  platform === "win32" ? pipePath(hash) : path.join(runtimeDir(env, { platform }), `${daemonPrefix(hash)}sock`);

// Is anything bound to a daemon address? Only "no such pipe or socket" and, for a socket file a
// killed daemon left behind, "connection refused" mean no. A timeout or any other error (all pipe
// instances busy, a daemon whose loop hangs) counts as bound, so a live daemon is never taken for
// gone.
export function addressBound(addr, timeoutMs) {
  return new Promise((resolve) => {
    let sock = null, timer = null, done = false;
    const finish = (bound) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve(bound);
    };
    timer = setTimeout(() => finish(true), timeoutMs);
    sock = net.connect(addr);
    sock.on("connect", () => finish(true));
    sock.on("error", (e) => finish(!(e && (e.code === "ENOENT" || e.code === "ECONNREFUSED"))));
  });
}

// Linux: a process's start time, in clock ticks since boot (field 22 of /proc/<pid>/stat), or
// null. Read after the last ")", because the command name before it may hold spaces and ")".
// Together with the command line it tells a daemon apart from another process that got its pid.
export function procStartTicks(pid = "self", read = (p) => readFileSync(p, "utf8")) {
  try {
    const stat = read(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return /^\d+$/.test(fields[19]) ? fields[19] : null;
  } catch { return null; }
}

export const payloadPrefix = (hash) => `mugshot_payload_${hash}_`;
export const framePrefix = (hash) => `mugshot_frame_${hash}_`;
export const daemonPrefix = (hash) => `mugshot_daemon_${hash}.`;

// Every per-session file. Most sit next to the checkpoint, so MUGSHOT_STATE relocates them and
// the sweep (which scans the checkpoint's directory) sees them. The render daemon's payload and
// frame are the exception: they always live in the runtime directory, prefixed with the install
// hash, so the daemon knows where to look without being told about MUGSHOT_STATE. The `.json`
// suffix keeps them inside the sweep's name patterns even though the frame is text. The
// writers, the sweep and end-of-session cleanup all name files through here, so they always agree.
export function sessionPaths(sessionId, hash = ROOT_HASH, env = process.env) {
  const { checkpoint, journal } = statePaths(sessionId, env);
  const dir = path.dirname(checkpoint);
  const rt = runtimeDir(env);
  const key = sidKey(sessionId);
  return {
    checkpoint,
    journal,
    git: path.join(dir, `mugshot_git_${key}.json`),     // git probe throttle marker
    msys: path.join(dir, `mugshot_msys_${key}.json`),   // bash-count probe throttle marker
    adv: path.join(dir, `mugshot_adv_${key}.json`),     // advisor consult cache
    savings: path.join(dir, `savings_${key}.json`),     // lean-ctx savings accumulator
    payload: path.join(rt, `${payloadPrefix(hash)}${key}.json`), // client -> daemon input
    frame: path.join(rt, `${framePrefix(hash)}${key}.json`),     // daemon -> client output
  };
}

// Daemon-wide files, one pair per installation, shared by every session it serves. Never a
// session's scratch: the sweep and end-of-session cleanup leave them alone.
export function daemonPaths(hash = ROOT_HASH, env = process.env) {
  const dir = runtimeDir(env);
  return {
    heartbeat: path.join(dir, `${daemonPrefix(hash)}json`),
    claim: path.join(dir, `${daemonPrefix(hash)}claim`), // restart throttle
  };
}

// Write via a temp file + rename, so a concurrent reader never sees a half-written file. On
// failure (on Windows typically a rename while another process has the target open) the temp
// file is removed and the error is rethrown.
export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

// A numeric environment setting: unset, empty or not a number means the default.
export const envNum = (v, dflt) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : dflt);

// The version in <root>/package.json, or "0" when it is missing or not one non-blank word. The
// daemon reports it and the hooks compare against it, so both must read it through here.
export function packageVersion(root = PACKAGE_ROOT) {
  try {
    const v = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
    return /^\S+$/.test(String(v)) ? String(v) : "0";
  } catch { return "0"; }
}
