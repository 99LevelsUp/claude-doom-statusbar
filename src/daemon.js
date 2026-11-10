#!/usr/bin/env node
// Render daemon: one long-lived process per installation renders every active session and keeps
// each session's frame and the daemon heartbeat fresh. The bash statusLine client
// (doombar-client.sh) writes a session's payload file and prints the frame prepared here.
//
//   node src/daemon.js
//
// Single instance: the daemon binds the named pipe \\.\pipe\doombar-<install hash>. "Address in
// use" means a daemon for this installation already runs, and the new one exits at once without
// writing anything. The pipe answers nothing; hooks only probe whether it is bound.
//
// Every ~500 ms (jittered, so it does not lock phase with Claude Code's 1 s reads) one pass:
//   1. scan the temp dir for this installation's payload files, mugshot_payload_<hash>_<key>.json
//      (never another hash), and re-read those whose mtime or size changed. A payload that does
//      not parse (the client writes it non-atomically) is ignored and the last good one is kept;
//   2. render every active session through renderSession with its last good payload, its
//      forwarded environment over the daemon's own, and the pass's moment. The clock, the
//      marquee, the mugshot animation and the shared rate limits all change without a payload;
//   3. write each rendered session's frame: one slot starting now, deadline = now + its validity
//      window (forwarded DOOMBAR_FRAME_WINDOW seconds, default 3). A session whose render throws
//      keeps its previous frame unrenewed, so only that session greys;
//   4. write the heartbeat, mugshot_daemon_<hash>.json:
//      { pid, start, version, window, renewed, renameFailures }
//      start and renewed are epoch milliseconds, window is the largest window in use (seconds),
//      renameFailures counts frame and heartbeat writes that failed (retried on the next pass).
//
// A session is active from its first payload until its payload file disappears (SessionEnd
// deletes it) or it sends no new payload for DOOMBAR_DAEMON_IDLE_MS (default 10 minutes). When
// no session has been active for that long, the daemon deletes its heartbeat, closes the pipe
// and exits. It also exits when a file under its own src/ changes, appears or disappears (checked
// on the loop timer every ~2 s; no watcher, so no handle keeps the package directory from being
// moved or replaced), so the next hook starts the new code. It runs at below-normal priority from the temp dir (npm can replace the package
// meanwhile), and nothing in the loop waits on a child process: faces come from the .ans files
// until an asynchronous chafa warm-up lands (setFaceNoSpawn).

import { readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSession } from "./statusline.js";
import { writeFrame } from "./frame.js";
import { rootHash, sessionPaths, daemonPaths } from "./fold.js";
import { setFaceNoSpawn } from "./face.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.dirname(HERE);

const DEFAULT_WINDOW_S = 3;
const DEFAULT_IDLE_MS = 600000;
const TICK_MS = 500;
const JITTER_MS = 50;
const SRC_CHECK_MS = 2000;

const envNum = (v, dflt) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : dflt);
const windowOf = (env) => { const w = envNum(env.DOOMBAR_FRAME_WINDOW, DEFAULT_WINDOW_S); return w > 0 ? w : DEFAULT_WINDOW_S; };

export const pipePath = (hash) => `\\\\.\\pipe\\doombar-${hash}`;

// Payload file text -> { env, data } or null when it is not complete. Line 1 is "doombar-env"
// plus TAB-separated NAME=value items; the rest is the session JSON, which must be an object.
export function parsePayload(text) {
  const lf = text.indexOf("\n");
  if (lf < 0) return null;
  const [tag, ...items] = text.slice(0, lf).split("\t");
  if (tag !== "doombar-env") return null;
  let data;
  try { data = JSON.parse(text.slice(lf + 1)); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const env = {};
  for (const item of items) {
    const eq = item.indexOf("=");
    if (eq > 0) env[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return { env, data };
}

// The daemon's in-memory state. Nothing in it is needed across restarts: payloads are re-read
// and session state comes from each session's checkpoint and journal.
export function createState({ version, now = Date.now(), idleMs = DEFAULT_IDLE_MS, pid = process.pid,
  start = Math.round(performance.timeOrigin) } = {}) {
  return { version: String(version), idleMs, pid, start, since: now, sessions: new Map(), renameFailures: 0 };
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* never written, or already gone */ }
    return false;
  }
}

// One loop pass at `now` (epoch ms) over this installation's files in `dir`. Returns
// { idle, rendered }: idle is true once no session has been active for the idle period.
export function runPass(state, { dir = os.tmpdir(), hash = rootHash(), now = Date.now() } = {}) {
  const prefix = `mugshot_payload_${hash}_`;
  const name = /^([A-Za-z0-9_-]{1,48})\.json$/;
  let names = [];
  try { names = readdirSync(dir); } catch { /* temp dir unreadable: no sessions this pass */ }
  const present = new Set();
  for (const file of names) {
    if (!file.startsWith(prefix)) continue;
    const m = name.exec(file.slice(prefix.length));
    if (!m) continue;
    const key = m[1];
    present.add(key);
    const full = path.join(dir, file);
    let st;
    try { st = statSync(full); } catch { present.delete(key); continue; }
    const stamp = `${st.mtimeMs}:${st.size}`;
    const s = state.sessions.get(key);
    if (s && s.stamp === stamp) continue;
    let parsed = null;
    try { parsed = parsePayload(readFileSync(full, "utf8")); } catch { /* vanished or locked: retry next pass */ }
    if (!parsed) continue; // half-written: keep the last good payload, read again next pass
    state.sessions.set(key, { ...parsed, stamp, seenAt: now });
  }
  for (const key of [...state.sessions.keys()]) if (!present.has(key)) state.sessions.delete(key);

  const nowUs = Math.round(now * 1000);
  let window = 0;
  let rendered = 0;
  for (const [key, s] of state.sessions) {
    if (now - s.seenAt >= state.idleMs) continue;
    state.since = Math.max(state.since, s.seenAt);
    const env = { ...process.env, ...s.env };
    const w = windowOf(env);
    window = Math.max(window, w);
    let lines;
    try {
      lines = renderSession({ data: s.data, env, now: now / 1000 });
    } catch {
      continue; // this session's frame stays as it was and greys on its own deadline
    }
    const frame = path.join(dir, path.basename(sessionPaths(key, hash).frame));
    const deadline = nowUs + Math.round(w * 1e6);
    if (writeFrame(frame, { daemon: state.version, deadline, slots: [{ start: nowUs, lines }] })) rendered += 1;
    else state.renameFailures += 1;
  }

  const heartbeat = path.join(dir, path.basename(daemonPaths(hash).heartbeat));
  const beat = { pid: state.pid, start: state.start, version: state.version, window: window || DEFAULT_WINDOW_S,
    renewed: now, renameFailures: state.renameFailures };
  if (!writeAtomic(heartbeat, JSON.stringify(beat))) state.renameFailures += 1;

  return { idle: now - state.since >= state.idleMs, rendered };
}

// Names, sizes and modification times of the files in src/, as one comparable string.
function srcSnapshot(dir) {
  try {
    return readdirSync(dir).sort().map((f) => {
      try { const st = statSync(path.join(dir, f)); return `${f}:${st.size}:${st.mtimeMs}`; } catch { return `${f}:gone`; }
    }).join("\n");
  } catch { return "unreadable"; }
}

function packageVersion(root) {
  try {
    const v = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
    return /^\S+$/.test(String(v)) ? String(v) : "0";
  } catch { return "0"; }
}

// The real process. Resolves once the daemon has started serving, or exited because another
// daemon of this installation holds the pipe.
export function startDaemon({ root = PACKAGE_ROOT, env = process.env } = {}) {
  const hash = rootHash(root);
  const dir = os.tmpdir();
  const server = net.createServer((sock) => sock.end());
  let timer = null;
  let stopping = false;

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    try { unlinkSync(path.join(dir, path.basename(daemonPaths(hash).heartbeat))); } catch { /* not written yet */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };

  return new Promise((resolve) => {
    server.once("error", (err) => {
      // Another daemon of this installation already serves (or the pipe cannot be bound at all):
      // leave without touching anything.
      process.exit(err && err.code === "EADDRINUSE" ? 0 : 1);
    });
    server.listen(pipePath(hash), () => {
      try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted */ }
      try { process.chdir(dir); } catch { /* stay where we are */ }
      setFaceNoSpawn(true);

      const src = path.join(root, "src");
      const original = srcSnapshot(src);
      let srcChecked = Date.now();

      const state = createState({ version: packageVersion(root), idleMs: envNum(env.DOOMBAR_DAEMON_IDLE_MS, DEFAULT_IDLE_MS) });
      const tick = () => {
        const now = Date.now();
        if (now - srcChecked >= SRC_CHECK_MS) {
          srcChecked = now;
          if (srcSnapshot(src) !== original) { stop(); return; }
        }
        let idle = false;
        try {
          idle = runPass(state, { dir, hash, now }).idle;
        } catch { /* one bad pass never stops the loop */ }
        if (stopping) return;
        if (idle) { stop(); return; }
        timer = setTimeout(tick, TICK_MS - JITTER_MS + Math.random() * 2 * JITTER_MS);
      };
      tick();
      resolve();
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startDaemon();
}
