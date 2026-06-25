#!/usr/bin/env node
// The append-only journal + fold-at-render pipeline:
//   hook.js  APPENDS one slim line per event (never read-modify-write)
//   loadState() in statusline.js FOLDS journal[offset..EOF] into the checkpoint
// Verifies fast incremental reads (offset skip), partial-line tolerance, async event
// reordering (no ghost agents), and corruption recovery (no double-count).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadState } from "../src/statusline.js";
import { foldBatch } from "../src/fold.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "src", "hook.js");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-journal-"));
const checkpoint = path.join(tmp, "state.json");
const journal = checkpoint + ".jsonl";
// Both the hook subprocess (via env) and in-process loadState (via process.env) must point
// at the same checkpoint/journal pair.
process.env.MUGSHOT_STATE = checkpoint;
const env = { ...process.env, MUGSHOT_STATE: checkpoint, DOOMBAR_GIT_TTL: "999999" };
const line = (o) => JSON.stringify(o) + "\n";

try {
  // --- hook appends, never RMW; garbage stdin still exits 0 ---
  const runHook = (input) => {
    try { execFileSync(process.execPath, [HOOK], { input, encoding: "utf8", env }); return 0; }
    catch (e) { return e.status ?? 1; }
  };
  ok(runHook("not json") === 0, "garbage stdin -> hook exit 0");
  ok(runHook(line({ hook_event_name: "TaskCreated", session_id: "x", task_id: "t1", task_title: "scaffold" })) === 0,
    "TaskCreated -> hook exit 0");
  // Count only EVENT lines: the hook also appends throttled git/msys snapshot lines (win32),
  // which are orthogonal to the append-per-event mechanic under test here.
  const j1 = readFileSync(journal, "utf8").trim().split("\n")
    .map((l) => JSON.parse(l)).filter((o) => o.name !== "git" && o.name !== "msys");
  ok(j1.length === 2, `journal has 2 appended event lines (got ${j1.length})`); // garbage event + task event
  ok(j1[1].name === "TaskCreated", "appended line is the event, parseable");

  // --- loadState folds the journal into the checkpoint and advances offset ---
  let st = loadState({ session_id: "x" });
  ok(st.tasks?.t1?.status === "pending", "loadState folded TaskCreated -> pending task");
  const off1 = st.offset;
  ok(off1 > 0, "offset advanced past folded bytes");
  const cp = JSON.parse(readFileSync(checkpoint, "utf8"));
  ok(cp.offset === off1 && cp.tasks?.t1, "checkpoint persisted state + offset together");

  // --- incremental: a second render reads only the new tail, not the whole file ---
  appendFileSync(journal, line({ name: "TaskCompleted", ev: { task_id: "t1" }, ts: 200 }), { flag: "a" });
  st = loadState({ session_id: "x" });
  ok(st.tasks.t1.status === "completed", "second render folded only the new line");
  ok(st.offset > off1, "offset advanced again");

  // --- multi-hour skip: events BEFORE the stored offset are never re-read ---
  // Pre-seed a checkpoint whose offset sits at current EOF, then prepend-irrelevant history
  // is already behind it. Append one fresh line; only that one must be folded.
  const sizeNow = readFileSync(journal).length;
  writeFileSync(checkpoint, JSON.stringify({ offset: sizeNow, errors: 5 })); // pretend everything so far is folded
  appendFileSync(journal, line({ name: "PostToolUseFailure", ev: {}, ts: 300 }), { flag: "a" });
  st = loadState({ session_id: "x" });
  ok(st.errors === 6, `only the post-offset event folded: errors 5->6 (got ${st.errors})`);
  ok(!st.tasks?.t1, "old pre-offset task events were NOT re-folded (skipped via offset)");

  // --- partial last line (no trailing newline) tolerated; folded next tick ---
  const before = loadState({ session_id: "x" }).offset;
  appendFileSync(journal, JSON.stringify({ name: "PostToolUseFailure", ev: {}, ts: 400 }), { flag: "a" }); // NO newline
  st = loadState({ session_id: "x" });
  ok(st.offset === before, "partial line not consumed (offset held until newline)");
  appendFileSync(journal, "\n", { flag: "a" }); // complete it
  st = loadState({ session_id: "x" });
  ok(st.errors === 7, "completed line folded on the next render");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// --- async reordering: SubagentStop before its Start in one batch -> no ghost agent ---
{
  const st = {};
  foldBatch(st, [
    line({ name: "SubagentStop", ev: { agent_id: "a1" }, ts: 50 }).trim(),    // out of order (later ts? no—earlier here)
    line({ name: "SubagentStart", ev: { agent_id: "a1", agent_type: "x" }, ts: 40 }).trim(),
  ]);
  // ts-sort makes Start(40) fold before Stop(50) -> agent created then removed -> empty squad
  ok(Object.keys(st.squad || {}).length === 0, "ts-sorted batch: Start-then-Stop -> no ghost agent");
}

// --- corruption: a garbage checkpoint -> full recompute from journal, no double-count ---
{
  const tmp2 = mkdtempSync(path.join(os.tmpdir(), "doombar-journal2-"));
  const cp2 = path.join(tmp2, "s.json");
  const j2 = cp2 + ".jsonl";
  try {
    appendFileSync(j2, line({ name: "PostToolUseFailure", ev: {}, ts: 10 }), { flag: "a" });
    appendFileSync(j2, line({ name: "PostToolUseFailure", ev: {}, ts: 20 }), { flag: "a" });
    writeFileSync(cp2, "{ this is not valid json");
    const env2 = process.env.MUGSHOT_STATE;
    process.env.MUGSHOT_STATE = cp2;
    const st = loadState({ session_id: "y" });
    if (env2 === undefined) delete process.env.MUGSHOT_STATE; else process.env.MUGSHOT_STATE = env2;
    ok(st.errors === 2, `corrupt checkpoint -> full replay, errors=2 not doubled (got ${st.errors})`);
  } finally {
    rmSync(tmp2, { recursive: true, force: true });
  }
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
