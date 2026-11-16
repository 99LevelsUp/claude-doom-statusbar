#!/usr/bin/env node
// Each render of a skin draws from what it is given (the values, the glyph step, the reaction and
// the clock, and the session's own script state), not from module state. So two sessions whose
// renders interleave, the way the render daemon serving many sessions interleaves them, each get
// exactly the lines they get when rendered alone.

import "../_temp-sandbox.mjs"; // before the modules that name temp paths
import { RAW_SAMPLE } from "../_raw-sample.mjs";
import { findGame } from "../../src/games/index.js";
import { findSkin } from "../../src/skin-select.js";
import { loadSkin } from "../../src/kit/skin/load.js";
import { fitSkin } from "../../src/kit/skin/fit.js";
import { drawFit } from "../../src/kit/skin/draw.js";
import { runScripts } from "../../src/kit/skin/scripts.js";
import { createScriptHost } from "../../src/platform/scripts/host.js";
import { createAssetResolver } from "../../src/platform/assets.js";
import { buildReaction } from "../../src/metrics/reaction.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const WIDTH = 160;
const NOW = 1793500000;
const doom = findGame("doom");
const resolveAsset = createAssetResolver({ folder: doom.dir }).resolve;
const SKIN = loadSkin(findSkin("doom-full").file).skin;
const smaller = (name) => loadSkin(findSkin(name).file).skin;
const host = createScriptHost({ callBudgetMs: 2000, graceMs: 2000, startupMs: 5000 });

// Session A: the sample values at the octant step, an ouch on its face. Session B: other values
// (a fuller context, another model, branch and task list), the half step, calm.
const VALUES_A = RAW_SAMPLE;
const VALUES_B = {
  ...RAW_SAMPLE, "context.hp": 91, "model.name": "Sonnet 5.5", "git.branch": { text: "feature/other-session", url: null },
  "act.tasklist": [{ status: "pending", text: "another session's task" }],
};
const reactionTo = (values, st = {}) => buildReaction({ st, values, godUntil: 0, exhausted: false, now: NOW });
const sessionA = (o = {}) => ({ values: VALUES_A, step: "octant", reaction: reactionTo(VALUES_A, { expr: "ouch", ts: NOW - 0.5 }), tick: 3, state: new Map(), ...o });
const sessionB = () => ({ values: VALUES_B, step: "half", reaction: reactionTo(VALUES_B), tick: 7, state: new Map() });

// The steps a render takes, split so the test can put another session between them.
const plan = (s) => {
  const fit = fitSkin(SKIN, { values: s.values, width: WIDTH, loadSmaller: smaller });
  return runScripts(fit, { host, state: s.state, values: s.values, reaction: s.reaction, now: NOW, tick: s.tick,
    folderOf: () => doom.dir, resolveAsset });
};
const build = (run, s) => drawFit(run.fit, { values: s.values, width: WIDTH, scripts: run.scripts,
  ctx: { tick: s.tick, step: s.step, resolveAsset, reaction: s.reaction, now: NOW } }).join("\n");
const render = (s) => build(plan(s), s);

try {
  // Each session alone, A first.
  const aloneA = render(sessionA());
  const aloneB = render(sessionB());
  ok(aloneA !== aloneB, "sessions A and B draw differently (the check below can fail)");
  ok(render(sessionA({ step: "half" })) !== aloneA,
    "session A at the half step draws differently from the octant step (the step checks below can fail)");

  console.log("interleaved builds:");
  {
    const a = sessionA(), b = sessionB();
    const runA = plan(a);
    const runB = plan(b);
    const a1 = build(runA, a);
    const b1 = build(runB, b);
    const a2 = build(runA, a);
    ok(a1 === aloneA, "A planned, then B planned, then A built: A's lines are A's alone");
    ok(b1 === aloneB, "B built right after A: B's lines are B's alone");
    ok(a2 === aloneA, "A built again after B: A's lines are still A's alone");
  }

  console.log("a whole session between planning a render and drawing it:");
  {
    const a = sessionA();
    const runA = plan(a);
    const betweenB = render(sessionB());
    ok(build(runA, a) === aloneA, "B rendered between planning A and drawing A: A's lines are A's alone");
    ok(betweenB === aloneB, "B rendered while A's plan waits: B's lines are B's alone");
  }
} finally {
  host.close();
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
