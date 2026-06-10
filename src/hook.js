#!/usr/bin/env node
// Claude Code hook: an event-bus for the DOOM HUD. Port of hooks/mugshot_hook.py.
// Each invocation reads the shared state file, folds in the lifecycle event, and
// writes it back atomically. The status line reads that state.
//
// State carries: face reaction {expr, ts}; activity spans[] [start,end] (geiger),
// squad{} (running subagents), pending[] (Agent launch labels), tasks{created,
// completed}, errors, mode (permission mode). Always exits 0.
//
// State file: $MUGSHOT_STATE, else <temp>/mugshot_<session_id>.json.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GEIGER_WINDOW = 30.0; // seconds of tool-run history kept for the sparkline
const MAX_RUN = 300.0; // drop an unclosed span after this (assume the Post was lost)

const READ_TOOLS = new Set(["Read", "Grep", "Glob",
  "ctx_read", "ctx_multi_read", "ctx_search", "ctx_semantic_search", "ctx_tree", "ctx_overview"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "ctx_shell", "ctx_edit"]);

function statePath(ev) {
  if (process.env.MUGSHOT_STATE) return process.env.MUGSHOT_STATE;
  const sid = String(ev.session_id || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  return path.join(os.tmpdir(), `mugshot_${sid}.json`);
}

function base(tool) {
  return tool.startsWith("mcp__") ? tool.split("__").pop() : tool;
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
  st.tasks ??= { created: 0, completed: 0 };
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
    st.tasks.created += 1;
  } else if (name === "TaskCompleted") {
    st.tasks.completed += 1;
  }

  const win = now - GEIGER_WINDOW; // prune: closed spans out of window, orphaned open spans
  st.spans = st.spans.filter((s) => (s[1] === null ? s[0] >= now - MAX_RUN : s[1] >= win));
  st.squad = Object.fromEntries(Object.entries(st.squad).filter(([, v]) => now - v.start < MAX_RUN));
}

function main() {
  let ev = {};
  try { ev = JSON.parse(readFileSync(0, "utf8")); } catch { ev = {}; }
  const name = ev.hook_event_name || "";
  const now = Date.now() / 1000;
  const p = statePath(ev);

  let st = {};
  try { st = JSON.parse(readFileSync(p, "utf8")); } catch { st = {}; }

  foldActivity(st, name, ev, now);
  const expr = expression(name, ev.tool_name || "");
  if (expr) { st.expr = expr; st.ts = now; }

  if (ev.permission_mode) st.mode = ev.permission_mode; // not in the statusline payload, only here

  const tmp = `${p}.${process.pid}.tmp`; // atomic write
  try {
    writeFileSync(tmp, JSON.stringify(st));
    renameSync(tmp, p);
  } catch { /* never block the tool */ }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
