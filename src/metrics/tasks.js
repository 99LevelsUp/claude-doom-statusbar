// The session state: the hook journal folded into the checkpoint (loadState), and Claude Code's
// on-disk task list laid over it (tasksDir, readDiskTasks, mergeDiskTasks).

import { readFileSync, openSync, readSync, closeSync, statSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { foldBatch } from "../platform/journal.js";
import { statePaths, writeAtomic } from "../platform/runtime.js";

// Claude Code keeps each session's task list on disk (~/.claude/tasks/<list id>/<task id>.json),
// and that survives a reboot and `claude --resume`; our journal in the runtime directory doesn't. The
// list id is CLAUDE_CODE_TASK_LIST_ID when set, otherwise the session id. DOOMBAR_TASKS_DIR
// overrides the whole directory (tests). Returns null when there is no list directory.
export function tasksDir(sessionId, env = process.env) {
  if (env.DOOMBAR_TASKS_DIR) return env.DOOMBAR_TASKS_DIR;
  const listId = env.CLAUDE_CODE_TASK_LIST_ID || sessionId;
  if (!listId) return null;
  const home = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(home, "tasks", String(listId));
}

export function readDiskTasks(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const out = {};
  for (const n of names) {
    if (!n.endsWith(".json") || n.startsWith(".")) continue;
    const f = path.join(dir, n);
    try {
      const t = JSON.parse(readFileSync(f, "utf8"));
      if (!t || typeof t !== "object") continue;
      const id = String(t.id ?? n.slice(0, -5));
      out[id] = { title: t.subject || t.title || "task", status: t.status || "pending", ts: statSync(f).mtimeMs / 1000 };
    } catch { /* half-written or foreign file: skip */ }
  }
  // Once every task is done, Claude Code deletes the task files and records the highest id it
  // handed out in .highwatermark (new tasks continue above it). Ids up to that mark with no
  // file were cleaned up as finished, so count them as completed; `cleaned` keeps them out of
  // the list, since their titles are gone. (A task deleted before the cleanup counts as done.)
  try {
    const f = path.join(dir, ".highwatermark");
    const hwm = Math.min(parseInt(readFileSync(f, "utf8").trim(), 10) || 0, 10000);
    const ts = statSync(f).mtimeMs / 1000;
    for (let i = 1; i <= hwm; i++) {
      if (!(String(i) in out)) out[String(i)] = { title: "task", status: "completed", ts, cleaned: true };
    }
  } catch { /* no cleanup yet */ }
  return out;
}

// Overlay the on-disk task list onto the folded state (a copy; the checkpoint is untouched).
// A task file's status wins. A task the journal saw deleted stays deleted. A cleaned-up task
// (see readDiskTasks) takes its title from the journal when the journal still has it, and
// shows in the list again. Journal tasks with no file are kept as the journal last saw them.
// From the journal we also keep the creation time, for a stable order. Settled tasks stay, so
// the count keeps them; activityValues hides the list itself.
export function mergeDiskTasks(st, disk) {
  if (!disk) return st;
  const seen = st.tasks || {};
  const tasks = {};
  let latest = st.tasks_ts || 0;
  for (const [id, t] of Object.entries(disk)) {
    const j = seen[id];
    if (j && j.status === "deleted") tasks[id] = { ...j };
    else if (j && t.cleaned) tasks[id] = { ...j, status: "completed" };
    else tasks[id] = { ...t, ts: j ? j.ts : t.ts };
    latest = Math.max(latest, t.ts);
  }
  for (const [id, j] of Object.entries(seen)) if (!(id in tasks)) tasks[id] = { ...j };
  return { ...st, tasks, tasks_ts: latest };
}

// Fold the per-session journal into the checkpoint and return the folded state.
//
// Read cost is O(events since last render): we read only journal bytes past the stored
// offset, so a multi-hour session never re-reads old events. Invariant: checkpoint.state
// always equals fold(journal[0..offset]); state + offset are persisted together atomically,
// so the reducer's push/increment ops never double-count across renders.
export function loadState(data, env = process.env) {
  const { checkpoint, journal } = statePaths(data.session_id, env);

  let size = -1;
  try { size = statSync(journal).size; } catch { /* no journal yet */ }

  let raw = null;
  try { raw = readFileSync(checkpoint, "utf8"); } catch { /* no checkpoint */ }
  let st;
  if (raw === null) {
    st = { offset: 0 };                          // no checkpoint -> recompute from journal start
  } else {
    try { st = JSON.parse(raw); } catch { st = null; }
    if (!st || typeof st !== "object") st = { offset: 0 }; // corrupt -> full recompute (journal has full history)
    else if (typeof st.offset !== "number") st.offset = Math.max(0, size); // externally-supplied state is current
  }

  if (size < 0) return st;                        // no journal -> state stands as-is
  if (st.offset > size) st = { offset: 0 };       // journal truncated/reset -> recompute from 0

  if (size > st.offset) {
    let chunk = "";
    try {
      const fd = openSync(journal, "r");
      const buf = Buffer.alloc(size - st.offset);
      readSync(fd, buf, 0, buf.length, st.offset);
      closeSync(fd);
      chunk = buf.toString("utf8");
    } catch { chunk = ""; }
    const lastNl = chunk.lastIndexOf("\n");       // consume complete lines only; keep any partial tail
    if (lastNl >= 0) {
      foldBatch(st, chunk.slice(0, lastNl).split("\n"));
      st.offset += Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8");
    }
  }

  try { // persist state + offset together, atomically
    writeAtomic(checkpoint, JSON.stringify(st));
  } catch { /* ignore: next render retries */ }
  return st;
}
