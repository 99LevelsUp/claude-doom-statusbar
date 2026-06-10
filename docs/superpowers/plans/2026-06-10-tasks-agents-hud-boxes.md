# AGENTS rename + live TASKS box — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the SUBAGENTS box to AGENTS and add a live TASKS box that lists individual tasks, checks them off, and scrolls within the HUD's height instead of stretching it.

**Architecture:** A new `scroll` render mode in `render.js` height-caps both lists (they stop contributing to `totalRows`). `hook.js` accumulates a keyed task map from Task* lifecycle events; `statusline.js` turns it into list items and owns the linger-based visibility. A verification spike (Task 1) decides whether `in_progress`/`deleted` are observable and whether a simpler stdin-snapshot source exists.

**Tech Stack:** Node 18+ ESM, `smol-toml`, node:test-free lightweight assert scripts (the repo's existing `test/*.mjs` pattern: plain scripts that print `ok`/`FAIL` and `process.exit`).

**Spec:** `docs/superpowers/specs/2026-06-10-tasks-agents-hud-boxes-design.md`

---

## File structure

- `src/hook.js` — harden `main()`; replace `st.tasks` counters with a keyed map; add `tasks_ts` + prune. (~40 lines changed)
- `src/statusline.js` — `activityValues`: emit full (uncapped) `act.subagents`; derive `act.tasks` count from the map; build `act.tasklist`; compute TASKS visibility from `tasks_ts`. (~35 lines)
- `src/render.js` — new `scroll` render mode: `rowcount`→0, `available`→default, fixed-width, window selection (top + boundary anchors), overflow markers. (~70 lines)
- `presets/full.toml` — rename SUBAGENTS→AGENTS, switch to `render="scroll"`, add TASKS box.
- `src/render.js` `SAMPLE` — add `act.tasklist` sample so the preview CLI shows it.
- `test/hook-tasks.test.mjs` — task-map folding + prune (new).
- `test/render-scroll.test.mjs` — scroll windowing (new).
- `test/statusline-tasks.test.mjs` — tasklist build + visibility (new).
- `test/tools/capture-hook.mjs` — throwaway bulletproof event-capture hook for Task 1 (deleted after the spike).

**Constants** (define once, reuse): `TASK_LINGER = 10` (seconds), in both `hook.js` (prune) and `statusline.js` (visibility).

**`act.tasklist` item shape** (the contract between statusline and render):
```js
{ mark: "✓", markRgb: [96,200,104] /*OK*/ | [224,84,64] /*CRIT*/ | null, text: "task subject" }
```
`act.subagents` keeps its existing `[left, right]` pair shape — the `scroll` renderer handles both.

**Task ordering for `act.tasklist`** (built in statusline): settled group first (`completed`, then `deleted`) each in creation order, then open group (`in_progress`, then `pending`) each in creation order. Boundary `B` = number of settled items. Creation order uses each item's immutable `ts` (set at TaskCreated, never overwritten); the top-level `st.tasks_ts` tracks last activity for linger and is separate.

---

## Task 1: Verification spike — what do we actually receive?

**No production code changes.** Decides the data source and which fallbacks apply. Pre-structured so the outcome routes to a concrete path.

**Files:**
- Create (throwaway): `test/tools/capture-hook.mjs`
- Temporarily edit: `.claude/settings.local.json` (add one extra PostToolUse hook + a SessionStart-or-statusline capture)

- [ ] **Step 1: Write a bulletproof capture hook**

`test/tools/capture-hook.mjs` — appends raw stdin to a log, never throws, always exits 0:

```js
#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import os from "node:os"; import path from "node:path";
let raw = "";
try { raw = require("node:fs").readFileSync(0, "utf8"); } catch {}
try {
  appendFileSync(path.join(os.tmpdir(), "doombar-capture.log"), raw.trim() + "\n");
} catch {}
process.exit(0);
```
(If the `require` form errors under ESM, use `import { readFileSync } from "node:fs"` at top instead.)

- [ ] **Step 2: Capture the statusline stdin payload (the SNAPSHOT question — investigate FIRST)**

The statusline already receives session JSON on stdin. Add a one-shot dump at the very top of `statusline.js main()` *temporarily*:
```js
try { require("node:fs").appendFileSync(require("node:os").tmpdir()+"/doombar-stdin.json", JSON.stringify(data) + "\n"); } catch {}
```
Trigger a refresh, then inspect `doombar-stdin.json`. **Look for any field carrying the task list** (e.g. `tasks`, `todos`, a `TaskList`-shaped array with subject+status). Remove the temporary line afterward.

- [ ] **Step 3: Wire the capture hook for TaskUpdate**

In `.claude/settings.local.json`, add (alongside the existing hook.js entries) a `PostToolUse` entry:
```json
{ "hooks": [{ "type": "command", "command": "node \"D:/Smeti/Dev/Claude/claude-doom-statusbar/test/tools/capture-hook.mjs\"" }] }
```

- [ ] **Step 4: Exercise the task lifecycle live**

In this Claude Code session: create 2–3 tasks (TaskCreate), set one to `in_progress` (TaskUpdate), complete one (TaskUpdate/TaskCompleted), delete one (TaskUpdate status:"deleted").

- [ ] **Step 5: Inspect the capture log**

Read `%TEMP%/doombar-capture.log`. Record, in the spec's "Risks / open items":
- Does `PostToolUse` fire with `tool_name=="TaskUpdate"` and `tool_input.status` (in_progress / deleted)?
- Do `TaskCreated`/`TaskCompleted` carry `task_title`?
- Does any event double-fire?

- [ ] **Step 6: Decide the path and record it in the spec**

| Finding | Path |
|---|---|
| stdin carries a complete task list (subject+status) | **Path A (snapshot):** statusline reads tasks from stdin each refresh. Task 3 (hook map) reduces to: keep counters only OR skip entirely; no prune. Tasks 5–8 unchanged. |
| no stdin list, but `PostToolUse(TaskUpdate)` carries status | **Path B (accumulation):** proceed with Tasks 3–4 as written (full 4-state + delete). |
| neither | **Path B-2state:** Tasks 3–4 implement only `pending`/`completed` (from TaskCreated/TaskCompleted); `in_progress`/`deleted` omitted; document the stale-deleted limitation in the spec. |

- [ ] **Step 7: Tear down the spike**

Remove the capture hook from `settings.local.json`, delete `test/tools/capture-hook.mjs`, remove any temporary dump lines. Commit the recorded spec update:
```bash
git add docs/superpowers/specs/2026-06-10-tasks-agents-hud-boxes-design.md
git commit -m "docs(spec): record task-event capture findings; lock data-source path"
```

**The rest of the plan is written for Path B (accumulation), the proven hook-bus pattern. If Task 1 selects Path A, apply the simplification noted in Step 6 to Tasks 3–4; Tasks 2, 5–9 are unaffected.**

---

## Task 2: Harden hook.js main() (do this before any other hook edit)

Makes every later hook change safe — a throw in folding must never block tools.

**Files:**
- Modify: `src/hook.js:89-111` (the `main()` body)
- Test: `test/hook-tasks.test.mjs` (new)

- [ ] **Step 1: Write the failing test**

`test/hook-tasks.test.mjs`:
```js
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
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

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to confirm current behavior**

Run: `node test/hook-tasks.test.mjs`
Expected: PASS today (current `foldActivity` tolerates missing fields), but this locks the guarantee before we add risk.

- [ ] **Step 3: Harden `main()`**

Wrap the body so nothing throws before exit. Replace `src/hook.js` `main()` with:
```js
function main() {
  try {
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
    if (ev.permission_mode) st.mode = ev.permission_mode;

    const tmp = `${p}.${process.pid}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(st)); renameSync(tmp, p); } catch { /* never block */ }
  } catch { /* swallow everything: a hook must never block a tool */ }
  process.exit(0);
}
```

- [ ] **Step 4: Run the test**

Run: `node test/hook-tasks.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hook.js test/hook-tasks.test.mjs
git commit -m "fix(hook): wrap main() so folding can never block a tool; add guard test"
```

---

## Task 3: hook.js — keyed task map + prune

**Files:**
- Modify: `src/hook.js:45-87` (`foldActivity`), constants near top
- Test: `test/hook-tasks.test.mjs` (extend)

- [ ] **Step 1: Add the failing tests**

Append to `test/hook-tasks.test.mjs` (before the summary lines). These import `foldActivity` directly:
```js
import { foldActivity } from "../src/hook.js";

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
```

- [ ] **Step 2: Run to verify failure**

Run: `node test/hook-tasks.test.mjs`
Expected: FAIL (`st.tasks.t1` is undefined — current code keeps counters).

- [ ] **Step 3: Implement the keyed map in `foldActivity`**

Add constant near the top of `src/hook.js` (by `GEIGER_WINDOW`):
```js
const TASK_LINGER = 10.0; // seconds the TASKS box lingers after all tasks settle
```
In `foldActivity`, change the init line and the task branches. Replace:
```js
  st.tasks ??= { created: 0, completed: 0 };
```
with:
```js
  st.tasks ??= {};   // keyed map: id -> { title, status, ts }
```
Replace the `TaskCreated`/`TaskCompleted` branches:
```js
  } else if (name === "TaskCreated") {
    st.tasks.created += 1;
  } else if (name === "TaskCompleted") {
    st.tasks.completed += 1;
  }
```
with:
```js
  } else if (name === "TaskCreated") {
    const id = String(ev.task_id ?? now);
    st.tasks[id] = { title: ev.task_title || "task", status: "pending", ts: now };
    st.tasks_ts = now;
  } else if (name === "TaskCompleted") {
    const id = String(ev.task_id ?? "");
    if (st.tasks[id]) st.tasks[id].status = "completed";
    else st.tasks[id] = { title: ev.task_title || "task", status: "completed", ts: now };
    st.tasks_ts = now;
  } else if (name === "PostToolUse" && (ev.tool_name === "TaskUpdate") && ev.tool_input) {
    const id = String(ev.tool_input.taskId ?? "");
    const s = ev.tool_input.status;
    if (id && st.tasks[id] && ["pending", "in_progress", "completed", "deleted"].includes(s)) {
      st.tasks[id].status = s;
      st.tasks_ts = now;
    }
  }
```
At the end of `foldActivity` (after the squad prune line), add the task prune:
```js
  const taskVals = Object.values(st.tasks || {});
  const anyOpen = taskVals.some((t) => t.status === "pending" || t.status === "in_progress");
  if (taskVals.length && !anyOpen && now - (st.tasks_ts || 0) > TASK_LINGER) st.tasks = {};
```

- [ ] **Step 4: Run the tests**

Run: `node test/hook-tasks.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hook.js test/hook-tasks.test.mjs
git commit -m "feat(hook): accumulate tasks into a keyed map (status + creation ts); prune after linger"
```

---

## Task 4: statusline.js — count, full agent list, tasklist, visibility

**Files:**
- Modify: `src/statusline.js:220-258` (`activityValues`), constants near top
- Test: `test/statusline-tasks.test.mjs` (new)

- [ ] **Step 1: Write the failing test**

`test/statusline-tasks.test.mjs`:
```js
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
ok(list[0].mark === "✓" && list[1].mark === "✗", "settled on top: ✓ then ✗");
ok(list[2].mark === "▶" && list[3].mark === "🎯", "open below: ▶ then 🎯");
ok(Array.isArray(list[0].markRgb) && list[1].markRgb[0] === 224, "done green, deleted red");

// Visibility: hidden once all settled AND past linger (statusline-side, event-independent).
const settled = { tasks: { a:{title:"x",status:"completed",ts:1} }, tasks_ts: 5 };
ok(!("act.tasklist" in activityValues(settled, 5 + 11)), "all-settled past linger -> key omitted");
ok("act.tasklist" in activityValues(settled, 5 + 3), "all-settled within linger -> still shown");

// Full agent list (no CAP collapse to '+k more').
const sq = {}; for (let i=0;i<7;i++) sq["g"+i]={type:"explore",start:i,desc:"agent "+i};
const va = activityValues({ squad: sq }, now);
ok(va["act.subagents"].length === 7, "agents uncapped (render caps by height)");

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
```

- [ ] **Step 2: Run to verify failure**

Run: `node test/statusline-tasks.test.mjs`
Expected: FAIL (`act.tasklist` undefined; `act.tasks` reads `.completed/.created` off a map).

- [ ] **Step 3: Implement**

Add constants near the top of `src/statusline.js` (where other consts live):
```js
const TASK_LINGER = 10.0;
const OK_RGB = [96, 200, 104];   // matches render.js OK (done, green)
const CRIT_RGB = [224, 84, 64];  // matches render.js CRIT (deleted, red)
const TASK_MARK = { completed:["✓",OK_RGB], deleted:["✗",CRIT_RGB], in_progress:["▶",null], pending:["🎯",null] };
const TASK_ORDER = { completed:0, deleted:1, in_progress:2, pending:3 }; // settled first, then open
```
In `activityValues`, replace the agent cap block (lines ~243-253) so it emits the **full** list:
```js
  if (Object.keys(squad).length) {
    const agents = Object.values(squad).sort((a, b) => a.start - b.start);
    v["act.subagents"] = agents.map((a) => {
      let label = a.desc || a.type || "agent";
      if ([...label].length > 20) label = [...label].slice(0, 19).join("") + "…";
      return [label, _dur(now - a.start)];
    });
  }
```
Replace the `act.tasks` line (~255) and add the tasklist + visibility:
```js
  const tasks = st.tasks && typeof st.tasks === "object" ? Object.values(st.tasks) : [];
  if (tasks.length) {
    const live = tasks.filter((t) => t.status !== "deleted");
    const done = live.filter((t) => t.status === "completed").length;
    v["act.tasks"] = `${done}/${live.length}`;

    const anyOpen = tasks.some((t) => t.status === "pending" || t.status === "in_progress");
    const visible = anyOpen || (now - (st.tasks_ts || 0) < TASK_LINGER);
    if (visible) {
      const ordered = tasks
        .map((t) => ({ ...t }))
        .sort((a, b) => (TASK_ORDER[a.status] - TASK_ORDER[b.status]) || (a.ts - b.ts));
      v["act.tasklist"] = ordered.map((t) => {
        const [mark, markRgb] = TASK_MARK[t.status] || ["🎯", null];
        return { mark, markRgb, text: t.title };
      });
    }
  }
```
(Delete the old `if ("tasks" in st) v["act.tasks"] = ...` line.)

- [ ] **Step 4: Run the test**

Run: `node test/statusline-tasks.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/statusline.js test/statusline-tasks.test.mjs
git commit -m "feat(statusline): derive task count from map, build act.tasklist, own linger visibility, uncap agents"
```

---

## Task 5: render.js — scroll mode plumbing (height, availability, width)

**Files:**
- Modify: `src/render.js` — `rowcount` (line 271), `available` (219-223), `metricFixedWidth` (195-217)
- Test: `test/render-scroll.test.mjs` (new)

- [ ] **Step 1: Write the failing test**

`test/render-scroll.test.mjs`:
```js
#!/usr/bin/env node
import { setValues, metricFixedWidth } from "../src/render.js";
let fails = 0;
const ok = (c, m) => { console.log((c?"  ok   ":"  FAIL ")+m); if(!c) fails++; };

// metricFixedWidth handles the object item shape (mark + text), truncated by box later.
setValues({ "act.tasklist": [{ mark:"✓", markRgb:null, text:"render engine" }] });
const w = metricFixedWidth({ id:"act.tasklist", render:"scroll" });
ok(typeof w === "number" && w >= "render engine".length, `scroll width measures mark+text (got ${w})`);

// Empty scroll value -> width is just the (absent) label, and box should be hidden via available.
setValues({});
ok(metricFixedWidth({ id:"act.tasklist", render:"scroll" }) === 0, "empty scroll -> zero width");

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
```

- [ ] **Step 2: Run to verify failure**

Run: `node test/render-scroll.test.mjs`
Expected: FAIL (`metricFixedWidth` has no `scroll` branch; returns the `text` fallback `?` width).

- [ ] **Step 3: Implement plumbing**

In `src/render.js`:

(a) `rowcount` (line 271) — scroll must NOT add height:
```js
  const rowcount = (b) => b.metric.reduce((n, m) =>
    n + (m.render === "list" ? (VALUES[m.id] || []).length : (m.render === "scroll" ? 0 : 1)), 0);
```

(b) `available` (line 219-223) — scroll hides when empty (default `id in VALUES`, NOT always-true):
```js
function available(entry) {
  if ("group" in entry) return entry.group.some((i) => i in VALUES);
  if (entry.render === "list") return true;
  return entry.id in VALUES; // scroll + number/text/bar: present-key gate
}
```

(c) `metricFixedWidth` (line 207-214) — add a `scroll` branch handling both item shapes:
```js
  if (r === "scroll") {
    const items = VALUES[entry.id] || [];
    if (items.length === 0) return lw;
    return Math.max(...items.map((it) => {
      if (Array.isArray(it) && it.length === 2)
        return lw + vlen(String(it[0])) + 1 + vlen(String(it[1]));
      // object {mark, text}
      return lw + vlen(String(it.mark || "")) + 1 + vlen(String(it.text || ""));
    }));
  }
```
(Place it right after the existing `if (r === "list") { ... }` block.)

- [ ] **Step 4: Run the test**

Run: `node test/render-scroll.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/render.js test/render-scroll.test.mjs
git commit -m "feat(render): scroll-mode plumbing — no height growth, empty hides, dual-shape width"
```

---

## Task 6: render.js — scroll window selection (extract pure helper) + top anchor

Extract the window math into a pure, unit-testable function, then render it.

**Files:**
- Modify: `src/render.js` — add `scrollWindow()` helper; metric render loop (319-345)
- Test: `test/render-scroll.test.mjs` (extend)

- [ ] **Step 1: Add failing tests for the pure helper**

Append to `test/render-scroll.test.mjs` (before summary). Import the new export:
```js
import { scrollWindow } from "../src/render.js";

// scrollWindow(n, H, anchor, boundary) -> { start, up, down }
// top anchor: always start at 0, show H, overflow below.
let r = scrollWindow(10, 4, "top", 0);
ok(r.start === 0 && r.down === 6 && r.up === 0, "top: start 0, 6 hidden below");
r = scrollWindow(3, 4, "top", 0);
ok(r.start === 0 && r.down === 0 && r.up === 0, "top: all fit -> no overflow");

// boundary anchor: center the settled/open boundary B.
r = scrollWindow(9, 5, "boundary", 4);     // B=4, H=5 -> start = 4 - 2 = 2
ok(r.start === 2 && r.up === 2 && r.down === 2, "boundary centered (start 2)");
r = scrollWindow(9, 5, "boundary", 1);     // few settled -> clamp start 0 (upper half)
ok(r.start === 0 && r.up === 0, "few settled -> top clamp");
r = scrollWindow(9, 5, "boundary", 8);     // few open -> clamp start N-H=4 (lower half)
ok(r.start === 4 && r.down === 0, "few open -> bottom clamp");
r = scrollWindow(4, 5, "boundary", 2);     // all fit -> start 0, no overflow
ok(r.start === 0 && r.up === 0 && r.down === 0, "boundary all-fit -> top aligned");
```

- [ ] **Step 2: Run to verify failure**

Run: `node test/render-scroll.test.mjs`
Expected: FAIL (`scrollWindow` is not exported).

- [ ] **Step 3: Implement the helper**

Add to `src/render.js` (near `metricFixedWidth`, exported):
```js
export function scrollWindow(n, h, anchor, boundary) {
  if (n <= h) return { start: 0, up: 0, down: 0 };       // all fit: top-aligned
  let start;
  if (anchor === "boundary") start = boundary - Math.floor(h / 2);
  else start = 0;                                         // top anchor
  start = Math.max(0, Math.min(start, n - h));            // clamp: never blank rows
  return { start, up: start, down: n - start - h };
}
```

- [ ] **Step 4: Run the helper tests**

Run: `node test/render-scroll.test.mjs`
Expected: PASS

- [ ] **Step 5: Render the scroll column in the metric loop**

In `src/render.js`, in the metric loop (after the `if (m.render === "list") { ... continue; }` block, line ~335), add:
```js
      if (m.render === "scroll") {
        const icon = m.icon || "";
        const lbl = icon ? icon + " " : "";
        const items = VALUES[m.id] || [];
        const H = totalRows - (headers ? 1 : 0);
        const boundary = items.filter((it) => !Array.isArray(it) &&
          (it.mark === "✓" || it.mark === "✗")).length; // settled count (ignored for top anchor)
        const win = scrollWindow(items.length, H, m.anchor || "top", boundary);
        const shown = items.slice(win.start, win.start + H);
        shown.forEach((item, k) => {
          const first = k === 0, last = k === shown.length - 1;
          const over = first && win.up > 0 ? `↑${win.up} ` : last && win.down > 0 ? `↓${win.down} ` : "";
          let body;
          if (Array.isArray(item)) {                       // [left, right] (agents)
            const left = over + lbl + f(TEXT) + String(item[0]);
            const right = f(TEXT) + String(item[1]);
            const room = Math.max(0, w - vlen(left) - vlen(right));
            body = left + " ".repeat(room) + right;
          } else {                                         // {mark, markRgb, text} (tasks)
            const markCol = item.markRgb ? f(item.markRgb) : f(TEXT);
            let text = String(item.text);
            const head = over + markCol + String(item.mark) + " " + f(TEXT);
            const max = w - vlen(over) - vlen(String(item.mark)) - 1;
            if (vlen(text) > max) text = [...text].slice(0, Math.max(0, max - 1)).join("") + "…";
            body = head + text;
            body += " ".repeat(Math.max(0, w - vlen(body)));
          }
          col.push(bgsgrBox(boxRgb) + " " + body + " " + RESET);
        });
        continue;
      }
```

- [ ] **Step 6: Commit**

```bash
git add src/render.js test/render-scroll.test.mjs
git commit -m "feat(render): scroll window selection (pure scrollWindow helper) + top/boundary rendering"
```

---

## Task 7: Wire the preset + SAMPLE, verify boundary visually

**Files:**
- Modify: `presets/full.toml:58-63` (SUBAGENTS→AGENTS + scroll), add TASKS box
- Modify: `src/render.js` `SAMPLE` (line 30-41) — add `act.tasklist`

- [ ] **Step 1: Update the preset**

In `presets/full.toml`, replace the SUBAGENTS box and add TASKS after it:
```toml
[[segment]]
type  = "box"
title = "AGENTS"
metric = [
  { id = "act.subagents", render = "scroll", anchor = "top", icon = "👹" },
]

[[segment]]
type  = "box"
title = "TASKS"
metric = [
  { id = "act.tasklist", render = "scroll", anchor = "boundary" },
]
```

- [ ] **Step 2: Add SAMPLE data for the preview**

In `src/render.js` `SAMPLE`, add (after `act.subagents`):
```js
  "act.tasklist": [
    { mark:"✓", markRgb: OK, text:"scaffold project" },
    { mark:"✓", markRgb: OK, text:"render engine" },
    { mark:"✗", markRgb: CRIT, text:"port PIL alpha" },
    { mark:"▶", markRgb: null, text:"statusline values" },
    { mark:"🎯", markRgb: null, text:"hook bus" },
    { mark:"🎯", markRgb: null, text:"installer" },
  ],
```

- [ ] **Step 3: Visually verify the boundary + both boxes**

Run: `node src/render.js full.toml 140`
Expected: a HUD with `AGENTS` (two rows, capped) and `TASKS` showing `✓`(green)/`✗`(red) on top, `▶`/`🎯` below, boundary near center, neither box taller than the others. Confirm no Python/SUBAGENTS text remains.

- [ ] **Step 4: Commit**

```bash
git add presets/full.toml src/render.js
git commit -m "feat(preset): rename SUBAGENTS->AGENTS, add TASKS box (scroll); SAMPLE for preview"
```

---

## Task 8: Integration — smoke test + full suite green

**Files:**
- Modify: `package.json` (test script), `test/smoke.test.mjs` if needed

- [ ] **Step 1: Add new tests to the npm test script**

In `package.json`, update `"test"`:
```json
"test": "node test/installer.test.mjs && node test/smoke.test.mjs && node test/hook-tasks.test.mjs && node test/statusline-tasks.test.mjs && node test/render-scroll.test.mjs"
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: every block ends PASS / ALL PASS / SMOKE PASS.

- [ ] **Step 3: End-to-end with a populated task state**

Write a temp state file with a task map and a sample stdin, run the wired statusline command (as in `smoke.test.mjs`), and confirm a TASKS box appears in the output. (Reuse the smoke harness; set `MUGSHOT_STATE` to a file containing `{"tasks":{...},"tasks_ts":...}` and `COLUMNS=140`.)

- [ ] **Step 4: Commit**

```bash
git add package.json test/
git commit -m "test: wire task/agent/scroll suites into npm test; e2e TASKS render check"
```

---

## Task 9: Re-wire the live session to confirm in production

**Files:** none (config already points at `src/*.js`; this is observational)

- [ ] **Step 1: Confirm the live HUD**

The session's `.claude/settings.local.json` already runs `node src/hook.js` + `src/statusline.js`. With the new code committed, create a couple of tasks in this session and confirm the TASKS box appears, checks off on completion, and disappears ~10 s after all settle. (Hook reads from disk live — no restart needed.)

- [ ] **Step 2: Push**

```bash
git push origin master
```

---

## Self-review notes

- **Spec coverage:** rename (T7), scroll no-height-growth (T5 rowcount + render-scroll test), boundary centering/clamp (T6 scrollWindow), top anchor + drop-out (T6), glyphs/colors ✓green/✗red/▶/🎯 (T4+T7), deleted in settled group (T4 ordering), linger visibility statusline-side (T4) + hook prune (T3), empty→hidden (T5 available), `act.tasks` count from map (T4), in_progress/deleted via spike (T1→T3), multiple in_progress grouped (T4 ordering). All mapped.
- **Path A simplification** (if Task 1 finds a stdin task list) collapses T3/T4's hook-side accumulation; T5–T9 unaffected.
- **Constants** `TASK_LINGER=10`, `OK_RGB`/`CRIT_RGB` duplicated in hook/statusline by necessity (separate processes) — kept numerically identical to `render.js` `OK`/`CRIT`.
