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
// Journal: <checkpoint>.jsonl where checkpoint is $MUGSHOT_STATE or <temp>/mugshot_<sid>.json.

import { appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { base, statePaths, sidKey, WRITE_TOOLS } from "./fold.js";

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
//
// Safety: we only ever kill bash.exe whose command line runs OUR statusline.js and which has
// outlived a healthy render many times over. Such a shell is already hung and doomed to crash;
// its render was lost either way. Opt out with DOOMBAR_MSYS_REAP=0.
const REAP_ON = process.env.DOOMBAR_MSYS_REAP !== "0";
const envNum = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
const REAP_MIN = envNum(process.env.DOOMBAR_MSYS_REAP_MIN, 4); // only act once a pile is forming
const REAP_AGE = envNum(process.env.DOOMBAR_MSYS_REAP_AGE, 10000); // ms; a healthy render ~300 ms

// Pure decision half, exported so it can be tested without touching real processes.
// `procs` is [{ pid, ageMs, cmd }] as produced by listBashShells().
export function stalePids(procs, ageMs = REAP_AGE) {
  return (procs || [])
    .filter((p) => p && Number.isInteger(p.pid) && p.pid > 0)
    .filter((p) => /statusline\.js/i.test(String(p.cmd || "")))
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
function reapStaleShells() {
  if (process.platform !== "win32" || !REAP_ON) return 0;
  const pids = stalePids(listBashShells());
  if (pids.length === 0) return 0;
  try {
    const args = pids.flatMap((pid) => ["/PID", String(pid)]);
    spawnSync("taskkill", ["/F", ...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
  } catch { return 0; }
  return pids.length;
}

// Best-effort per-session throttle (not a lock): a tiny marker holds the last git ts + cwd.
// Worst case under a race is a redundant concurrent git spawn — harmless and rare.
function gitMarkerPath(sid) {
  return path.join(os.tmpdir(), `mugshot_git_${sidKey(sid)}.json`);
}

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

function msysMarkerPath(sid) {
  return path.join(os.tmpdir(), `mugshot_msys_${sidKey(sid)}.json`);
}

// Fires on any event once MSYS_TTL has elapsed (SessionStart always primes). No tool-type gate:
// the count must track reality, not just write activity.
function shouldSnapshotMsys(name, nowMs, sid) {
  if (name === "SessionStart") return true;
  let m = {};
  try { m = JSON.parse(readFileSync(msysMarkerPath(sid), "utf8")); } catch { /* none */ }
  return nowMs - (m.ts || 0) >= MSYS_TTL;
}

function main() {
  try {
    let ev = {};
    try { ev = JSON.parse(readFileSync(0, "utf8")); } catch { ev = {}; }
    const name = ev.hook_event_name || "";
    const now = Date.now() / 1000; // seconds, matches fold's time base
    const nowMs = Date.now();
    const sid = ev.session_id || "default";
    const { journal } = statePaths(sid);

    // SessionStart resets the journal so each session starts clean (hygiene; sid is already
    // per-session). At this instant no other hook is appending, so truncation is race-free.
    if (name === "SessionStart") {
      try { writeFileSync(journal, ""); } catch { /* ignore */ }
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
  } catch { /* swallow everything: a hook must never block a tool */ }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
