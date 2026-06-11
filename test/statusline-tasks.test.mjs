#!/usr/bin/env node
import { activityValues } from "../src/statusline.js";
let fails = 0;
const ok = (c, m) => { console.log((c?"  ok   ":"  FAIL ")+m); if(!c) fails++; };

const now = 1000;
const st = { tasks: {
  a: { title:"scaffold",  status:"completed",   ts: 1 },
  b: { title:"render",    status:"deleted",     ts: 2 },
  c: { title:"statusbar", status:"in_progress", ts: 3 },
  d: { title:"hook",      status:"pending",     ts: 4 },
}, tasks_ts: 5 };

const v = activityValues(st, now);

// Count: completed / (completed+open), deleted excluded.
ok(v["act.tasks"] === "1/3", `act.tasks counts live only (got ${v["act.tasks"]})`);

// tasklist: settled (completed, deleted) then open (in_progress, pending).
const list = v["act.tasklist"];
ok(Array.isArray(list) && list.length === 4, "tasklist has all 4 items");
ok(list[0].mark === "✅" && list[1].mark === "❌", "settled on top: ✅ then ❌");
ok(list[2].mark === "⏩" && list[3].mark === "🎯", "open below: ⏩ then 🎯");
ok(Array.isArray(list[0].markRgb) && list[1].markRgb[0] === 224, "done green, deleted red");

// Boxes are always shown — tasklist key emitted regardless of state/linger.
const settled = { tasks: { a:{title:"x",status:"completed",ts:1} }, tasks_ts: 5 };
ok("act.tasklist" in activityValues(settled, 5 + 999), "tasklist always emitted (box always visible)");

// Empty state: keys still present, with empty list / zero counts (AGENTS+TASKS+ACTIVITY shown at 0).
const empty = activityValues({}, now);
ok(Array.isArray(empty["act.tasklist"]) && empty["act.tasklist"].length === 0, "no tasks -> act.tasklist []");
ok(empty["act.tasks"] === "0/0", `no tasks -> act.tasks 0/0 (got ${empty["act.tasks"]})`);
ok(Array.isArray(empty["act.subagents"]) && empty["act.subagents"].length === 0, "no agents -> act.subagents []");
ok(empty["act.agents"] === "0", `no agents -> act.agents 0 (got ${empty["act.agents"]})`);

// Full agent list (no CAP collapse to '+k more').
const sq = {}; for (let i=0;i<7;i++) sq["g"+i]={type:"explore",start:i,desc:"agent "+i};
const va = activityValues({ squad: sq }, now);
ok(va["act.subagents"].length === 7, "agents uncapped (render caps by height)");

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
