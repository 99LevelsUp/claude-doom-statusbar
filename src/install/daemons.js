// Stopping render daemons and removing their files, for the installer: `uninstall` stops this
// installation's daemon, and `install` stops the daemon of the old global package before npm
// removes it (src/install/old-package.js). Used by bin/cli.js.
//
// A pid is stopped only when the process list confirms it is node running that installation's
// src/daemon.js, started when the heartbeat says; a stale heartbeat may name a pid reused by
// anything. The kill comes before the files go, or the daemon would rewrite them on its next pass.
//
// Where to look: the runtime directory. On Linux and macOS the shell running the installer may see
// another XDG_RUNTIME_DIR than Claude Code did (tmux, ssh), so every candidate directory is tried,
// each only when it is a real directory of this user and not a link (existingPrivateDir). With
// GAMEBAR_RUNTIME_DIR set, only that one, so a test never reaches the live bar. Releases before
// 1.0.0 used another directory name and another file prefix; those are tried the same way.

import { readFileSync, writeFileSync, readdirSync, unlinkSync, rmdirSync, statSync, lstatSync } from "node:fs";
import path from "node:path";
import {
  daemonPrefix, payloadPrefix, framePrefix, runtimeDir, existingPrivateDir, ensureRuntimeDir, readLearned, samePath,
  RUNTIME_NAME, OLD_RUNTIME_NAME, FILE_PREFIX, OLD_FILE_PREFIX, OLD_FACES_PREFIX,
} from "../platform/runtime.js";
import { envGet } from "../platform/env.js";
import { confirmedDaemonPid } from "../platform/supervise.js";
import { staleStateFiles } from "../platform/sweep.js";

// Every directory the runtime directory called `name` may be, before any check. `opts` carries
// platform, euid and lstat for tests.
export function runtimeCandidates(env = process.env, opts = {}) {
  const { platform = process.platform, euid = process.geteuid ? process.geteuid() : null, name = RUNTIME_NAME } = opts;
  const own = runtimeDir(env, { ...opts, name });
  if (envGet("RUNTIME_DIR", env) || platform === "win32") return [own];
  const dirs = new Set([own]);
  if (String(env.XDG_RUNTIME_DIR || "").startsWith("/")) dirs.add(path.posix.join(env.XDG_RUNTIME_DIR, name));
  if (platform === "darwin" && String(env.TMPDIR || "").startsWith("/")) dirs.add(path.posix.join(env.TMPDIR, name));
  dirs.add(`/tmp/${name}-${euid}`);
  return [...dirs];
}

// The candidates that pass existingPrivateDir: the only directories the installer reads or changes.
export const privateCandidates = (env = process.env, opts = {}) =>
  runtimeCandidates(env, opts).filter((dir) => existingPrivateDir(dir, opts) !== null);

// SIGTERM lets the daemon close its socket and drop its heartbeat; it exits on its own within 2 s
// (STOP_WAIT_MS leaves room). One still running then is killed. True when the pid is gone.
const STOP_WAIT_MS = 3000;
// A zombie (exited, not yet reaped by its parent) still answers kill(pid, 0) but is gone.
function pidAlive(pid) {
  try { process.kill(pid, 0); } catch (e) { return e.code === "EPERM"; }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch { return false; }
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function stopPid(pid) {
  try { process.kill(pid); } catch { return !pidAlive(pid); }
  for (let waited = 0; pidAlive(pid) && waited < STOP_WAIT_MS; waited += 50) sleepSync(50);
  if (pidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    for (let waited = 0; pidAlive(pid) && waited < 1000; waited += 50) sleepSync(50);
  }
  return !pidAlive(pid);
}

// Stops the daemon the heartbeat file names when it is confirmed to run one of `daemonJs` (several
// spellings of one path: as installed and its real path). Returns a note, or null when the
// heartbeat names no pid. `what` names the daemon in the note.
function stopNamedDaemon(heartbeat, daemonJs, what, platform) {
  let hb = null;
  try { hb = JSON.parse(readFileSync(heartbeat, "utf-8")); } catch {}
  if (!hb || !Number.isInteger(hb.pid) || hb.pid <= 0) return null;
  let pid = null;
  for (const js of new Set(daemonJs)) if (pid === null) pid = confirmedDaemonPid(hb, platform, js);
  if (pid === null) return `left pid ${hb.pid} running: not confirmed as ${what}`;
  return stopPid(pid) ? `stopped ${what} (pid ${pid})`
    : `could not stop ${what} (pid ${pid}); its files are removed, and it exits after its idle time`;
}

// Removes the files in `dir` whose names start with one of `prefixes`. Returns how many went.
function removePrefixed(dir, prefixes) {
  let names = [];
  try { names = readdirSync(dir); } catch {}
  let removed = 0;
  for (const n of names) {
    if (!prefixes.some((p) => n.startsWith(p))) continue;
    try { unlinkSync(path.join(dir, n)); removed++; } catch {}
  }
  return removed;
}

// Removes the files a release before 1.0.0 left in `dir` that the session sweep would remove:
// sessions gone cold and a face cache older than the sweep's time to live. Another installation's
// daemon files and the shared learned state are never among them.
function removeStaleOld(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return 0; }
  const old = names.filter((n) => n.startsWith(OLD_FILE_PREFIX) || n.startsWith(OLD_FACES_PREFIX));
  const ageOf = (n) => { try { return Date.now() - statSync(path.join(dir, n)).mtimeMs; } catch { return null; } };
  let removed = 0;
  for (const n of staleStateFiles(old, ageOf)) {
    try { unlinkSync(path.join(dir, n)); removed++; } catch {}
  }
  return removed;
}

// A directory of the bar's own name that is left empty goes, as an older release left it. Never
// with GAMEBAR_RUNTIME_DIR set, which names a directory the bar did not create, and never on
// Windows, where it is the temp directory. rmdir fails on a directory that still holds files, so
// another installation's files keep it.
function removeIfEmpty(dir, env, platform) {
  if (platform === "win32" || envGet("RUNTIME_DIR", env)) return;
  try { rmdirSync(dir); } catch { /* not empty: other files */ }
}

const daemonFiles = (hash, prefix) => [daemonPrefix(hash, prefix), payloadPrefix(hash, prefix), framePrefix(hash, prefix)];

// `uninstall`: stops the installation with this hash, whose daemon runs `daemonJs`, and removes its
// daemon, payload and frame files under the current names. In every old runtime directory that
// passes the check it does the same for the old prefix, and also removes the old-prefix files the
// session sweep would remove. Returns notes for the output.
export function stopDaemon({ hash, daemonJs, env = process.env, ...opts }) {
  const platform = opts.platform || process.platform;
  const notes = [];
  const what = "the render daemon";
  for (const [name, prefix] of [[RUNTIME_NAME, FILE_PREFIX], [OLD_RUNTIME_NAME, OLD_FILE_PREFIX]]) {
    for (const dir of privateCandidates(env, { ...opts, name })) {
      const note = stopNamedDaemon(path.join(dir, `${daemonPrefix(hash, prefix)}json`), [daemonJs], what, platform);
      if (note) notes.push(note);
      let removed = removePrefixed(dir, daemonFiles(hash, prefix));
      if (prefix === OLD_FILE_PREFIX) removed += removeStaleOld(dir);
      if (removed) notes.push(`removed ${removed} render daemon file(s) from ${dir}`);
      removeIfEmpty(dir, env, platform);
    }
  }
  return notes;
}

// `install`: stops the daemon of the old global package at `root` (its real path), which ran
// `<root>/src/daemon.js` and kept its files under the old prefix and the old runtime directory.
// Its files stay: `removeOldPackageFiles` removes them once the package is gone.
export function stopOldPackageDaemon({ hash, daemonJs, env = process.env, ...opts }) {
  const platform = opts.platform || process.platform;
  const notes = [];
  for (const dir of privateCandidates(env, { ...opts, name: OLD_RUNTIME_NAME })) {
    const note = stopNamedDaemon(path.join(dir, `${daemonPrefix(hash, OLD_FILE_PREFIX)}json`), daemonJs,
      "the old package's render daemon", platform);
    if (note) notes.push(note);
  }
  return notes;
}

// Learned state (see readLearned in src/platform/runtime.js) under its name in an old runtime
// directory: its name in the runtime directory now, or null when `name` is not learned state or the
// bar never reads it from the old place. The rate-health accumulator and the rate-limit pool
// (src/metrics/ratelimits.js) carried the old prefix; a session's savings totals
// (src/metrics/savings.js) kept their name. A setting that names another file for one of them
// means the old file is not read, as in those modules.
function learnedName(name, env) {
  for (const [shared, setting] of [["ratehealth_global.json", null], ["ratelimits_global.json", "RATELIMITS"]]) {
    if (name === `${OLD_FILE_PREFIX}${shared}`) return setting && envGet(setting, env) ? null : `${FILE_PREFIX}${shared}`;
  }
  if (/^savings_.+\.json$/.test(name)) return envGet("SAVINGS_STATE", env) || envGet("STATE", env) ? null : name;
  return null;
}

// Is `file` a regular file? A link is not one, and is never followed.
const regularFile = (file) => { try { return lstatSync(file).isFile(); } catch { return false; } };

// Moves the learned state in the old runtime directory `dir` to its new name in `newDir`: the old
// file is copied when the new one is missing, through readLearned like every reader of it, and then
// removed. An old file whose new one exists already is removed. A file that is the new one itself
// (Windows keeps both in the temp directory, as does GAMEBAR_RUNTIME_DIR) is left alone, and so is
// one that could not be copied. Returns { moved, kept }, kept the names left in place.
function moveLearned(dir, newDir, env) {
  let names = [];
  try { names = readdirSync(dir); } catch {}
  let moved = 0;
  const kept = new Set();
  for (const n of names) {
    const target = learnedName(n, env);
    if (!target) continue;
    const oldFile = path.join(dir, n);
    if (!regularFile(oldFile)) continue;
    if (!newDir) { kept.add(n); continue; }
    const file = path.join(newDir, target);
    if (samePath(oldFile, file)) { kept.add(n); continue; }
    const { text, old } = readLearned(file, () => oldFile);
    if (old) {
      try { writeFileSync(file, text, { flag: "wx" }); } catch (e) { if (e.code !== "EEXIST") { kept.add(n); continue; } }
    } else if (text === null) { kept.add(n); continue; }
    try { unlinkSync(oldFile); moved++; } catch { kept.add(n); }
  }
  return { moved, kept };
}

// Removes every regular file in `dir` named with the old prefix or the old face cache's prefix,
// whatever its age or install hash, except `keep`. Returns how many went.
function removeOldPrefixed(dir, keep) {
  let names = [];
  try { names = readdirSync(dir); } catch {}
  let removed = 0;
  for (const n of names) {
    if (!(n.startsWith(OLD_FILE_PREFIX) || n.startsWith(OLD_FACES_PREFIX)) || keep.has(n)) continue;
    const file = path.join(dir, n);
    if (!regularFile(file)) continue;
    try { unlinkSync(file); removed++; } catch {}
  }
  return removed;
}

// After npm removed the old package: in every old runtime directory that passes the check, its
// daemon, payload and frame files go, its learned state moves to the new names, every other file
// under the old prefixes goes (the old package is gone, so none of them is in use by it), and the
// directory goes when that leaves it empty. Files under the current prefix are never touched.
// Returns { daemon, learned, other }, how many files each step removed or moved.
export function removeOldPackageFiles({ hash, env = process.env, ...opts }) {
  const platform = opts.platform || process.platform;
  const newDir = ensureRuntimeDir(env, { platform });
  const out = { daemon: 0, learned: 0, other: 0 };
  for (const dir of privateCandidates(env, { ...opts, name: OLD_RUNTIME_NAME })) {
    out.daemon += removePrefixed(dir, daemonFiles(hash, OLD_FILE_PREFIX));
    const { moved, kept } = moveLearned(dir, newDir, env);
    out.learned += moved;
    out.other += removeOldPrefixed(dir, kept);
    removeIfEmpty(dir, env, platform);
  }
  return out;
}
