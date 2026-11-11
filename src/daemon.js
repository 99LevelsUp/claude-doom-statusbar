#!/usr/bin/env node
// Render daemon: one long-lived process per installation renders every active session.
//
// Single instance: the daemon binds the named pipe \\.\pipe\doombar-<install hash>. "Address in
// use" means a daemon for this installation already runs, and the new one exits at once without
// writing anything. The pipe answers nothing; hooks only probe whether it is bound.
//
// Heartbeat, mugshot_daemon_<hash>.json: { pid, start, version, window, renewed, renameFailures }
// start and renewed are epoch milliseconds, window is the largest window in use (seconds),
// renameFailures counts frame and heartbeat writes that failed.

import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSession } from "./statusline.js";
import { writeFrame } from "./frame.js";
import {
  rootHash, daemonPaths, payloadPrefix, framePrefix, writeAtomic, pipePath, PACKAGE_ROOT, envNum, packageVersion,
  runtimeDir, ensureRuntimeDir,
} from "./fold.js";

export { pipePath };

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_WINDOW_S = 3;
const DEFAULT_IDLE_MS = 600000;
const TICK_MS = 500;
const JITTER_MS = 50;
const SRC_CHECK_MS = 2000;

// The variables the client forwards in the payload, as listed in src/doombar-client.sh. A session
// that leaves one unset gets it unset, never the value in the daemon's own environment (which is
// the environment of whichever session's hook started the daemon).
export const FORWARDED_ENV = [
  "COLUMNS", "DOOMBAR_PRESET", "DOOMBAR_THEME", "DOOMBAR_TEXT_OVERFLOW", "DOOMBAR_INDENT", "DOOMBAR_FRAME_WINDOW",
  "MUGSHOT_STATE", "CLAUDE_CODE_TASK_LIST_ID", "CLAUDE_CONFIG_DIR",
  "WT_SESSION", "TERM_PROGRAM", "TMUX", "DOOMBAR_GLYPHS",
];
const sessionEnv = (forwarded) => {
  const env = { ...process.env };
  for (const name of FORWARDED_ENV) delete env[name];
  return Object.assign(env, forwarded);
};
const windowOf = (env) => { const w = envNum(env.DOOMBAR_FRAME_WINDOW, DEFAULT_WINDOW_S); return w > 0 ? w : DEFAULT_WINDOW_S; };
const inDir = (dir, file) => path.join(dir, path.basename(file));

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

// Hung Git Bash statusLine wrappers must be reaped even while no hook events arrive: at most one
// detached `node src/hook.js --reap` per DOOMBAR_REAP_TICK, never awaited. Returns whether a
// reaper was started.
const DEFAULT_REAP_TICK_MS = 15000;
const REAPER_MAX_MS = 30000; // a healthy reaper takes about 1 s
const HOOK_JS = path.join(HERE, "hook.js");
export function maybeStartReaper(state, { now = Date.now(), env = process.env, platform = process.platform,
  spawn = spawnChild } = {}) {
  if (platform !== "win32" || env.DOOMBAR_MSYS_REAP === "0") return false;
  const tick = envNum(env.DOOMBAR_REAP_TICK, DEFAULT_REAP_TICK_MS);
  if (state.reapedAt !== undefined && now - state.reapedAt < tick) return false;
  // A reaper that has not exited yet blocks the next one: reapers have been seen to hang, and a
  // long-lived daemon starting one per interval would pile them up until memory runs out. One
  // that has run for longer than REAPER_MAX_MS is killed, so a hang never stops reaping for good.
  const prev = state.reaper;
  if (prev && prev.exitCode === null && prev.signalCode === null) {
    if (now - state.reaperStartedAt <= REAPER_MAX_MS) return false;
    try { prev.kill(); } catch {}
    state.reaper = undefined;
  }
  state.reapedAt = now;
  state.reaperStartedAt = now;
  try {
    const child = spawn(process.execPath, [HOOK_JS, "--reap"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    state.reaper = child;
  } catch {}
  return true;
}

// Returns { idle, rendered }: idle is true once no session has been active for the idle period.
export function runPass(state, { dir = runtimeDir(), hash = rootHash(), now = Date.now(),
  heartbeat = inDir(dir, daemonPaths(hash).heartbeat) } = {}) {
  const prefix = payloadPrefix(hash);
  const name = /^([A-Za-z0-9_-]{1,48})\.json$/;
  let names = [];
  try { names = readdirSync(dir); } catch {}
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
    try { parsed = parsePayload(readFileSync(full, "utf8")); } catch {}
    if (!parsed) continue; // half-written by the client: keep the last good payload
    const env = sessionEnv(parsed.env);
    // Liveness is when the client last wrote the payload, so a payload left by a session that
    // ended without SessionEnd is never rendered after a daemon start and never keeps it alive.
    state.sessions.set(key, {
      data: parsed.data, env, window: windowOf(env), stamp, seenAt: Math.min(now, st.mtimeMs),
      frame: s ? s.frame : path.join(dir, `${framePrefix(hash)}${key}.json`),
    });
  }
  for (const key of [...state.sessions.keys()]) if (!present.has(key)) state.sessions.delete(key);

  const nowUs = Math.round(now * 1000);
  let window = 0;
  let rendered = 0;
  for (const s of state.sessions.values()) {
    if (now - s.seenAt >= state.idleMs) continue;
    state.since = Math.max(state.since, s.seenAt);
    window = Math.max(window, s.window);
    let lines;
    try {
      lines = renderSession({ data: s.data, env: s.env, now: now / 1000 });
    } catch {
      continue; // this session's frame stays as it was and greys on its own deadline
    }
    const deadline = nowUs + Math.round(s.window * 1e6);
    if (writeFrame(s.frame, { daemon: state.version, deadline, slots: [{ start: nowUs, lines }] })) rendered += 1;
    else state.renameFailures += 1;
  }

  const beat = { pid: state.pid, start: state.start, version: state.version, window: window || DEFAULT_WINDOW_S,
    renewed: now, renameFailures: state.renameFailures };
  try { writeAtomic(heartbeat, JSON.stringify(beat)); } catch { state.renameFailures += 1; }

  return { idle: now - state.since >= state.idleMs, rendered };
}

function srcSnapshot(dir) {
  try {
    return readdirSync(dir).sort().map((f) => {
      try { const st = statSync(path.join(dir, f)); return `${f}:${st.size}:${st.mtimeMs}`; } catch { return `${f}:gone`; }
    }).join("\n");
  } catch { return "unreadable"; }
}

// Resolves once the daemon serves. Exits at once when another daemon of this installation
// already holds the pipe.
export function startDaemon({ root = PACKAGE_ROOT, env = process.env } = {}) {
  const hash = rootHash(root);
  const dir = ensureRuntimeDir(env);
  if (!dir) process.exit(1); // not private: never read or write in it
  const heartbeat = inDir(dir, daemonPaths(hash).heartbeat);
  const server = net.createServer((sock) => sock.end());
  let timer = null;
  let stopping = false;

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    try { unlinkSync(heartbeat); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };

  return new Promise((resolve) => {
    server.once("error", (err) => {
      process.exit(err && err.code === "EADDRINUSE" ? 0 : 1);
    });
    server.listen(pipePath(hash), () => {
      try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
      try { process.chdir(dir); } catch {}

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
        maybeStartReaper(state, { now, env });
        let idle = false;
        try {
          idle = runPass(state, { dir, hash, now, heartbeat }).idle;
        } catch {}
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
