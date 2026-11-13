#!/usr/bin/env node
// End to end: a real render daemon, real hooks and the real bash client keep the promises the bar
// makes about liveness.
//
// Everything runs from a COPY of the package in a sandbox runtime dir, so the copy has its own
// install hash, address, heartbeat and claim and never meets the live bar of this machine. The
// client runs with the command shape the installer writes, through the shell Claude Code uses
// (Git Bash on Windows, /bin/sh on Linux), fed the same statusLine JSON on a ~1 s rhythm. The daemon is started by a SessionStart hook once the
// first tick has written the session's payload, and every later start or restart comes from a hook.
//
// To pause or hang the daemon, the copy's src/daemon.js is a thin shim: it runs the real daemon
// (the original file, renamed daemon-real.js) and, when a control file appears in its temp dir,
// blocks its own event loop with Atomics.wait for the number of milliseconds the file holds. So
// the "suspended" daemon is the real daemon with its loop stopped: the address stays bound, nothing is
// renewed, and its command line is this installation's src/daemon.js. The control file is consumed
// on read, so a replacement daemon never inherits a pause, and every pause is capped at 30 s.
//
// Resource discipline: at most one foreground child at a time (a client tick or a hook, never
// both), every child has a timeout and is killed as a tree, the daemons (detached by the hook) are
// found by command line and killed in `finally`, and a watchdog ends the run after 150 s.
//
// Windows and Linux. Not macOS: the process scan reads /proc.

import { spawn, spawnSync } from "node:child_process";
import { sandboxEnv } from "../_sandbox-env.mjs";
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync, symlinkSync, renameSync, readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
if (!WIN && process.platform !== "linux") {
  console.log("  skip: the process scan needs Windows or Linux /proc");
  console.log("\nALL PASS");
  process.exit(0);
}

const ROOT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..");
// The shell Claude Code runs the statusLine with, and (Linux) the bash 5 the command execs.
const SHELL = WIN ? (process.env.DOOMBAR_TEST_BASH || "C:/Program Files/Git/bin/bash.exe") : "/bin/sh";
const POSIX_BASH = WIN ? null : (process.env.DOOMBAR_TEST_BASH || "/bin/bash");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T_START = Date.now();
const at = () => `${((Date.now() - T_START) / 1000).toFixed(1)}s`;

const { sessionPaths, daemonPaths, rootHash, daemonSocket } = await import("../../src/fold.js");
const { OFFLINE_MARKER } = await import("../../src/platform/frame.js");

const THROTTLE = 1000;
const GRACE = 2000;
const WINDOW = 3000; // the default validity window: DOOMBAR_FRAME_WINDOW is never set here
const IDLE_MS = 180000; // backstop: a daemon that escaped cleanup still exits on its own
const IDLE_RUN_MS = 60000; // how long the idle session is watched
const SID = "e2e-session";
const CAP = 64 * 1024; // bytes of client output kept per tick

const SB = mkdtempSync(path.join(os.tmpdir(), "doombar-e2e-"));
const SB_NORM = SB.replace(/\\/g, "/").toLowerCase();
const PKG = path.join(SB, "pkg");
const TMP = path.join(SB, "tmp");

// ---- Child tracking, cleanup and the watchdog ------------------------------------------------

const live = new Set();
let peakForeground = 0;
const killTree = (pid) => {
  if (!WIN) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } return; }
  try { spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: 10000, windowsHide: true, stdio: "ignore" }); } catch { /* gone */ }
};

// Every node and bash (sh) process whose command line points into the sandbox, either slash
// spelling: the daemons, the hooks and the client ticks of this run. Names come without ".exe".
function sandboxProcesses() {
  if (!WIN) {
    const found = [];
    let pids = [];
    try { pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n)); } catch { /* none */ }
    for (const p of pids) {
      let argv;
      try { argv = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { continue; }
      const cmd = argv.join(" ");
      if (Number(p) !== process.pid && cmd.toLowerCase().includes(SB_NORM)) {
        found.push({ pid: Number(p), name: path.basename(argv[0] || ""), cmd });
      }
    }
    return found;
  }
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='bash.exe'\" | Where-Object { $_.CommandLine -and " +
    "$_.CommandLine.Replace('\\','/').ToLower().Contains($env:DOOMBAR_TEST_SB) } | " +
    "ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.Name, $_.CommandLine }"],
  { encoding: "utf8", timeout: 20000, windowsHide: true, maxBuffer: 1 << 20, env: { ...process.env, DOOMBAR_TEST_SB: SB_NORM } });
  return String(r.stdout || "").split(/\r?\n/).map((l) => /^(\d+)\|([^|]*)\|(.*)$/.exec(l.trim())).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), name: m[2].toLowerCase().replace(/\.exe$/, ""), cmd: m[3] }));
}

let cleaned = false;
function cleanup() {
  if (cleaned) return [];
  cleaned = true;
  for (const c of live) killTree(c.pid);
  for (const p of sandboxProcesses()) killTree(p.pid);
  const left = sandboxProcesses();
  for (let i = 0; i < 20; i++) {
    try { rmSync(SB, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); }
  }
  return left;
}

function emergency(why) {
  console.log(`  FAIL ${why}`);
  try { cleanup(); } catch { /* best effort */ }
  console.log("\n1 FAILED (aborted)");
  process.exit(1);
}
const watchdog = setTimeout(() => emergency("watchdog: the run took longer than 150 s"), 150000);
process.on("uncaughtException", (e) => emergency(`uncaught: ${e && e.stack || e}`));
process.on("unhandledRejection", (e) => emergency(`unhandled rejection: ${e && e.stack || e}`));

// One child, at most one foreground child at a time (the caller holds the lock). Resolves with
// { code, out, timedOut }; stdout is captured up to CAP bytes only when asked.
function runChild(file, args, { env, input = "", timeoutMs, capture = false }) {
  return new Promise((resolve) => {
    let c;
    try {
      c = spawn(file, args, { env, stdio: ["pipe", capture ? "pipe" : "ignore", "ignore"], windowsHide: true });
    } catch (e) { resolve({ code: -1, out: "", timedOut: false, err: String(e) }); return; }
    live.add(c);
    peakForeground = Math.max(peakForeground, live.size);
    let out = "", size = 0, timedOut = false, done = false;
    if (capture) c.stdout.on("data", (d) => { if (size < CAP) out += d.toString("utf8", 0, Math.min(d.length, CAP - size)); size += d.length; });
    const timer = setTimeout(() => { timedOut = true; killTree(c.pid); }, timeoutMs);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      live.delete(c);
      resolve({ code, out, timedOut });
    };
    c.on("error", () => finish(-1));
    c.on("close", (code) => finish(code));
    c.stdin.on("error", () => { /* the child left early */ });
    c.stdin.end(input);
  });
}

// One foreground child at a time: a client tick and a hook never overlap.
let lock = Promise.resolve();
function exclusive(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

// ---- The sandboxed installation --------------------------------------------------------------

const SHIM = `
import { readFileSync, unlinkSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "./daemon-real.js";
const ctl = path.join(os.tmpdir(), "e2e-daemon-pause");
const log = path.join(os.tmpdir(), "e2e-daemon-pause.log");
const cell = new Int32Array(new SharedArrayBuffer(4));
function poll() {
  let ms;
  try { ms = Number(readFileSync(ctl, "utf8")); unlinkSync(ctl); } catch { return; }
  if (!(ms > 0)) return;
  const t0 = Date.now();
  Atomics.wait(cell, 0, 0, Math.min(ms, 30000));
  try { appendFileSync(log, process.pid + " " + t0 + " " + Date.now() + "\\n"); } catch { /* best effort */ }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  setInterval(poll, 100).unref();
  startDaemon();
}
`;

mkdirSync(PKG);
mkdirSync(TMP);
cpSync(path.join(ROOT, "src"), path.join(PKG, "src"), { recursive: true });
cpSync(path.join(ROOT, "presets"), path.join(PKG, "presets"), { recursive: true });
cpSync(path.join(ROOT, "package.json"), path.join(PKG, "package.json"));
symlinkSync(path.join(ROOT, "assets"), path.join(PKG, "assets"), "junction");
symlinkSync(path.join(ROOT, "node_modules"), path.join(PKG, "node_modules"), "junction");
renameSync(path.join(PKG, "src", "daemon.js"), path.join(PKG, "src", "daemon-real.js"));
writeFileSync(path.join(PKG, "src", "daemon.js"), SHIM);

const HASH = rootHash(PKG);
const inTmp = (p) => path.join(TMP, path.basename(p));
const HEARTBEAT = inTmp(daemonPaths(HASH).heartbeat);
const CLAIM = inTmp(daemonPaths(HASH).claim);
const PAYLOAD = inTmp(sessionPaths(SID, HASH).payload);
const PAUSE = path.join(TMP, "e2e-daemon-pause");
const PAUSE_LOG = path.join(TMP, "e2e-daemon-pause.log");

// The statusLine command exactly as the installer writes it (WIN_CLIENT_CMD and posixClientCmd
// in bin/cli.js): sourced into Git Bash on Windows, exec'd bash with the hash elsewhere.
const CLIENT = path.join(PKG, "src", "doombar-client.sh").replace(/\\/g, "/");
const CLIENT_CMD = WIN
  ? `DOOMBAR_ROOT_HASH=${HASH}; f="${CLIENT}"; if [ -r "$f" ]; then . "$f"; else echo 'doombar: offline'; fi`
  : `b='${POSIX_BASH}'; f='${CLIENT}'; if [ -r "$f" ] && [ -x "$b" ]; then unset BASH_ENV; ` +
    `exec "$b" --norc --noprofile "$f" ${HASH}; else echo 'doombar: offline'; fi`;
const SOCKET = daemonSocket(HASH, { DOOMBAR_RUNTIME_DIR: TMP });

// The developer's own bar settings must not leak in: they would reach the daemon through the
// payload line (client) or the inherited environment (hook), and change every timing below.
const scrubbed = { ...process.env };
for (const k of Object.keys(scrubbed)) {
  if (/^(DOOMBAR_|MUGSHOT_)/i.test(k) || /^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_TASK_LIST_ID|COLUMNS)$/i.test(k)) delete scrubbed[k];
}
const baseEnv = { ...scrubbed, ...sandboxEnv(TMP), DOOMBAR_MSYS_REAP: "0", DOOMBAR_JOURNAL_TTL: "off" };
const hookEnv = { ...baseEnv, DOOMBAR_DAEMON_THROTTLE_MS: String(THROTTLE), DOOMBAR_DAEMON_GRACE_MS: String(GRACE),
  DOOMBAR_DAEMON_IDLE_MS: String(IDLE_MS),
  // The hung-daemon case must restart it whatever else keeps this machine busy meanwhile.
  DOOMBAR_BUSY_IDLE_PCT: "0" };
const clientEnv = { ...baseEnv, COLUMNS: "120" };

// A realistic statusLine payload, the same on every tick: an idle session.
const STATUSLINE_JSON = JSON.stringify({
  hook_event_name: "Status",
  session_id: SID,
  transcript_path: path.join(SB, "transcript.jsonl"),
  cwd: SB,
  model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
  workspace: { current_dir: SB, project_dir: SB },
  version: "2.1.0",
  output_style: { name: "default" },
  cost: { total_cost_usd: 0.42, total_duration_ms: 120000, total_api_duration_ms: 30000, total_lines_added: 12, total_lines_removed: 3 },
  context_window: { used_percentage: 42, context_window_size: 200000 },
});

const kindOf = (out) => {
  if (out.includes(OFFLINE_MARKER)) return "grey";
  if (out === "doombar: offline\n") return "offline";
  if (out.trim() === "") return "empty";
  return "live";
};

// ---- The client on a 1 s rhythm ------------------------------------------------------------

const ticks = []; // { t0, t1, kind }
let ticking = false;
let tickLoop = null;
const tickOnce = () => exclusive(async () => {
  const t0 = Date.now();
  const r = await runChild(SHELL, ["-c", CLIENT_CMD], { env: clientEnv, input: STATUSLINE_JSON, timeoutMs: 5000, capture: true });
  const tick = { t0, t1: Date.now(), kind: r.timedOut ? "timeout" : kindOf(r.out) };
  // A grey tick: was the daemon late (old heartbeat), or did the client see an old frame?
  if (tick.kind === "grey") tick.hbAge = tick.t1 - (readJson(HEARTBEAT)?.renewed ?? NaN);
  ticks.push(tick);
  return tick;
});
function startTicker() {
  ticking = true;
  tickLoop = (async () => {
    while (ticking) {
      const t0 = Date.now();
      await tickOnce();
      const wait = 1000 - (Date.now() - t0);
      if (wait > 0 && ticking) await sleep(wait);
    }
  })();
}
async function stopTicker() { ticking = false; if (tickLoop) await tickLoop; }

const hook = (name) => exclusive(async () => {
  const r = await runChild(process.execPath, [path.join(PKG, "src", "hook.js")],
    { env: hookEnv, input: JSON.stringify({ hook_event_name: name, session_id: SID, tool_name: "Read" }), timeoutMs: 20000 });
  return { ...r, end: Date.now() };
});

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (cond, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (cond()) return true;
  return cond();
};
const sleepUntil = (t) => sleep(Math.max(0, t - Date.now()));
const ticksFrom = (from, to = Infinity) => ticks.filter((t) => t.t0 >= from && t.t0 < to);
const summary = (list) => list.map((t) => t.kind[0]).join("");
const firstLiveAfter = (from, ms) => waitFor(() => ticksFrom(from).some((t) => t.kind === "live"), ms);
const scans = [];
const scan = (label) => {
  const procs = sandboxProcesses();
  scans.push(`${label}: ${procs.length} (${procs.map((p) => p.name.replace(".exe", "")).join(",")})`);
  return procs;
};

let left = [];
try {
  // ---- Start: the first tick writes the payload, then SessionStart starts the daemon ---------
  {
    const first = await tickOnce();
    ok(first.kind === "offline", `with no daemon yet the first tick prints the built-in offline line (got ${first.kind})`);
    ok(existsSync(PAYLOAD), "the first tick wrote this session's payload under the copy's install hash");
    startTicker();
    const r = await hook("SessionStart");
    ok(r.code === 0, "the SessionStart hook exits 0");
    ok(await waitFor(() => Number.isInteger(readJson(HEARTBEAT)?.pid), 10000), "the SessionStart hook started a daemon that writes its heartbeat");
    ok(await firstLiveAfter(r.end, 10000), `the client turns live (${at()})`);
    const procs = scan("after start");
    ok(procs.filter((p) => p.name === "node" && p.cmd.includes("daemon.js")).length === 1, "exactly one daemon runs");
  }

  // ---- An idle session stays live (payload unchanged on every tick) --------------------------
  {
    const from = Date.now();
    await sleep(IDLE_RUN_MS);
    const seen = ticksFrom(from, Date.now());
    ok(seen.length >= IDLE_RUN_MS / 1000 - 6 && seen.every((t) => t.kind === "live"),
      `an idle session stays live for ${IDLE_RUN_MS / 1000} s: ${seen.length} ticks, ${seen.filter((t) => t.kind !== "live").length} not live ` +
      `(${seen.filter((t) => t.kind !== "live").map((t) => `${t.kind} at +${t.t0 - from} ms, tick ${t.t1 - t.t0} ms, heartbeat ${t.hbAge} ms old`).join(", ")})`);
  }

  // ---- A daemon starved for 2 s never greys ----------------------------------------------------
  {
    const from = Date.now();
    let prev = readJson(HEARTBEAT)?.renewed;
    let gap = 0;
    writeFileSync(PAUSE, "2000");
    for (const end = Date.now() + 6000; Date.now() < end; await sleep(100)) {
      const r = readJson(HEARTBEAT)?.renewed;
      if (Number.isFinite(r) && Number.isFinite(prev) && r !== prev) { gap = Math.max(gap, r - prev); prev = r; }
      else if (Number.isFinite(r) && !Number.isFinite(prev)) prev = r;
    }
    const paused = String(existsSync(PAUSE_LOG) ? readFileSync(PAUSE_LOG, "utf8") : "").trim().split("\n")
      .map((l) => l.split(" ").map(Number)).filter((p) => p.length === 3 && p[2] - p[1] >= 1900);
    ok(paused.length === 1, `the daemon's loop was blocked for about 2 s (${paused.map((p) => p[2] - p[1]).join(",")} ms)`);
    ok(gap >= 1900, `the heartbeat stopped renewing meanwhile (largest gap ${gap} ms)`);
    const seen = ticksFrom(from, Date.now());
    ok(seen.length >= 4 && seen.every((t) => t.kind === "live"), `the output never greys during the pause (${summary(seen)})`);
  }

  // ---- Killing the daemon greys the output within 4 s ------------------------------------------
  let killedAt;
  {
    const hb = readJson(HEARTBEAT);
    killTree(hb.pid);
    killedAt = Date.now();
    ok(await waitFor(() => !alive(hb.pid), 3000), "the daemon is killed");
    // Linux: a daemon killed outright leaves its socket file; the Stop hook below starts one that
    // takes it over.
    if (!WIN) ok(existsSync(SOCKET), "the killed daemon left its socket file behind");
    await sleepUntil(killedAt + 5500);
    const early = ticksFrom(killedAt, killedAt + 2000);
    ok(early.length >= 1 && early.every((t) => t.kind === "live"), `ticks within 2 s of the kill still show the last live frame (${summary(early)})`);
    const after = ticksFrom(killedAt);
    const grey = after.find((t) => t.kind === "grey");
    ok(grey && grey.t0 - killedAt <= 4000, `the greyed OFFLINE copy shows within 4 s (first grey tick at +${grey ? grey.t0 - killedAt : "never"} ms)`);
    ok(grey && after.filter((t) => t.t0 >= grey.t0).every((t) => t.kind === "grey"), `and stays grey (${summary(after)})`);
  }

  // ---- A Stop hook brings the output back within two ticks --------------------------------------
  {
    const r = await hook("Stop");
    ok(r.code === 0, "the Stop hook exits 0");
    ok(await waitFor(() => ticksFrom(r.end).length >= 2, 6000), "two ticks run after the Stop hook");
    const two = ticksFrom(r.end).slice(0, 2);
    ok(two.length === 2 && two[1].kind === "live", `the output is live again within two ticks (${summary(two)})`);
    const procs = scan("after Stop restart");
    ok(procs.filter((p) => p.name === "node" && p.cmd.includes("daemon.js")).length === 1, "exactly one daemon runs");
  }

  // ---- A hung daemon is sighted, then replaced after the grace period ---------------------------
  {
    const hb0 = readJson(HEARTBEAT);
    writeFileSync(PAUSE, "30000");
    // Renewals have stopped once the heartbeat stays the same for 700 ms.
    let last = readJson(HEARTBEAT)?.renewed, since = Date.now();
    for (const end = Date.now() + 5000; Date.now() < end && Date.now() - since < 700; await sleep(100)) {
      const r = readJson(HEARTBEAT)?.renewed;
      if (r !== last) { last = r; since = Date.now(); }
    }
    const hung = readJson(HEARTBEAT);
    ok(hung && hung.pid === hb0.pid && Date.now() - since >= 700, "the daemon has stopped renewing");
    const suspectAt = hung.renewed + WINDOW + THROTTLE;

    await sleepUntil(hung.renewed + 1500);
    const h1 = await hook("PostToolUse");
    const early = readJson(CLAIM)?.suspectSince;
    ok(h1.code === 0 && h1.end < suspectAt && !Number.isFinite(early),
      `a hook before window plus throttle records nothing (ended ${h1.end - suspectAt} ms from the threshold, sighting ${early})`);

    await sleepUntil(suspectAt + 300);
    const h2 = await hook("PostToolUse");
    const sighting = readJson(CLAIM)?.suspectSince;
    ok(h2.code === 0 && Number.isFinite(sighting) && sighting >= suspectAt, "the first hook after window plus throttle records the daemon as suspect");
    ok(alive(hung.pid) && readJson(HEARTBEAT)?.pid === hung.pid, "and neither stops nor replaces it");

    const h3 = await hook("PostToolUse");
    ok(h3.code === 0 && readJson(CLAIM)?.suspectSince === sighting && alive(hung.pid), "a hook inside the grace period does nothing");

    // Checked once the grace period has run out: up to h3 the span can be shorter than one tick.
    await sleepUntil(sighting + GRACE + 200);
    const greyed = ticksFrom(hung.renewed + WINDOW + 1000, Date.now());
    ok(greyed.length >= 1 && greyed.every((t) => t.kind === "grey"), `meanwhile the output is grey (${summary(greyed)})`);
    const h4 = await hook("PostToolUse");
    ok(h4.code === 0, "the hook after the grace period exits 0");
    ok(await waitFor(() => !alive(hung.pid), 5000), "the hung daemon is stopped");
    ok(await waitFor(() => { const p = readJson(HEARTBEAT)?.pid; return Number.isInteger(p) && p !== hung.pid && alive(p); }, 8000),
      "a new daemon serves the heartbeat");
    ok(await firstLiveAfter(h4.end, 6000), `the output is live again (${summary(ticksFrom(h4.end))})`);
    const procs = scan("after hung restart");
    ok(procs.filter((p) => p.name === "node" && p.cmd.includes("daemon.js")).length === 1, "exactly one daemon runs");
  }

  await stopTicker();
  ok(ticks.every((t) => t.kind !== "timeout" && t.kind !== "empty"), "no client tick timed out or printed nothing");
} finally {
  ticking = false;
  clearTimeout(watchdog);
  left = cleanup();
}
ok(left.length === 0, `no daemon, hook or client process is left running (${left.map((p) => `${p.pid}:${p.name}`).join(",")})`);
console.log(`  info ${ticks.length} ticks; at most ${peakForeground} foreground child at a time; sandbox processes: ${scans.join("; ")}; ${at()}`);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
