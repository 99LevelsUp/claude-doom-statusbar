#!/usr/bin/env node
// Claude Code hook: an APPEND-ONLY event recorder for the DOOM HUD.
//
// Old design did read-modify-write on a shared state file per event; under async hooks that
// races (lost subagents/tasks). Now each invocation just APPENDS one slim line to a
// per-session journal — append is atomic, so concurrent async hooks never clobber each
// other. statusline.js folds the journal into a checkpoint at render time (see src/platform/journal.js).
//
// Because the heavy work (folding, git) is off the blocking path, install these hooks with
// "async": true (see src/install/settings.js). This hook never reads the journal and always exits 0.
//
// Extra job: git lives here now, not on the render hot path. On write-affecting events (and
// once per turn on Stop, and at SessionStart) we snapshot git into a `git` journal line,
// throttled by DOOMBAR_GIT_TTL. statusline no longer spawns git at all, so the render process
// itself has no children -> it cannot feed the Windows MSYS "bash flood" from below.
//
// It can still be fed from ABOVE, by the shell Claude Code wraps our render command in. That is
// what reapStaleShells() in src/platform/reap.js cleans up.
//
// Journal: <checkpoint>.jsonl where checkpoint is $MUGSHOT_STATE or <runtime dir>/mugshot_<sid>.json (runtimeDir in src/platform/runtime.js).

import { appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { statePaths, ensureRuntimeDir } from "./platform/runtime.js";
import { superviseDaemon } from "./platform/supervise.js";
import { sweepState, endSession } from "./platform/sweep.js";
import { bashCount, reapStaleShells, REAP_MIN } from "./platform/reap.js";
import { gitSnapshot, gitMarkerPath, msysMarkerPath, shouldSnapshotGit, shouldSnapshotMsys } from "./platform/snapshots.js";

// Project an event down to only the fields src/platform/journal.js consumes. Keeps journal lines tiny and
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
