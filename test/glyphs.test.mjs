#!/usr/bin/env node
// Glyph table: code points, masks and the ladder of steps.
import { STEPS, GRID, classGlyphs, glyphsFor } from "../src/kit/raster/glyphs.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const cp = (g) => g.ch.codePointAt(0);
const hex = (n) => "U+" + n.toString(16).toUpperCase();
const ones = (g) => g.mask.reduce((a, b) => a + b, 0);

// Sextants: the code point follows the 6-bit pattern (bit = row * 2 + column), skipping the two
// patterns that are the left and right half blocks.
{
  const sextants = classGlyphs("sextant");
  ok(sextants.length === 60, `60 sextants (got ${sextants.length})`);
  const want = { 1: 0x1fb00, 20: 0x1fb13, 22: 0x1fb14, 41: 0x1fb27, 43: 0x1fb28, 62: 0x1fb3b };
  for (const [bits, code] of Object.entries(want)) {
    // Pattern `bits` on the 2x3 grid: rows of 3, 2, 3 sub-pixels on the 8-pixel grid.
    const g = sextants.find((s) => cp(s) === code);
    const rows = [[0, 3], [3, 5], [5, 8]];
    let match = Boolean(g);
    for (let i = 0; g && i < 6; i++) {
      const [r0, r1] = rows[Math.floor(i / 2)], c0 = (i % 2) * 4;
      const on = Boolean(+bits & (1 << i));
      for (let y = r0; y < r1; y++) for (let x = c0; x < c0 + 4; x++) if (g.mask[y * GRID + x] !== (on ? 1 : 0)) match = false;
    }
    ok(match, `sextant pattern ${bits} is ${hex(code)} with the matching mask`);
  }
  ok(!sextants.some((s) => cp(s) === 0x258c || cp(s) === 0x2590), "patterns 21 and 42 are not sextants (they are half blocks)");
}

// Octants: 230 proper code points, and the six patterns that need rare characters are absent.
{
  const octants = classGlyphs("octant");
  const proper = octants.map(cp).filter((n) => n >= 0x1cd00 && n <= 0x1cde5);
  ok(proper.length === 230 && new Set(proper).size === 230, `230 distinct octants in U+1CD00..U+1CDE5 (got ${proper.length})`);
  const eighths = octants.map(cp).filter((n) => n < 0x1cd00 || n > 0x1cde5).sort();
  ok(JSON.stringify(eighths) === JSON.stringify([0x2582, 0x2586, 0x1fb82, 0x1fb85].sort()),
    `the octant step adds exactly the four eighth blocks (${eighths.map(hex).join(" ")})`);
  const excluded = [0x1cea0, 0x1cea3, 0x1cea8, 0x1ceab, 0x1fbe6, 0x1fbe7];
  ok(STEPS.every((s) => !glyphsFor(s).some((g) => excluded.includes(cp(g)))), "no step uses U+1CEA0/A3/A8/AB or U+1FBE6/7");
  // U+1CD00 is the first proper pattern, 0x04 (left column, second row).
  const first = octants.find((g) => cp(g) === 0x1cd00);
  ok(first && first.mask[2 * GRID + 0] === 1 && first.mask[0] === 0 && ones(first) === 8, "U+1CD00 fills the second row's left sub-cell");
}

// The ladder: each step is a superset of the one below, and masks are unique per step.
{
  for (let i = 1; i < STEPS.length; i++) {
    const lower = new Set(glyphsFor(STEPS[i - 1]).map(cp));
    const upper = new Set(glyphsFor(STEPS[i]).map(cp));
    ok([...lower].every((c) => upper.has(c)), `${STEPS[i]} includes every ${STEPS[i - 1]} glyph`);
  }
  for (const s of STEPS) {
    const list = glyphsFor(s);
    const keys = new Set(list.map((g) => g.mask.join("")));
    ok(keys.size === list.length, `${s}: no two glyphs share a mask (${list.length} glyphs)`);
    const partial = list.filter((g) => g.ch !== " " && g.ch !== "█");
    ok(partial.every((g) => ones(g) > 0 && ones(g) < GRID * GRID), `${s}: every glyph but space and full block is partial`);
  }
  ok(glyphsFor("half").map((g) => g.ch).join("") === " █▀▄▌▐", "half step is space, full block and the four half blocks");
}

// Wedges: shapes come from the polygons.
{
  const w = classGlyphs("wedge");
  ok(w.length === 52, `52 wedge glyphs (got ${w.length})`);
  const g = w.find((x) => cp(x) === 0x1fb3c); // lower-left triangle up to 2/3 height and half width
  const on = (x, y) => g.mask[y * GRID + x] === 1;
  ok(on(0, 7) && on(0, 6) && !on(0, 4) && !on(5, 7) && !on(7, 0), "U+1FB3C covers only the lower-left corner");
  const tri = w.find((x) => cp(x) === 0x1fb6c); // left triangle with its apex at the centre
  ok(tri.mask[3 * GRID + 0] === 1 && tri.mask[3 * GRID + 7] === 0, "U+1FB6C is the left triangle");
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
