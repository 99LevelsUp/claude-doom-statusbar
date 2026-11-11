// Shared, pure reducer for the DOOM HUD state, plus the file names and atomic write every process
// shares. No spawns.
//
// Two writers used to fight over one state file (hook did read-modify-write per event).
// Now hooks only APPEND raw events to a per-session journal, and statusline FOLDS that
// journal into a checkpoint at render time. This module is the fold — identical state
// shape as before (spans, squad, pending, tasks, tasks_ts, expr, ts, errors, mode, git),
// so every downstream consumer (activityValues, the tests) is unchanged.

import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync, lstatSync, mkdirSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const GEIGER_WINDOW = 30.0; // seconds of tool-run history kept for the sparkline
export const MAX_RUN = 300.0; // drop an unclosed span after this (assume the Post was lost)
export const TASK_LINGER = 10.0; // seconds the task list lingers after all tasks settle (the count stays)

export const READ_TOOLS = new Set(["Read", "Grep", "Glob",
  "ctx_read", "ctx_multi_read", "ctx_search", "ctx_semantic_search", "ctx_tree", "ctx_overview"]);
export const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "ctx_shell", "ctx_edit"]);

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
export function runtimeDir(env = process.env, { platform = process.platform,
  euid = process.geteuid ? process.geteuid() : null, ownerOf = ownerUid } = {}) {
  if (env.DOOMBAR_RUNTIME_DIR) return env.DOOMBAR_RUNTIME_DIR;
  if (platform === "win32") return os.tmpdir();
  const xdg = env.XDG_RUNTIME_DIR;
  if (absolute(xdg)) {
    const owner = ownerOf(xdg);
    if (owner === null || owner === euid) return path.posix.join(xdg, "doombar");
  }
  const tmp = env.TMPDIR;
  if (platform === "darwin" && absolute(tmp) && ownerOf(tmp) === euid) return path.posix.join(tmp, "doombar");
  return `/tmp/doombar-${euid}`;
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
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function rootHash(root = PACKAGE_ROOT) {
  const norm = path.resolve(root).replace(/\\/g, "/").toLowerCase();
  return createHash("sha1").update(norm).digest("hex").slice(0, ROOT_HASH_LEN);
}
const ROOT_HASH = rootHash();

export const pipePath = (hash) => `\\\\.\\pipe\\doombar-${hash}`;

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
  const key = sidKey(sessionId);
  return {
    checkpoint,
    journal,
    git: path.join(dir, `mugshot_git_${key}.json`),     // git probe throttle marker
    msys: path.join(dir, `mugshot_msys_${key}.json`),   // bash-count probe throttle marker
    adv: path.join(dir, `mugshot_adv_${key}.json`),     // advisor consult cache
    savings: path.join(dir, `savings_${key}.json`),     // lean-ctx savings accumulator
    payload: path.join(runtimeDir(env), `${payloadPrefix(hash)}${key}.json`), // client -> daemon input
    frame: path.join(runtimeDir(env), `${framePrefix(hash)}${key}.json`),     // daemon -> client output
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

export function base(tool) {
  return tool.startsWith("mcp__") ? tool.split("__").pop() : tool;
}

// Task event subject: the exact key isn't documented, so try the likely ones.
export function taskTitle(ev) {
  return ev.task_title || ev.task_subject || ev.subject || ev.title ||
    (ev.tool_input && ev.tool_input.subject) || "task";
}

export function expression(name, tool) {
  const b = base(tool);
  if (["PostToolUseFailure", "StopFailure", "PermissionDenied"].includes(name)) return "ouch";
  if (["Stop", "TaskCompleted"].includes(name)) return "evl";
  if (name === "PostToolUse") {
    if (READ_TOOLS.has(b)) return Math.floor((Date.now() / 1000) * 2) % 2 === 0 ? "tl" : "tr";
    if (WRITE_TOOLS.has(b)) return "kill";
  }
  return null;
}

export function foldActivity(st, name, ev, now) {
  st.spans ??= [];
  st.squad ??= {};
  st.pending ??= [];
  st.tasks ??= {};   // keyed map: id -> { title, status, ts }
  st.errors ??= 0;

  const tool = base(ev.tool_name || "");
  if (name === "PreToolUse") {
    st.spans.push([now, null]); // open a run interval
    if (tool === "Agent") {
      const ti = ev.tool_input || {};
      st.pending.push({ type: ti.subagent_type || "", desc: ti.description || "", ts: now });
      st.pending = st.pending.filter((p) => now - p.ts < 60).slice(-16);
    }
  } else if (["PostToolUse", "PostToolUseFailure", "PermissionDenied"].includes(name)) {
    for (let i = st.spans.length - 1; i >= 0; i--) { // close the most recent open one
      if (st.spans[i][1] === null) { st.spans[i][1] = now; break; }
    }
  }

  if (["PostToolUseFailure", "StopFailure", "PermissionDenied"].includes(name)) {
    st.errors += 1;
  } else if (name === "SubagentStart") {
    const aid = String(ev.agent_id || now);
    const atype = ev.agent_type || "agent";
    let desc = "";
    for (let i = 0; i < st.pending.length; i++) { // FIFO match the launch by agent type
      if (st.pending[i].type === atype) { desc = st.pending[i].desc; st.pending.splice(i, 1); break; }
    }
    st.squad[aid] = { type: atype, start: now, desc };
  } else if (name === "SubagentStop") {
    delete st.squad[String(ev.agent_id || "")];
  } else if (name === "TaskCreated") {
    const id = String(ev.task_id ?? now);
    st.tasks[id] = { title: taskTitle(ev), status: "pending", ts: now };
    st.tasks_ts = now;
  } else if (name === "TaskCompleted") {
    const id = String(ev.task_id ?? "");
    if (st.tasks[id]) st.tasks[id].status = "completed";
    else st.tasks[id] = { title: taskTitle(ev), status: "completed", ts: now };
    st.tasks_ts = now;
  } else if (name === "PostToolUse" && (ev.tool_name === "TaskUpdate") && ev.tool_input) {
    const id = String(ev.tool_input.taskId ?? "");
    const s = ev.tool_input.status;
    if (id && st.tasks[id] && ["pending", "in_progress", "completed", "deleted"].includes(s)) {
      st.tasks[id].status = s;
      st.tasks_ts = now;
    }
  }

  const win = now - GEIGER_WINDOW; // prune: closed spans out of window, orphaned open spans
  st.spans = st.spans.filter((s) => (s[1] === null ? s[0] >= now - MAX_RUN : s[1] >= win));
  st.squad = Object.fromEntries(Object.entries(st.squad).filter(([, v]) => now - v.start < MAX_RUN));
  // Tasks are never pruned here: the count (open/done/total) covers the whole session. Only the
  // task LIST hides once everything has settled; see TASK_LINGER in statusline's activityValues.
}

// One full event fold: activity + face expression + permission mode + git snapshot.
// This is exactly what hook.js's main() used to do per event — now applied at render time
// over the journal. A `git` event carries a precomputed snapshot in ev.git.
export function foldEvent(st, name, ev, now) {
  foldActivity(st, name, ev, now);
  const expr = expression(name, ev.tool_name || "");
  if (expr) { st.expr = expr; st.ts = now; }
  if (ev.permission_mode) st.mode = ev.permission_mode;
  if (name === "git" && ev.git) st.git = ev.git; // { br, lr, st, cwd } or { cwd } when no repo
  if (name === "msys" && ev.msys) st.msys = ev.msys; // { n } — live bash.exe count (win32 only)
}

// Fold a batch of journal lines (each { name, ev, ts }) into st. Sort by ts first: async
// hooks give no append-order guarantee, so SubagentStop can land before its Start. Sorting
// the batch keeps open/close and create/consume in causal order (within the batch).
export function foldBatch(st, lines) {
  const evs = [];
  for (const ln of lines) {
    if (!ln) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; } // torn/partial line -> skip
    if (!o || typeof o.ts !== "number" || typeof o.name !== "string") continue;
    evs.push(o);
  }
  evs.sort((a, b) => a.ts - b.ts);
  for (const o of evs) foldEvent(st, o.name, o.ev || {}, o.ts);
  return st;
}
