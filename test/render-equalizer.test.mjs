#!/usr/bin/env node
// Unit tests for the `equalizer` render type.
//
// The equalizer is a one-row VU-meter: one block column per channel, each column
// coloured by its OWN value via threshold() (green<60, yellow<85, red>=85). Unlike
// spark it does not pack 2 samples/char and does not span-normalize -- it is 1
// channel = 1 column with absolute 0..1 scaling. It uses its OWN 9-level height
// ramp " ▁▂▃▄▅▆▇█" (index pyround(clamp(v,0,1)*8)) so an idle channel is empty and
// a maxed one is a full block -- deliberately different from spark's 7-level
// BLOCK_RAMP. When channels exceed the column cap (EQ_MAX=16) it densifies by
// averaging into exactly min(N, cap) columns, so the visible width always equals
// metricFixedWidth -- the invariant box layout depends on.
import { renderValue, metricFixedWidth, setValues, vlen, TEXT, OK, CRIT } from "../src/render.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const EQ_MAX = 16;                // column cap, mirrors render.js
const BOX = [28, 32, 54];         // a non-term box bg, like the standard preset
const sgr = (rgb) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
// Strip ANSI/OSC to count the visible glyph run.
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g;
const visible = (s) => s.replace(ANSI, "");
const eq = (vals, extra = {}) => {
  setValues({ "x.cores": vals });
  return renderValue({ id: "x.cores", render: "equalizer", color: "threshold", ...extra }, 0, BOX);
};

// 1. Happy path: 3 channels -> 3 glyphs at empty/mid/full height.
{
  const out = eq([0, 0.5, 1]);
  const v = visible(out);
  ok(vlen(out) === 3, `[0,.5,1] renders 3 columns (got vlen ${vlen(out)})`);
  ok(v === " ▄█", `heights map 0->" ", .5->▄, 1->█ (got "${v}")`);
}

// 2. Per-column colour: each column coloured by its OWN value, in column order.
{
  const WARN = [224, 184, 64];
  const out = eq([0.1, 0.7, 0.9]);   // 10% -> OK, 70% -> WARN, 90% -> CRIT
  ok(out.includes(sgr(OK)), "low column carries the OK (green) colour");
  ok(out.includes(sgr(WARN)), "mid column carries the WARN (yellow) colour");
  ok(out.includes(sgr(CRIT)), "high column carries the CRIT (red) colour");
  // Positional: colours appear left-to-right OK < WARN < CRIT, so each column is
  // coloured by its own value, not just "some red appears somewhere".
  ok(out.indexOf(sgr(OK)) < out.indexOf(sgr(WARN)) && out.indexOf(sgr(WARN)) < out.indexOf(sgr(CRIT)),
     "colours map positionally: OK column before WARN before CRIT");
}

// 3. Boundary .5 maps to ▄ (half height) on the 9-level ramp: pyround(.5*8)=4 -> " ▁▂▃▄"[4].
{
  const v = visible(eq([0.5]));
  ok(v === "▄", `.5 -> ▄ (got "${v}")`);
}

// 4. Overflow densifies to exactly min(N, cap) columns.
{
  ok(vlen(eq(Array(32).fill(0.5))) === EQ_MAX, `32 channels -> ${EQ_MAX} columns`);
  ok(vlen(eq(Array(17).fill(0.5))) === EQ_MAX, `17 channels -> ${EQ_MAX} columns`);
  ok(vlen(eq(Array(8).fill(0.5))) === 8, `8 channels -> 8 columns (no densify)`);
}

// 5. Averaging: a low/high pair densified into one column lands mid-height.
{
  const v = visible(eq([0, 1]));     // 2 channels, under cap -> 2 columns
  ok(vlen(v) === 2, "2 channels stay 2 columns");
  // 32 alternating 0/1 -> 16 pair-averaged columns, each avg 0.5 -> ▄
  const dens = visible(eq(Array.from({ length: 32 }, (_, i) => i % 2)));
  ok([...dens].every((ch) => ch === "▄"), `alternating 0/1 densifies to all ▄ (got "${dens}")`);
}

// 6. Empty array -> no columns, no crash.
{
  ok(vlen(eq([])) === 0, "empty array renders 0 columns");
}

// 7. Width invariant: visible width == metricFixedWidth, under and over the cap.
{
  for (const n of [3, 8, 16, 17, 32, 64]) {
    setValues({ "x.cores": Array(n).fill(0.5) });
    const entry = { id: "x.cores", render: "equalizer", color: "threshold" };
    const w = metricFixedWidth(entry);
    const rendered = renderValue(entry, 0, BOX);
    ok(vlen(rendered) === w && w === Math.min(n, EQ_MAX),
       `N=${n}: vlen(${vlen(rendered)}) == fixedWidth(${w}) == min(N,cap)(${Math.min(n, EQ_MAX)})`);
  }
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
