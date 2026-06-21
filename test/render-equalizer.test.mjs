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
// Strip ANSI/OSC to count the visible glyph run.
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g;
const visible = (s) => s.replace(ANSI, "");
// The foreground colour of each column, in order, parsed back out of the SGR runs.
const fgs = (s) => [...s.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)].map((m) => [+m[1], +m[2], +m[3]]);
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

// 2. Per-column colour: smooth green->yellow->red gradient, each column by its OWN value.
{
  const WARN = [224, 184, 64];
  // Gradient endpoints are exact: 0 -> green (OK), .5 -> yellow (WARN), 1 -> red (CRIT).
  ok(JSON.stringify(fgs(eq([0]))[0]) === JSON.stringify(OK), "0.0 -> exact green (OK)");
  ok(JSON.stringify(fgs(eq([0.5]))[0]) === JSON.stringify(WARN), "0.5 -> exact yellow (WARN)");
  ok(JSON.stringify(fgs(eq([1]))[0]) === JSON.stringify(CRIT), "1.0 -> exact red (CRIT)");
  // Positional + smooth: as value rises across columns, redness is non-decreasing and
  // greenness non-increasing -- so each column is coloured by its own value, smoothly.
  const cols = fgs(eq([0.1, 0.5, 0.9]));
  ok(cols[0][0] <= cols[1][0] && cols[1][0] <= cols[2][0], "red channel rises (or holds) left-to-right");
  ok(cols[0][1] >= cols[1][1] && cols[1][1] >= cols[2][1], "green channel falls (or holds) left-to-right");
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

// 8. Configurable colour: custom stops, solid colour, and hard transitions.
{
  // Single stop / solid hex -> one colour regardless of value.
  const solidPair = fgs(eq([0.1, 0.9], { color: [[0, "#ff0000"]] }));
  ok(solidPair.every((c) => JSON.stringify(c) === JSON.stringify([255, 0, 0])),
     "single colour stop -> solid (every column the same colour)");
  const solidHex = fgs(eq([0.1, 0.9], { color: "#00ff00" }));
  ok(solidHex.every((c) => JSON.stringify(c) === JSON.stringify([0, 255, 0])),
     "solid #hex string -> every column that colour");

  // Two-stop gradient interpolates: black->white at .5 -> mid grey.
  const mid = fgs(eq([0.5], { color: [[0, "#000000"], [100, "#ffffff"]] }))[0];
  ok(mid[0] === 128 && mid[1] === 128 && mid[2] === 128, `black->white at .5 -> [128,128,128] (got ${mid})`);

  // Adjacent stops (50/51) make a near-hard transition: .49 green, .52 yellow.
  const hard = { color: [[50, "#00ff00"], [51, "#ffff00"]] };
  ok(JSON.stringify(fgs(eq([0.49], hard))[0]) === JSON.stringify([0, 255, 0]), "hard stop: .49 -> green");
  ok(JSON.stringify(fgs(eq([0.52], hard))[0]) === JSON.stringify([255, 255, 0]), "hard stop: .52 -> yellow");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
