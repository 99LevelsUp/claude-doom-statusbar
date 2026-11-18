#!/usr/bin/env node
// The AGENTS box names each subagent by its own launch and counts the ones still running:
//   - Claude Code's record of a subagent (<transcript>/subagents/agent-<id>.meta.json) gives its
//     description, whatever order parallel launches of one type started in;
//   - a subagent runs as long as it runs, not five minutes;
//   - one Claude Code marks finished is gone even when its SubagentStop was lost.
// Observed 18.11.2026 in real journals: five parallel general-purpose launches started as one batch
// in another order than they were launched, some launches named no type, and a review agent that
// ran 530 s left the box after 300 s.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { foldBatch } from "../../src/platform/journal.js";
import { activityValues } from "../../src/metrics/activity.js";
import { subagentMeta, metaFile } from "../../src/metrics/subagents.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const line = (name, ev, ts) => JSON.stringify({ name, ev, ts });
const launch = (desc, type, ts) => line("PreToolUse", { tool_name: "Agent", tool_input: { description: desc, ...(type ? { subagent_type: type } : {}) } }, ts);
const start = (id, ts, type = "general-purpose") => line("SubagentStart", { agent_id: id, agent_type: type }, ts);
const stop = (id, ts) => line("SubagentStop", { agent_id: id, agent_type: "general-purpose" }, ts);
const labels = (v) => v["act.subagents"].map(([l]) => l);

const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-subagents-"));
try {
  const transcript = path.join(SB, "project", "sess-1.jsonl");
  const dir = path.join(SB, "project", "sess-1", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(transcript, "");
  const meta = (id, description, finished = false) =>
    writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "general-purpose", description, toolUseId: `toolu_${id}`, finished }));

  console.log("Claude Code's record:");
  ok(metaFile(transcript, "a1b2") === path.join(dir, "agent-a1b2.meta.json"), "a subagent's record sits next to the session's transcript");
  ok(metaFile(transcript, "../x") === null && metaFile(transcript, "") === null && metaFile("t.txt", "a1") === null && metaFile(null, "a1") === null,
    "an id that is not a plain id, or no transcript, names no file");
  ok(subagentMeta(transcript, "nope") === null, "no record: nothing known");
  meta("a1", "Simplify review: test value");
  ok(JSON.stringify(subagentMeta(transcript, "a1")) === JSON.stringify({ description: "Simplify review: test value", finished: false }), "the record gives the description and whether it is finished");
  meta("a1", "Simplify review: test value", true);
  ok(subagentMeta(transcript, "a1").finished === true, "a changed record is read again");

  console.log("labels from the record:");
  // Two parallel launches of one type, started in the other order (as in the journal).
  const st = foldBatch({}, [
    launch("Simplify review: test value", "general-purpose", 100),
    launch("Simplify review: comments", "general-purpose", 101),
    start("b2", 102), start("b1", 102.0001),
  ]);
  meta("b1", "Simplify review: test value");
  meta("b2", "Simplify review: comments");
  const withMeta = activityValues(st, 110, (id) => subagentMeta(transcript, id));
  ok(withMeta["act.agents"] === 2 && labels(withMeta).includes("Simplify review: test value") && labels(withMeta).includes("Simplify review: comments")
    && new Set(labels(withMeta)).size === 2, `each subagent has its own launch's description (${labels(withMeta).join(" | ")})`);
  const b1 = withMeta["act.subagents"].find(([l]) => l === "Simplify review: test value");
  ok(b1 !== undefined, "and b1, started second, is still the first launch's");

  console.log("without a record:");
  const noMeta = activityValues(st, 110);
  ok(noMeta["act.agents"] === 2 && labels(noMeta).every((l) => l.startsWith("Simplify review")), "the launches matched by type still label them");
  const untyped = foldBatch({}, [launch("Adversarial review", null, 200), start("c1", 201)]);
  ok(labels(activityValues(untyped, 205))[0] === "Adversarial review", "a launch that names no type matches a general-purpose start");

  console.log("how long a subagent counts:");
  const long = foldBatch({}, [launch("Long review", "general-purpose", 1000), start("d1", 1001)]);
  foldBatch(long, [line("PreToolUse", { tool_name: "Read" }, 1531)]); // 530 s later, as in the journal
  ok(activityValues(long, 1531)["act.agents"] === 1, "a subagent running 530 s is still counted");
  foldBatch(long, [stop("d1", 1600)]);
  ok(activityValues(long, 1600)["act.agents"] === 0, "its SubagentStop takes it out");
  const lost = foldBatch({}, [launch("Lost stop", "general-purpose", 2000), start("e1", 2001)]);
  meta("e1", "Lost stop", true);
  ok(activityValues(lost, 2100, (id) => subagentMeta(transcript, id))["act.agents"] === 0, "one Claude Code marks finished is gone without its SubagentStop");
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
