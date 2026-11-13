// Git and MSYS snapshots for the journal, and the per-session throttles that decide when the hook
// takes them (see src/hook.js for why git is snapshotted by the hook, not by the render).

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { sessionPaths } from "./runtime.js";
import { base, WRITE_TOOLS } from "./journal.js";

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

function gitCmd(cwd, ...args) {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1000 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch { return null; }
}

export function gitSnapshot(cwd) {
  return {
    cwd,
    br: gitCmd(cwd, "branch", "--show-current"),
    lr: gitCmd(cwd, "rev-list", "--count", "--left-right", "@{u}...HEAD"),
    st: gitCmd(cwd, "status", "--porcelain"),
  };
}

// Best-effort per-session throttle (not a lock): a tiny marker holds the last git ts + cwd.
// Worst case under a race is a redundant concurrent git spawn — harmless and rare.
export const gitMarkerPath = (sid) => sessionPaths(sid).git;

export function shouldSnapshotGit(name, ev, nowMs, sid) {
  if (name !== "SessionStart" && name !== "Stop" &&
      !(name === "PostToolUse" && WRITE_TOOLS.has(base(ev.tool_name || "")))) return false;
  if (name === "SessionStart") return true; // always prime at start
  let m = {};
  try { m = JSON.parse(readFileSync(gitMarkerPath(sid), "utf8")); } catch { /* none */ }
  const cwd = ev.cwd || (ev.workspace || {}).current_dir;
  if (m.cwd !== cwd) return true; // cwd changed -> refresh regardless of TTL
  return nowMs - (m.ts || 0) >= GIT_TTL;
}

export const msysMarkerPath = (sid) => sessionPaths(sid).msys;

// Fires on any event once MSYS_TTL has elapsed (SessionStart always primes). No tool-type gate:
// the count must track reality, not just write activity.
export function shouldSnapshotMsys(name, nowMs, sid) {
  if (name === "SessionStart") return true;
  let m = {};
  try { m = JSON.parse(readFileSync(msysMarkerPath(sid), "utf8")); } catch { /* none */ }
  return nowMs - (m.ts || 0) >= MSYS_TTL;
}
