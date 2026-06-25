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
// throttled by DOOMBAR_GIT_TTL. statusline no longer spawns git at all -> the Windows MSYS
// "bash flood" is gone by construction (git runs async, event-driven, rarely).
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

// Windows MSYS "bash flood" pressure gauge. Git Bash backs every hook AND the Bash tool on
// Windows, so when too many bash.exe inits collide the shared MSYS section corrupts
// ("add_item errno 1"). We can't repair that from inside a live session (the host keeps
// spawning bash — see tools/fix-msys.cmd), but we can surface the pressure so the HUD warns
// before it bites. Counted via tasklist — a direct exe, never through bash, which would feed
// the very flood we measure. Non-win32 / failure -> null, so the HUD field simply never shows.
function bashCount() {
  if (process.platform !== "win32") return null;
  try {
    const r = spawnSync("tasklist", ["/fi", "imagename eq bash.exe", "/fo", "csv", "/nh"],
      { encoding: "utf8", timeout: 1000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return 0; // no match -> tasklist prints an INFO line, not a row
    return r.stdout.split("\n").filter((l) => l.toLowerCase().includes("bash.exe")).length;
  } catch { return null; }
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

      // Piggyback the MSYS bash-flood gauge on the same throttled, event-driven path (never a
      // render tick). win32 only; null elsewhere -> no line, so the HUD field stays hidden.
      const n = bashCount();
      if (n !== null) {
        try {
          appendFileSync(journal, JSON.stringify({ name: "msys", ev: { msys: { n } }, ts: now }) + "\n", { flag: "a" });
        } catch { /* ignore */ }
      }
    }
  } catch { /* swallow everything: a hook must never block a tool */ }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
