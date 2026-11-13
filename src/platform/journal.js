// Shared, pure reducer for the DOOM HUD state. No spawns, no files.
//
// Two writers used to fight over one state file (hook did read-modify-write per event).
// Now hooks only APPEND raw events to a per-session journal, and statusline FOLDS that
// journal into a checkpoint at render time. This module is the fold — identical state
// shape as before (spans, squad, pending, tasks, tasks_ts, expr, ts, errors, mode, git),
// so every downstream consumer (activityValues, the tests) is unchanged.

export const GEIGER_WINDOW = 30.0; // seconds of tool-run history kept for the sparkline
export const MAX_RUN = 300.0; // drop an unclosed span after this (assume the Post was lost)
export const TASK_LINGER = 10.0; // seconds the task list lingers after all tasks settle (the count stays)

export const READ_TOOLS = new Set(["Read", "Grep", "Glob",
  "ctx_read", "ctx_multi_read", "ctx_search", "ctx_semantic_search", "ctx_tree", "ctx_overview"]);
export const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "ctx_shell", "ctx_edit"]);

export function base(tool) {
  return tool.startsWith("mcp__") ? tool.split("__").pop() : tool;
}

// Task event subject: the exact key isn't documented, so try the likely ones.
export function taskTitle(ev) {
  return ev.task_title || ev.task_subject || ev.subject || ev.title ||
    (ev.tool_input && ev.tool_input.subject) || "task";
}

export function expression(name, tool) {
  const b = base(tool);
  if (["PostToolUseFailure", "StopFailure", "PermissionDenied"].includes(name)) return "ouch";
  if (["Stop", "TaskCompleted"].includes(name)) return "evl";
  if (name === "PostToolUse") {
    if (READ_TOOLS.has(b)) return Math.floor((Date.now() / 1000) * 2) % 2 === 0 ? "tl" : "tr";
    if (WRITE_TOOLS.has(b)) return "kill";
  }
  return null;
}

export function foldActivity(st, name, ev, now) {
  st.spans ??= [];
  st.squad ??= {};
  st.pending ??= [];
  st.tasks ??= {};   // keyed map: id -> { title, status, ts }
  st.errors ??= 0;

  const tool = base(ev.tool_name || "");
  if (name === "PreToolUse") {
    st.spans.push([now, null]); // open a run interval
    if (tool === "Agent") {
      const ti = ev.tool_input || {};
      st.pending.push({ type: ti.subagent_type || "", desc: ti.description || "", ts: now });
      st.pending = st.pending.filter((p) => now - p.ts < 60).slice(-16);
    }
  } else if (["PostToolUse", "PostToolUseFailure", "PermissionDenied"].includes(name)) {
    for (let i = st.spans.length - 1; i >= 0; i--) { // close the most recent open one
      if (st.spans[i][1] === null) { st.spans[i][1] = now; break; }
    }
  }

  if (["PostToolUseFailure", "StopFailure", "PermissionDenied"].includes(name)) {
    st.errors += 1;
  } else if (name === "SubagentStart") {
    const aid = String(ev.agent_id || now);
    const atype = ev.agent_type || "agent";
    let desc = "";
    for (let i = 0; i < st.pending.length; i++) { // FIFO match the launch by agent type
      if (st.pending[i].type === atype) { desc = st.pending[i].desc; st.pending.splice(i, 1); break; }
    }
    st.squad[aid] = { type: atype, start: now, desc };
  } else if (name === "SubagentStop") {
    delete st.squad[String(ev.agent_id || "")];
  } else if (name === "TaskCreated") {
    const id = String(ev.task_id ?? now);
    st.tasks[id] = { title: taskTitle(ev), status: "pending", ts: now };
    st.tasks_ts = now;
  } else if (name === "TaskCompleted") {
    const id = String(ev.task_id ?? "");
    if (st.tasks[id]) st.tasks[id].status = "completed";
    else st.tasks[id] = { title: taskTitle(ev), status: "completed", ts: now };
    st.tasks_ts = now;
  } else if (name === "PostToolUse" && (ev.tool_name === "TaskUpdate") && ev.tool_input) {
    const id = String(ev.tool_input.taskId ?? "");
    const s = ev.tool_input.status;
    if (id && st.tasks[id] && ["pending", "in_progress", "completed", "deleted"].includes(s)) {
      st.tasks[id].status = s;
      st.tasks_ts = now;
    }
  }

  const win = now - GEIGER_WINDOW; // prune: closed spans out of window, orphaned open spans
  st.spans = st.spans.filter((s) => (s[1] === null ? s[0] >= now - MAX_RUN : s[1] >= win));
  st.squad = Object.fromEntries(Object.entries(st.squad).filter(([, v]) => now - v.start < MAX_RUN));
  // Tasks are never pruned here: the count (open/done/total) covers the whole session. Only the
  // task LIST hides once everything has settled; see TASK_LINGER in statusline's activityValues.
}

// One full event fold: activity + face expression + permission mode + git snapshot.
// This is exactly what hook.js's main() used to do per event — now applied at render time
// over the journal. A `git` event carries a precomputed snapshot in ev.git.
export function foldEvent(st, name, ev, now) {
  foldActivity(st, name, ev, now);
  const expr = expression(name, ev.tool_name || "");
  if (expr) { st.expr = expr; st.ts = now; }
  if (ev.permission_mode) st.mode = ev.permission_mode;
  if (name === "git" && ev.git) st.git = ev.git; // { br, lr, st, cwd } or { cwd } when no repo
  if (name === "msys" && ev.msys) st.msys = ev.msys; // { n } — live bash.exe count (win32 only)
}

// Fold a batch of journal lines (each { name, ev, ts }) into st. Sort by ts first: async
// hooks give no append-order guarantee, so SubagentStop can land before its Start. Sorting
// the batch keeps open/close and create/consume in causal order (within the batch).
export function foldBatch(st, lines) {
  const evs = [];
  for (const ln of lines) {
    if (!ln) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; } // torn/partial line -> skip
    if (!o || typeof o.ts !== "number" || typeof o.name !== "string") continue;
    evs.push(o);
  }
  evs.sort((a, b) => a.ts - b.ts);
  for (const o of evs) foldEvent(st, o.name, o.ev || {}, o.ts);
  return st;
}
