#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
import { foldActivity } from "../src/hook.js";
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "hook.js");
let fails = 0;
const ok = (c, m) => { console.log((c?"  ok   ":"  FAIL ")+m); if(!c) fails++; };

// Malformed event must not crash the hook (would block tools in a live session).
function runHook(input, env = {}) {
  try {
    execFileSync(process.execPath, [HOOK], { input, encoding: "utf8", env: { ...process.env, ...env } });
    return 0;
  } catch (e) { return e.status ?? 1; }
}
ok(runHook("not json at all") === 0, "garbage stdin -> exit 0");
ok(runHook(JSON.stringify({ hook_event_name: "PostToolUse" /* no tool_input */ })) === 0, "missing tool_input -> exit 0");

function fold(st, name, ev, now) { foldActivity(st, name, ev, now); return st; }

// TaskCreated adds a pending item keyed by id, with immutable creation ts.
let st = {};
fold(st, "TaskCreated", { hook_event_name:"TaskCreated", task_id:"t1", task_title:"scaffold" }, 100);
ok(st.tasks?.t1?.status === "pending" && st.tasks.t1.title === "scaffold", "TaskCreated -> pending item");
ok(st.tasks.t1.ts === 100, "creation ts recorded");
ok(st.tasks_ts === 100, "tasks_ts updated on create");

// TaskCompleted marks done but keeps creation ts.
fold(st, "TaskCompleted", { hook_event_name:"TaskCompleted", task_id:"t1" }, 150);
ok(st.tasks.t1.status === "completed", "TaskCompleted -> completed");
ok(st.tasks.t1.ts === 100, "creation ts unchanged after complete");
ok(st.tasks_ts === 150, "tasks_ts advances to last activity");

// TaskUpdate via PostToolUse drives in_progress and deleted (Path B).
fold(st, "TaskCreated", { hook_event_name:"TaskCreated", task_id:"t2", task_title:"render" }, 160);
fold(st, "PostToolUse", { hook_event_name:"PostToolUse", tool_name:"TaskUpdate", tool_input:{ taskId:"t2", status:"in_progress" } }, 170);
ok(st.tasks.t2.status === "in_progress", "TaskUpdate in_progress applied");
fold(st, "PostToolUse", { hook_event_name:"PostToolUse", tool_name:"TaskUpdate", tool_input:{ taskId:"t2", status:"deleted" } }, 180);
ok(st.tasks.t2.status === "deleted", "TaskUpdate deleted applied");

// Prune: once all terminal AND past TASK_LINGER, the map clears.
let st2 = {};
fold(st2, "TaskCreated", { hook_event_name:"TaskCreated", task_id:"a", task_title:"x" }, 0);
fold(st2, "TaskCompleted", { hook_event_name:"TaskCompleted", task_id:"a" }, 1);
fold(st2, "Stop", { hook_event_name:"Stop" }, 1 + 11); // 11s > TASK_LINGER(10), all terminal
ok(Object.keys(st2.tasks || {}).length === 0, "all-terminal map pruned after linger");

// Not pruned while an open task remains.
let st3 = {};
fold(st3, "TaskCreated", { hook_event_name:"TaskCreated", task_id:"b", task_title:"y" }, 0);
fold(st3, "Stop", { hook_event_name:"Stop" }, 100);
ok(st3.tasks?.b?.status === "pending", "open task survives prune");

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
