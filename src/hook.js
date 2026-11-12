#!/usr/bin/env node
// Claude Code hook: an APPEND-ONLY event recorder for the DOOM HUD.
//
// Old design did read-modify-write on a shared state file per event; under async hooks that
// races (lost subagents/tasks). Now each invocation just APPENDS one slim line to a
// per-session journal — append is atomic, so concurrent async hooks never clobber each
// other. statusline.js folds the journal into a checkpoint at render time (see fold.js).
//
// Because the heavy work (folding, git) is off the blocking path, install these hooks with
// "async": true (see bin/cli.js). This hook never reads the journal and always exits 0.
//
// Extra job: git lives here now, not on the render hot path. On write-affecting events (and
// once per turn on Stop, and at SessionStart) we snapshot git into a `git` journal line,
// throttled by DOOMBAR_GIT_TTL. statusline no longer spawns git at all, so the render process
// itself has no children -> it cannot feed the Windows MSYS "bash flood" from below.
//
// It can still be fed from ABOVE, by the shell Claude Code wraps our render command in. That is
// what reapStaleShells() below cleans up.
//
// Journal: <checkpoint>.jsonl where checkpoint is $MUGSHOT_STATE or <runtime dir>/mugshot_<sid>.json (runtimeDir in fold.js).

import {
  appendFileSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, existsSync,
  openSync, writeSync, closeSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
  base, statePaths, sessionPaths, daemonPaths, rootHash, sidKey, daemonSocket, procStartTicks, addressBound, PACKAGE_ROOT,
  ROOT_HASH_LEN, WRITE_TOOLS,
  writeAtomic, envNum, packageVersion as readPackageVersion, runtimeDir, ensureRuntimeDir,
} from "./fold.js";

// Re-export the reducer so existing tests importing from hook.js keep working.
export { foldActivity, expression } from "./fold.js";

const GIT_TTL = Number.isFinite(Number(process.env.DOOMBAR_GIT_TTL))
  ? Number(process.env.DOOMBAR_GIT_TTL)
  : 4000; // ms; DOOMBAR_GIT_TTL=0 disables throttling (0 is a valid TTL)

// The bash count is a VOLATILE signal (unlike git, which only changes on writes), so it can't
// ride git's write-gated cadence — a captured spike would stick on the HUD until the next write
// tool ran. It gets its own time-based gate that fires on ANY event, so the gauge tracks reality
// within MSYS_TTL regardless of which tools run. DOOMBAR_MSYS_TTL=0 disables throttling.
const MSYS_TTL = Number.isFinite(Number(process.env.DOOMBAR_MSYS_TTL))
  ? Number(process.env.DOOMBAR_MSYS_TTL)
  : 4000; // ms

// Project an event down to only the fields fold.js consumes. Keeps journal lines tiny and
// bounded — a raw Write/Edit event carries the whole file body in tool_input, which would
// bloat the journal and stress append atomicity. We never journal that.
function slim(ev) {
  const ti = ev.tool_input || {};
  const tn = ev.tool_name;
  let tool_input;
  if (tn === "TaskUpdate") tool_input = { taskId: ti.taskId, status: ti.status };
  else if (tn === "Agent") tool_input = { subagent_type: ti.subagent_type, description: ti.description };
  else if (ti.subject) tool_input = { subject: ti.subject };
  return {
    tool_name: tn,
    tool_input,
    agent_id: ev.agent_id,
    agent_type: ev.agent_type,
    task_id: ev.task_id,
    task_title: ev.task_title, task_subject: ev.task_subject, subject: ev.subject, title: ev.title,
    permission_mode: ev.permission_mode,
  };
}

function gitCmd(cwd, ...args) {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1000 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch { return null; }
}

function gitSnapshot(cwd) {
  return {
    cwd,
    br: gitCmd(cwd, "branch", "--show-current"),
    lr: gitCmd(cwd, "rev-list", "--count", "--left-right", "@{u}...HEAD"),
    st: gitCmd(cwd, "status", "--porcelain"),
  };
}

// Windows MSYS "bash flood" pressure gauge. Git Bash backs every shell-form hook AND the Bash
// tool AND — unavoidably — our own statusLine command, so when too many bash.exe inits collide
// the shared MSYS section corrupts ("add_item errno 1"). We surface the pressure so the HUD
// warns before it bites, and reapStaleShells() below defuses our own share of it.
// Counted via tasklist — a direct exe, never through bash, which would feed the very flood we
// measure. Non-win32 / failure -> null, so the HUD field simply never shows.
function bashCount() {
  if (process.platform !== "win32") return null;
  try {
    const r = spawnSync("tasklist", ["/fi", "imagename eq bash.exe", "/fo", "csv", "/nh"],
      { encoding: "utf8", timeout: 1000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return 0; // no match -> tasklist prints an INFO line, not a row
    return r.stdout.split("\n").filter((l) => l.toLowerCase().includes("bash.exe")).length;
  } catch { return null; }
}

// --- Windows MSYS bash-flood reaper --------------------------------------------------------
// statusLine has NO exec form — its whole schema is type/command/padding/refreshInterval — so
// Claude Code runs our render command through a shell, and on Windows that shell is Git Bash
// whenever Git for Windows is installed. CLAUDE_CODE_GIT_BASH_PATH, CLAUDE_CODE_USE_POWERSHELL_TOOL
// and defaultShell do NOT redirect it (verified: with both env vars set, renders still came from
// C:\Program Files\Git\bin\bash.exe). Each render therefore costs TWO MSYS inits, because
// Git\bin\bash.exe is only a stub that re-execs Git\usr\bin\bash.exe.
//
// Those wrappers are the flood, and the failure is self-sustaining: a healthy `bash -c` returns
// in ~0.3 s, a poisoned one hangs ~15 s before dying with 0xC0000005. So the wrapper population
// never drops to zero, the shared section never gets an instant with no holder, and it cannot
// heal itself. Killing the accumulated wrappers heals it at once — measured on Win11 26200:
// 15233 ms + 0xC0000005 before, 277 ms + exit 0 immediately after. That is what we automate.
const REAP_ON = process.env.DOOMBAR_MSYS_REAP !== "0";
const REAP_MIN = envNum(process.env.DOOMBAR_MSYS_REAP_MIN, 4); // only act once a pile is forming
const REAP_AGE = envNum(process.env.DOOMBAR_MSYS_REAP_AGE, 10000); // ms; a healthy render ~300 ms

// Pure decision half, exported so it can be tested without touching real processes.
// `procs` is [{ pid, ageMs, cmd }] as produced by listBashShells().
export function stalePids(procs, ageMs = REAP_AGE) {
  return (procs || [])
    .filter((p) => p && Number.isInteger(p.pid) && p.pid > 0)
    .filter((p) => /statusline\.js|doombar-client\.sh/i.test(String(p.cmd || "")))
    .filter((p) => Number.isFinite(p.ageMs) && p.ageMs >= ageMs)
    .map((p) => p.pid);
}

// The enumerator: bash.exe with age + command line. tasklist cannot show a command line and wmic
// is gone from current Windows builds, so this goes through PowerShell — a direct exe, not a
// shell wrapper, so it never adds to the MSYS flood. Only ever called once a pile is measured.
// Exported so the exact script that ships can be exercised, rather than a copy of it.
export const LIST_SHELLS_PS =
  "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | " +
  "Where-Object { $_.CreationDate } | ForEach-Object { " +
  "'{0}|{1}|{2}' -f $_.ProcessId, " +
  "[int]((Get-Date) - $_.CreationDate).TotalMilliseconds, $_.CommandLine }";

// Pure parse half. A command line can itself contain "|" (it usually does — `bash -c "node ..."`
// with a piped inner command), so only the FIRST TWO separators are structural.
export function parseBashShells(stdout) {
  return String(stdout || "").split(/\r?\n/)
    .map((l) => /^(\d+)\|(-?\d+)\|(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ageMs: Number(m[2]), cmd: m[3] }));
}

export function listBashShells() {
  try {
    const r = spawnSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", LIST_SHELLS_PS],
      { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return [];
    return parseBashShells(r.stdout);
  } catch { return []; }
}

// Kill via taskkill: a direct exe that always exists, so the cure never spawns a shell.
// Returns how many PIDs we asked to die (best effort — a PID that exited on its own is fine).
export function reapStaleShells() {
  if (process.platform !== "win32" || !REAP_ON) return 0;
  const pids = stalePids(listBashShells());
  if (pids.length === 0) return 0;
  try {
    const args = pids.flatMap((pid) => ["/PID", String(pid)]);
    spawnSync("taskkill", ["/F", ...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
  } catch { return 0; }
  return pids.length;
}

// --- Render daemon supervision ----------------------------------------------------------------
const DAEMON_JS = path.join(PACKAGE_ROOT, "src", "daemon.js");
const DAEMON_THROTTLE_MS = envNum(process.env.DOOMBAR_DAEMON_THROTTLE_MS, 15000);
const DAEMON_GRACE_MS = envNum(process.env.DOOMBAR_DAEMON_GRACE_MS, 20000);
const PAYLOAD_WAIT_MS = envNum(process.env.DOOMBAR_PAYLOAD_WAIT_MS, 10000);
const PAYLOAD_POLL_MS = 200;
const BUSY_IDLE_PCT = envNum(process.env.DOOMBAR_BUSY_IDLE_PCT, 10);
const BUSY_SAMPLE_MS = 250;
const PROBE_MS = 150;
const LOCK_STALE_MS = 2000; // a lock holder does a few file operations; older means it died
const START_SLACK_MS = 2000; // heartbeat start vs the process list's creation time
const RELEASE_MS = 2000; // how long a stopped daemon may take to release its address
const DAEMON_EVENTS = new Set([
  "SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied",
  "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "Stop",
]);

let installedVersion;
function packageVersion() {
  if (installedVersion === undefined) installedVersion = readPackageVersion(PACKAGE_ROOT);
  return installedVersion;
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

// Is anything bound to the daemon's address? See addressBound in fold.js; a hung daemon's
// heartbeat then decides.
export function probePipe(pipe, timeoutMs = PROBE_MS) {
  return addressBound(pipe, timeoutMs);
}

// Pure: what a heartbeat says about the daemon at `now`. A missing heartbeat is both stale and
// of an unknown version.
export function daemonHealth(hb, { version, now, throttleMs = DAEMON_THROTTLE_MS }) {
  if (!hb || typeof hb !== "object") return { stale: true, versionDiffers: true };
  const windowMs = (Number(hb.window) > 0 ? Number(hb.window) : 3) * 1000;
  const stale = !(Number.isFinite(hb.renewed) && now - hb.renewed <= windowMs + throttleMs);
  return { stale, versionDiffers: String(hb.version) !== String(version) };
}

// The claim file holds { claimedAt, suspectSince? }: when the last start or restart was claimed
// (0 for none), and when a suspect daemon was first sighted. It is created exclusively; once it
// exists it is never deleted, only replaced (temp file plus rename) under a short exclusive lock,
// so an exclusive create and a replacement can never both win.
function readClaim(file) {
  let text = null;
  try { text = readFileSync(file, "utf8"); } catch (e) { if (e && e.code === "ENOENT") return null; }
  try {
    const c = JSON.parse(text);
    if (c && typeof c === "object") {
      return { claimedAt: Number.isFinite(c.claimedAt) ? c.claimedAt : 0,
        suspectSince: Number.isFinite(c.suspectSince) ? c.suspectSince : null };
    }
  } catch { /* half-written: an exclusive create writes after it opens */ }
  try { return { claimedAt: statSync(file).mtimeMs, suspectSince: null }; } catch { return null; }
}

function createClaim(file, claim) {
  let fd;
  try { fd = openSync(file, "wx"); } catch (e) { if (e && e.code === "EEXIST") return false; throw e; }
  try { writeSync(fd, JSON.stringify(claim)); } finally { closeSync(fd); }
  return true;
}

function replaceClaim(file, claim) {
  writeAtomic(file, JSON.stringify(claim));
}

// Runs `fn` holding `<claim>.lock`; returns undefined without running it when another hook holds
// the lock. A lock left by a hook that died is removed for the next hook, never entered at once.
function withClaimLock(file, fn) {
  const lock = `${file}.lock`;
  try { closeSync(openSync(lock, "wx")); } catch (e) {
    if (!e || e.code !== "EEXIST") throw e;
    try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); } catch {}
    return undefined;
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch {} }
}

const claimFresh = (c, now, throttleMs) => c.claimedAt > 0 && c.claimedAt <= now && now - c.claimedAt < throttleMs;

// Claim a start or restart at `now`. True for exactly one caller per throttle window: a claim
// older than the window (or one holding only a sighting) is free and is replaced.
export function claimRestart(file, now, throttleMs = DAEMON_THROTTLE_MS) {
  if (createClaim(file, { claimedAt: now })) return true;
  return withClaimLock(file, () => {
    const c = readClaim(file);
    if (c === null) return createClaim(file, { claimedAt: now });
    if (claimFresh(c, now, throttleMs)) return false;
    replaceClaim(file, { claimedAt: now });
    return true;
  }) === true;
}

// A suspect daemon: record the first sighting, or, once the grace period after it has passed,
// claim the restart. A sighting counts only while the heartbeat has not been renewed since it, or
// while the version differs; otherwise this is a new first sighting.
function suspectStep(file, { hb, versionDiffers, now, graceMs = DAEMON_GRACE_MS, throttleMs = DAEMON_THROTTLE_MS }) {
  return withClaimLock(file, () => {
    const c = readClaim(file);
    const since = c && c.suspectSince !== null && (versionDiffers || !(hb && hb.renewed > c.suspectSince))
      ? c.suspectSince : null;
    if (since === null) {
      const next = { claimedAt: c ? c.claimedAt : 0, suspectSince: now };
      if (c === null) createClaim(file, next); else replaceClaim(file, next);
      return { step: "sighted" };
    }
    if (now - since < graceMs) return { step: "waiting" };
    if (claimFresh(c, now, throttleMs)) return { step: "throttled" };
    replaceClaim(file, { claimedAt: now });
    return { step: "restart", since };
  }) || { step: "busy" };
}

// One process from the process list, as "name|creation epoch ms|command line". `pid` is checked
// to be a positive integer before it is put into the query.
const PROCESS_PS = (pid) =>
  `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { ` +
  "'{0}|{1}|{2}' -f $_.Name, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.CommandLine }";

// Pure: does this process-list row show node running `daemonJs`, created at `start` (epoch ms)?
export function isOurDaemon(row, start, daemonJs = DAEMON_JS) {
  const m = /^([^|]*)\|(-?\d+)\|(.*)$/.exec(String(row || "").trim());
  if (!m || !/^node(\.exe)?$/i.test(m[1])) return false;
  const norm = (s) => s.replace(/\\/g, "/").toLowerCase();
  if (!norm(m[3]).includes(norm(daemonJs))) return false;
  return Number.isFinite(start) && Math.abs(Number(m[2]) - start) <= START_SLACK_MS;
}

// Pure (Linux): do /proc/<pid>/stat and /proc/<pid>/cmdline show a process running `daemonJs`
// that started at `startTicks` (the clock ticks the daemon recorded in its heartbeat)? Compared
// exactly, so a slow start under load cannot make a hung daemon unrecognizable.
export function isOurLinuxDaemon({ stat, cmdline }, startTicks, daemonJs = DAEMON_JS) {
  if (!startTicks || procStartTicks(0, () => stat) !== String(startTicks)) return false;
  return String(cmdline || "").split("\0").some((arg) => arg && path.resolve(arg) === path.resolve(daemonJs));
}

// Pure (macOS and other systems with ps): does `ps -o lstart=,command=` show `daemonJs` started at
// `start` (epoch ms)? lstart has whole seconds, so the slack grows by one.
export function isOurPsDaemon(row, start, daemonJs = DAEMON_JS) {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d+)\s+([\d:]+)\s+(\d{4})\s+(.*)$/.exec(String(row || "").trim());
  if (!m || !m[5].includes(daemonJs)) return false;
  const created = Date.parse(`${m[1]} ${m[2]} ${m[4]} ${m[3]}`);
  return Number.isFinite(start) && Number.isFinite(created) && Math.abs(created - start) <= START_SLACK_MS + 1000;
}

export function confirmedDaemonPid(hb, platform = process.platform) {
  const pid = hb && hb.pid;
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    if (platform === "win32") {
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROCESS_PS(pid)],
        { encoding: "utf8", timeout: 5000, windowsHide: true });
      return r.status === 0 && isOurDaemon(r.stdout, hb.start) ? pid : null;
    }
    if (platform === "linux") {
      const read = (f) => readFileSync(f, "utf8");
      return isOurLinuxDaemon({ stat: read(`/proc/${pid}/stat`), cmdline: read(`/proc/${pid}/cmdline`) }, hb.startTicks)
        ? pid : null;
    }
    const r = spawnSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 && isOurPsDaemon(r.stdout, hb.start) ? pid : null;
  } catch { return null; }
}

// Stops a confirmed daemon at once: it is hung or outdated, and its socket file, if any, is
// taken over by the next daemon.
function killDaemon(pid) {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/F", "/PID", String(pid)], { timeout: 5000, windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch {}
}

function spawnDaemon() {
  // Detached and outside the package directory, so npm can replace the package while it runs.
  // The daemon lowers its own priority. Never awaited.
  const child = spawn(process.execPath, [DAEMON_JS],
    { detached: true, stdio: "ignore", windowsHide: true, cwd: runtimeDir() });
  child.on("error", () => {});
  child.unref();
}

async function restartDaemon(judged, since, paths, pipe) {
  const hb = readJson(paths.heartbeat);
  if (judged && hb && hb.pid !== judged.pid) return; // another daemon took over meanwhile
  const { versionDiffers } = daemonHealth(hb, { version: packageVersion(), now: Date.now() });
  if (!versionDiffers && hb && hb.renewed > since) return; // it came back
  const pid = confirmedDaemonPid(hb);
  if (pid !== null) {
    killDaemon(pid);
    for (const end = Date.now() + RELEASE_MS; Date.now() < end && await probePipe(pipe);) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  spawnDaemon();
}

// Pure: the share of CPU time all cores spent idle between two os.cpus() samples, in percent.
export function idlePercent(before, after) {
  let idle = 0, total = 0;
  after.forEach((cpu, i) => {
    const prev = before[i];
    if (!prev) return;
    for (const k of Object.keys(cpu.times)) {
      const d = cpu.times[k] - (prev.times[k] || 0);
      total += d;
      if (k === "idle") idle += d;
    }
  });
  return total > 0 ? (100 * idle) / total : 100;
}

async function machineBusy() {
  const before = os.cpus();
  await new Promise((r) => setTimeout(r, BUSY_SAMPLE_MS));
  return idlePercent(before, os.cpus()) < BUSY_IDLE_PCT;
}

// Resolves true once `file` exists, polling until `waitMs` has passed.
export async function waitForFile(file, waitMs, pollMs = PAYLOAD_POLL_MS) {
  for (const end = Date.now() + waitMs; !existsSync(file);) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
}

async function superviseDaemon(name, sid) {
  if (!DAEMON_EVENTS.has(name)) return;
  const hash = rootHash(PACKAGE_ROOT);
  // Only where this installation's client is in use: it has written this session's payload.
  // SessionStart usually comes before the client's first tick, so it waits for the payload
  // (the hook is installed async; nothing waits on it). Without that wait, a session that finds
  // no daemon running shows the offline line until its first tool call or Stop.
  const waitMs = name === "SessionStart" ? PAYLOAD_WAIT_MS : 0;
  if (!(await waitForFile(sessionPaths(sid, hash).payload, waitMs))) return;
  const paths = daemonPaths(hash), pipe = daemonSocket(hash);
  if (!(await probePipe(pipe))) {
    if (claimRestart(paths.claim, Date.now())) spawnDaemon();
    return;
  }
  const hb = readJson(paths.heartbeat);
  const now = Date.now();
  const { stale, versionDiffers } = daemonHealth(hb, { version: packageVersion(), now });
  if (!stale && !versionDiffers) return;
  // On a saturated machine the below-normal daemon is starved, not hung (a build kept one from
  // renewing for over 80 s). Restarting it would spend CPU on a PowerShell identity check and a
  // new node exactly when there is none, and the new daemon would starve the same way. A daemon
  // that really hangs is handled once the machine has room again.
  if (await machineBusy()) return;
  const r = suspectStep(paths.claim, { hb, versionDiffers, now });
  if (r.step === "restart") await restartDaemon(hb, r.since, paths, pipe);
}

// Best-effort per-session throttle (not a lock): a tiny marker holds the last git ts + cwd.
// Worst case under a race is a redundant concurrent git spawn — harmless and rare.
const gitMarkerPath = (sid) => sessionPaths(sid).git;

function shouldSnapshotGit(name, ev, nowMs, sid) {
  if (name !== "SessionStart" && name !== "Stop" &&
      !(name === "PostToolUse" && WRITE_TOOLS.has(base(ev.tool_name || "")))) return false;
  if (name === "SessionStart") return true; // always prime at start
  let m = {};
  try { m = JSON.parse(readFileSync(gitMarkerPath(sid), "utf8")); } catch { /* none */ }
  const cwd = ev.cwd || (ev.workspace || {}).current_dir;
  if (m.cwd !== cwd) return true; // cwd changed -> refresh regardless of TTL
  return nowMs - (m.ts || 0) >= GIT_TTL;
}

const msysMarkerPath = (sid) => sessionPaths(sid).msys;

// --- Journal housekeeping -------------------------------------------------------------------
// Every session leaves a checkpoint, a journal, probe markers, an advisor cache and a savings file
// next to its checkpoint (see sessionPaths), keyed by session
// id, and nothing ever removed them: a real box accumulated 12 395 files / 10 MB. They are all
// per-session scratch — once a session is over its journal can never be read again — so at
// SessionStart we drop the ones that have gone cold.
//
// Deliberately narrow, because this deletes files:
//   * only names matching our own `mugshot_` / `savings_` prefixes, in the checkpoint's
//     directory, non-recursively;
//   * never SHARED state: the rate-health accumulator, the rate-limit pool and the CPU sample
//     are cross-session by design (see statusline.js) and the reap throttle is process-wide, so
//     they are keyed by a fixed name with no session id and are excluded by name; the render
//     daemon's heartbeat and claim (one pair per install hash) are excluded by pattern;
//   * never this session's own files;
//   * decided per session, by its newest file, so a session that is merely idle — or a
//     concurrent one — is never touched, and a session's files go together or not at all;
//   * a session that ever rendered a bar (it has a checkpoint, advisor cache or savings file)
//     goes once its newest file is older than DOOMBAR_JOURNAL_TTL (default 7 days); one
//     that never rendered — a headless
//     `claude -p` run fires the hooks but shows no bar — after DOOMBAR_UNRENDERED_TTL
//     (default 1 hour), because nothing will ever read its files.
// Orphaned `<checkpoint>.<pid>.tmp` files from interrupted atomic writes belong to their
// session. So do the render daemon's payload and frame (and their `.tmp` leftovers), which always
// live in the runtime directory: they are swept with their session when the checkpoint lives there
// too (the normal case), not when MUGSHOT_STATE moves the checkpoint elsewhere. Failures are ignored per file: housekeeping must never cost a hook its exit 0.
const JOURNAL_TTL = envNum(process.env.DOOMBAR_JOURNAL_TTL, 7 * 24 * 60 * 60 * 1000); // ms
const UNRENDERED_TTL = envNum(process.env.DOOMBAR_UNRENDERED_TTL, 60 * 60 * 1000); // ms

// Fixed-name files shared across sessions — deleting these would lose real state.
const SHARED_STATE = new Set([
  "mugshot_ratehealth_global.json", "mugshot_ratelimits_global.json", "mugshot_cpu.json", "mugshot_reap_tick.json",
]);

// The render daemon's own files (daemonPaths in fold.js): one heartbeat and one claim per install
// hash, shared by every session the daemon serves.
const HASH_RE = `[0-9a-f]{${ROOT_HASH_LEN}}`;
const DAEMON_FILE = new RegExp(`^mugshot_daemon_${HASH_RE}\\.(?:json|claim)(?:\\.\\d+\\.tmp)?$`);
// Per-session payload and frame (sessionPaths in fold.js), with any install hash.
const DAEMON_SESSION_FILE = new RegExp(`^mugshot_(?:payload|frame)_${HASH_RE}_(.+)\\.json(?:\\.\\d+\\.tmp)?$`);

// The session key a file belongs to (the names sessionPaths in fold.js writes), or null when
// the name is not one of ours.
function sessionKeyOf(name) {
  let m = /^mugshot_(?:git|msys|adv)_(.+)\.json$/.exec(name) || /^savings_(.+)\.json$/.exec(name) ||
    DAEMON_SESSION_FILE.exec(name);
  if (m) return m[1];
  m = /^mugshot_(.+?)\.json(?:\.jsonl|\.\d+\.tmp)?$/.exec(name); // checkpoint, journal, .tmp
  return m ? m[1] : null;
}

// Pure: which of `names` are cold scratch files? Exported so the delete rule is tested without
// touching a real temp dir. `ageOf` returns mtime age in ms, or null when it can't be read.
export function staleStateFiles(names, ageOf, { ttl = JOURNAL_TTL, unrenderedTtl = UNRENDERED_TTL, keep = [] } = {}) {
  const all = names || [];
  const listed = new Set(all);
  const mine = new Set(keep.map((p) => path.basename(p)));
  const sessions = new Map(); // session key -> [{ name, age }]
  for (const n of all) {
    if (SHARED_STATE.has(n) || DAEMON_FILE.test(n) || mine.has(n)) continue; // shared state; this session's own files
    const key = sessionKeyOf(n);
    if (key === null) continue;                         // not ours
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push({ name: n, age: ageOf(n) });
  }
  const stale = [];
  for (const [key, files] of sessions) {
    const known = files.filter((f) => Number.isFinite(f.age)); // an unreadable age is never a reason to delete
    if (!known.length) continue;
    const newest = Math.min(...known.map((f) => f.age));
    // Rendered = any file only the statusline writes is present. After end-of-session cleanup
    // the savings file is all that is left, and it must keep the long TTL for a later resume.
    const rendered = [`mugshot_${key}.json`, `mugshot_adv_${key}.json`, `savings_${key}.json`]
      .some((n) => listed.has(n));
    const limit = rendered ? ttl : unrenderedTtl;
    if (newest >= limit) stale.push(...known.map((f) => f.name));
  }
  return stale;
}

function sweepState(sid) {
  if (process.env.DOOMBAR_JOURNAL_TTL === "off") return 0;
  const { checkpoint } = statePaths(sid);
  // Sweep the directory our state actually lives in, not the runtime directory blindly. They are the same
  // in normal use, but MUGSHOT_STATE relocates the checkpoint — and a sweep that ignored it would
  // delete from the real temp dir while writing to a sandbox. That bit the test suite: firing a
  // SessionStart with MUGSHOT_STATE set swept the developer's actual runtime directory.
  const dir = path.dirname(checkpoint);
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  const keep = Object.values(sessionPaths(sid));
  const ageOf = (n) => {
    try { return Date.now() - statSync(path.join(dir, n)).mtimeMs; } catch { return null; }
  };
  let gone = 0;
  for (const n of staleStateFiles(names, ageOf, { keep })) {
    try { unlinkSync(path.join(dir, n)); gone++; } catch { /* in use / already gone */ }
  }
  return gone;
}

// Fires on any event once MSYS_TTL has elapsed (SessionStart always primes). No tool-type gate:
// the count must track reality, not just write activity.
function shouldSnapshotMsys(name, nowMs, sid) {
  if (name === "SessionStart") return true;
  let m = {};
  try { m = JSON.parse(readFileSync(msysMarkerPath(sid), "utf8")); } catch { /* none */ }
  return nowMs - (m.ts || 0) >= MSYS_TTL;
}

// End of session: delete its scratch now rather than leave it for a later session's sweep.
// Kept: the savings file — a resumed session keeps its id, and its lean-ctx savings total lives
// only there. The checkpoint goes: a resume resets it anyway (SessionStart truncates the
// journal), and its stale offset could misread the resumed session's new journal.
// Unlink only — no journal line, no probes — so nothing is recreated behind us.
function endSession(sid) {
  const p = sessionPaths(sid);
  for (const f of [p.journal, p.checkpoint, p.git, p.msys, p.adv]) {
    try { unlinkSync(f); } catch { /* never written, or already gone */ }
  }
  // The daemon's payload and frame (and their `.<pid>.tmp` leftovers) live in the runtime directory
  // under an install hash. The session may have been served by more than one installation, so
  // every hash's files for this exact key go.
  const key = sidKey(sid), tmpDir = path.dirname(p.payload);
  let tmpNames = [];
  try { tmpNames = readdirSync(tmpDir); } catch {}
  for (const n of tmpNames) {
    const m = DAEMON_SESSION_FILE.exec(n);
    if (!m || m[1] !== key) continue;
    try { unlinkSync(path.join(tmpDir, n)); } catch {}
  }
  // Orphaned `<checkpoint>.<pid>.tmp` files from this session's interrupted atomic writes.
  const dir = path.dirname(p.checkpoint), stem = path.basename(p.checkpoint);
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(stem) || !/^\.\d+\.tmp$/.test(n.slice(stem.length))) continue;
    try { unlinkSync(path.join(dir, n)); } catch { /* in use / already gone */ }
  }
}

async function main() {
  try {
    // Every file the hook touches lives in the runtime directory. One that is not private
    // (another user created it, or it is a link) is left alone entirely.
    if (!ensureRuntimeDir()) process.exit(0);
    let ev = {};
    try { ev = JSON.parse(readFileSync(0, "utf8")); } catch { ev = {}; }
    const name = ev.hook_event_name || "";
    const now = Date.now() / 1000; // seconds, matches fold's time base
    const nowMs = Date.now();
    const sid = ev.session_id || "default";
    const { journal } = statePaths(sid);

    if (name === "SessionEnd") {
      try { endSession(sid); } catch { /* housekeeping is never worth failing a hook */ }
      process.exit(0);
    }

    // SessionStart resets the journal so each session starts clean (hygiene; sid is already
    // per-session). At this instant no other hook is appending, so truncation is race-free.
    if (name === "SessionStart") {
      try { writeFileSync(journal, ""); } catch { /* ignore */ }
      // Same moment, same idea: this session's slate is clean, so clear away the dead ones.
      // SessionStart is installed async, so the directory scan never delays anything.
      try { sweepState(sid); } catch { /* housekeeping is never worth failing a hook */ }
    }

    // Append the slim event line (atomic). foldEvent ignores names it doesn't know.
    try {
      appendFileSync(journal, JSON.stringify({ name, ev: slim(ev), ts: now }) + "\n", { flag: "a" });
    } catch { /* never block a tool */ }

    // Git snapshot on write-affecting events / per-turn Stop / session start, throttled.
    const cwd = ev.cwd || (ev.workspace || {}).current_dir;
    if (cwd && shouldSnapshotGit(name, ev, nowMs, sid)) {
      const snap = gitSnapshot(cwd);
      try {
        appendFileSync(journal, JSON.stringify({ name: "git", ev: { git: snap }, ts: now }) + "\n", { flag: "a" });
      } catch { /* ignore */ }
      try { writeFileSync(gitMarkerPath(sid), JSON.stringify({ ts: nowMs, cwd })); } catch { /* ignore */ }
    }

    // MSYS bash-flood gauge: its own time-based gate so a volatile count tracks reality on ANY
    // event (never a render tick). win32 only; null elsewhere -> no line, so the field stays hidden.
    // Once a pile is actually forming, reap the hung statusLine wrappers that caused it, then
    // re-read the count so the HUD shows the state we leave behind, not the one we found.
    if (shouldSnapshotMsys(name, nowMs, sid)) {
      let n = bashCount();
      let reaped = 0;
      if (n !== null && n >= REAP_MIN) {
        reaped = reapStaleShells();
        if (reaped > 0) {
          const after = bashCount();
          if (after !== null) n = after;
        }
      }
      if (n !== null) {
        const msys = reaped > 0 ? { n, r: reaped } : { n };
        try {
          appendFileSync(journal, JSON.stringify({ name: "msys", ev: { msys }, ts: now }) + "\n", { flag: "a" });
        } catch { /* ignore */ }
        try { writeFileSync(msysMarkerPath(sid), JSON.stringify({ ts: nowMs })); } catch { /* ignore */ }
      }
    }

    // Last, after the synchronous work, so the pipe probe's short timeout is never eaten by it.
    await superviseDaemon(name, sid);
  } catch { /* swallow everything: a hook must never block a tool */ }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // `node hook.js --reap` is the reaper on its own, with no journal and no stdin. The render path
  // fires it detached (see maybeReap in statusline.js) so hung wrappers are still cleaned up while
  // the session sits idle and no hook events are arriving — which is exactly when a 1 s refresh
  // timer is the only thing spawning shells.
  if (process.argv.includes("--reap")) {
    try { reapStaleShells(); } catch { /* best effort */ }
    process.exit(0);
  }
  main();
}
