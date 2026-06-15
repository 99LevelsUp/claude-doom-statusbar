#!/usr/bin/env node
import { planLayout, textCapFor, setValues, SAMPLE } from "../src/render.js";
import { parse as parseToml } from "smol-toml";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const full = parseToml(readFileSync(path.join(ROOT, "presets", "full.toml"), "utf8"));
setValues(SAMPLE);

// Coupled scale: cells 14 -> cap 24, cells 4 -> cap 10, linear between.
ok(textCapFor(14) === 24, "textCapFor(14) = 24 (max)");
ok(textCapFor(4) === 10, "textCapFor(4) = 10 (floor)");
ok(textCapFor(9) === 17, `textCapFor(9) = 17 midpoint (got ${textCapFor(9)})`);

// Wide target -> full scale, fits.
{
  const p = planLayout(full, 300);
  ok(p.cells === 14 && p.textCap === 24 && p.fits, `wide -> cells 14 / cap 24 / fits (${JSON.stringify(p)})`);
}

// Mid target -> an intermediate scale, still fits, cap tracks cells.
{
  const p = planLayout(full, 160);
  ok(p.fits && p.cells > 4 && p.cells < 14, `mid -> intermediate cells (got ${p.cells})`);
  ok(p.textCap === textCapFor(p.cells), "mid -> textCap tracks the cells formula");
}

// Sub-minimum target -> floor scale, does NOT fit (this is the fallback trigger).
{
  const p = planLayout(full, 80);
  ok(p.cells === 4 && p.textCap === 10 && !p.fits, `narrow -> cells 4 / cap 10 / fits=false (${JSON.stringify(p)})`);
}

// Monotonicity: width never increases as the target shrinks; cap never below floor.
{
  let prev = Infinity, mono = true, floored = true;
  for (let t = 240; t >= 90; t -= 10) {
    const p = planLayout(full, t);
    if (p.width > prev) mono = false;
    if (p.textCap < 10) floored = false;
    prev = p.width;
  }
  ok(mono, "width is monotonic non-increasing as target shrinks");
  ok(floored, "textCap never drops below the floor of 10");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
