// Render daemon supervision from the hooks: daemon health, the start and restart claim, identity
// checks, kill, spawn and restart.

import { readFileSync, statSync, unlinkSync, existsSync, openSync, writeSync, closeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { PACKAGE_ROOT, SRC_DIR } from "../package-root.js";
import {
  sessionPaths, daemonPaths, rootHash, daemonSocket, procStartTicks, addressBound,
  writeAtomic, envNum, packageVersion as readPackageVersion, runtimeDir,
} from "./runtime.js";

const DAEMON_JS = path.join(SRC_DIR, "daemon.js");
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

// Is anything bound to the daemon's address? See addressBound in src/platform/runtime.js; a hung
// daemon's heartbeat then decides.
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

// Fresh within the throttle window on either side of `now`. A concurrent hook takes its `now`
// before it waits for the lock, so the claim it finds there can be a little newer than its own
// clock reading; that claim is fresh, not free. Only a claim further ahead (the clock was set
// back) is free. A daemon that takes longer than the throttle window to bind may be spawned
// twice; the second finds the address bound and exits.
const claimFresh = (c, now, throttleMs) => c.claimedAt > 0 && Math.abs(now - c.claimedAt) < throttleMs;

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

export async function superviseDaemon(name, sid) {
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
