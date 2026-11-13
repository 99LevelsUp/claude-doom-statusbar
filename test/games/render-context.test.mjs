#!/usr/bin/env node
// Each render draws from its own render context (src/kit/context.js): the values, the glyph step,
// the mugshot background and the reaction travel in it, not in module state. So two sessions whose
// renders interleave, the way a long-lived renderer serving many sessions could interleave them,
// each get exactly the lines they get when rendered alone.

import "../_temp-sandbox.mjs"; // before the modules that name temp paths
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { SAMPLE } from "../../src/kit/values.js";
import { renderContext } from "../../src/kit/context.js";
import { resolvePreset } from "../../src/kit/planner.js";
import { buildBar, mugshotFace } from "../../src/games/doom/layout.js";
import { buildReaction } from "../../src/metrics/reaction.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const PRESETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "presets");
const loadPreset = (name) => {
  try { return parseToml(readFileSync(path.join(PRESETS, `${name}.toml`), "utf8")); }
  catch { return null; }
};
const CFG = loadPreset("full");
const WIDTH = 160;
const NOW = 1793500000;

// Session A: the preview data at the octant step, an ouch on its face. Session B: other values
// (a fuller context, another model, branch and task list), the half step, calm.
const VALUES_A = SAMPLE;
const VALUES_B = {
  ...SAMPLE, "context.hp": 91, "model.name": "Sonnet 5.5", "git.branch": "feature/other-session",
  "act.tasklist": [{ mark: "🎯", markRgb: null, text: "another session's task" }],
};
const reactionTo = (values, st = {}) => buildReaction({ st, values, godUntil: 0, exhausted: false, now: NOW });
const contextA = (o = {}) => renderContext({ values: VALUES_A, step: "octant",
  reaction: reactionTo(VALUES_A, { expr: "ouch", ts: NOW - 0.5 }), now: NOW, tick: 3, ...o });
const contextB = () => renderContext({ values: VALUES_B, step: "half", reaction: reactionTo(VALUES_B), now: NOW, tick: 7 });

// The steps renderSession takes, split so the test can put another session between them.
const plan = (ctx) => {
  const selected = resolvePreset(ctx, CFG, WIDTH, loadPreset, mugshotFace(ctx));
  ctx.overflow = selected.text_overflow || CFG.text_overflow || "scroll";
  return selected;
};
const build = (selected, ctx) => buildBar(selected, WIDTH, ctx).lines.join("\n");
const render = (ctx) => build(plan(ctx), ctx);

// Each session alone, A first.
const aloneA = render(contextA());
const aloneB = render(contextB());
ok(aloneA !== aloneB, "sessions A and B draw differently (the check below can fail)");
ok(render(contextA({ step: "half" })) !== aloneA,
  "session A at the half step draws differently from the octant step (the step checks below can fail)");

console.log("interleaved builds:");
{
  const ctxA = contextA(), ctxB = contextB();
  const pickA = plan(ctxA);
  const pickB = plan(ctxB);
  const a1 = build(pickA, ctxA);
  const b1 = build(pickB, ctxB);
  const a2 = build(pickA, ctxA);
  ok(a1 === aloneA, "A planned, then B planned, then A built: A's lines are A's alone");
  ok(b1 === aloneB, "B built right after A: B's lines are B's alone");
  ok(a2 === aloneA, "A built again after B: A's lines are still A's alone");
}

console.log("a whole session between building a context and its lines:");
{
  const ctxA = contextA();
  const betweenB = render(contextB());
  ok(render(ctxA) === aloneA, "B rendered between building A's context and A's lines: A's lines are A's alone");
  ok(betweenB === aloneB, "B rendered while A's context waits: B's lines are B's alone");

  const ctxB = contextB();
  const pickB = plan(ctxB);
  const betweenA = render(contextA());
  ok(build(pickB, ctxB) === aloneB, "A rendered between planning B and building B: B's lines are B's alone");
  ok(betweenA === aloneA, "A rendered while B's plan waits: A's lines are A's alone");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
