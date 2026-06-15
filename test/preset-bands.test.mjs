#!/usr/bin/env node
// Regression guard for skipped fallback rungs.
//
// Panel width is 2*max(left,right)+mugshot, so a preset's min-fit width is driven
// by the heaviest side around the mugshot -- NOT by how many boxes it has. The
// trap: which side is heaviest flips with transient session data. When subagents
// and tasks are active the scroll boxes (right of the mugshot) bind; when the
// session is idle they vanish and the left column (MODEL+USAGE+PROJECT) binds.
//
// standard is "full minus SAVE and SYS" AT THE SAME MUGSHOT POSITION, so each of
// its sides is a subset of full's (left = full-left - SAVE, right = full-right -
// SYS). That subset relation makes standard.minFit <= full.minFit hold in EVERY
// data regime by arithmetic -- it is the invariant that keeps standard from being
// skipped. Moving standard's mugshot regroups the boxes, breaks the subset
// relation, and can make standard render WIDER than full in active sessions
// (observed: 149 vs 147) -- precisely when standard is most distinct and most
// wants to show. This test pins the invariant so that regression can't return.
import { resolvePreset, planLayout, setValues, SAMPLE } from "../src/render.js";
import { parse as parseToml } from "smol-toml";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "presets");
const parse = (n) => parseToml(readFileSync(path.join(root, `${n}.toml`), "utf8"));
const presets = { full: parse("full"), standard: parse("standard"), minimal: parse("minimal") };
// Loader returns the SAME object references the assertions compare against, so a
// resolver pick can be matched by identity.
const load = (n) => presets[n] || null;

// Widest face, matching the conservative sprite the resolver fit-tests with. The
// mugshot column is identical across presets, so it cancels in the comparisons.
const sprite = () => "STFTL00";
// Min-fit width = balanced layout at the smallest scale (target 0 forces it).
const minFit = (cfg, vals) => { setValues(vals); return planLayout(cfg, 0, sprite).width; };

// Two regimes that flip the binding side. SAMPLE is an ACTIVE session (subagents +
// tasklist + savings populated). Stripping the scroll metrics empties AGENTS/TASKS
// (and SAVE), so those boxes drop out and the left column binds -- the IDLE case
// where the user originally saw full skip straight to minimal.
const active = SAMPLE;
const idle = { ...SAMPLE };
for (const k of ["act.subagents", "act.tasklist", "save.leanctx", "save.lingua"]) delete idle[k];

{
  const f = minFit(presets.full, active), s = minFit(presets.standard, active), m = minFit(presets.minimal, active);
  // Active: standard MUST be strictly narrower so a real standard band exists.
  // This is the assertion the broken (mugshot-moved) layout failed at 149 > 147.
  ok(s < f, `active: standard (${s}) fits strictly narrower than full (${f})`);
  ok(m <= s, `active: minimal (${m}) is no wider than standard (${s})`);
  // End-to-end: with full as ceiling, the resolver actually lands on standard just
  // below full's floor -- the band is reachable, not merely arithmetic.
  ok(resolvePreset(presets.full, f - 1, load, sprite) === presets.standard,
     `active: resolver lands on standard just below full's floor`);
}

{
  const f = minFit(presets.full, idle), s = minFit(presets.standard, idle), m = minFit(presets.minimal, idle);
  // Idle: standard may TIE full (they then differ only by the SYS box, nothing
  // visible to step through), but it must never be WIDER -- that would skip it.
  ok(s <= f, `idle: standard (${s}) is no wider than full (${f})`);
  ok(m <= s, `idle: minimal (${m}) is no wider than standard (${s})`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
