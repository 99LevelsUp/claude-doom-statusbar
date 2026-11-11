#!/usr/bin/env node
// The glyph test card command.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STEPS, classGlyphs } from "../src/glyphs.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.js");

const r = spawnSync(process.execPath, [CLI, "test-card"],
  { encoding: "utf8", windowsHide: true, env: { ...process.env, DOOMBAR_GLYPHS: "sextant" } });
const out = r.stdout || "";
ok(r.status === 0, `test-card exits 0 ${r.stderr || ""}`);

// One labelled block per step, in ladder order.
const labels = STEPS.map((s, i) => out.indexOf(`${i + 1}. ${s} (`));
ok(labels.every((p) => p >= 0) && labels.every((p, i) => i === 0 || p > labels[i - 1]),
  `one labelled block per step, in order (${STEPS.join(", ")})`);

// Every glyph of each class appears in its own block, and no left-out character appears anywhere.
for (let i = 0; i < STEPS.length; i++) {
  const block = out.slice(labels[i], i + 1 < STEPS.length ? labels[i + 1] : out.indexOf("The mugshot"));
  const missing = classGlyphs(STEPS[i]).filter((g) => !block.includes(g.ch));
  ok(missing.length === 0, `the ${STEPS[i]} block shows all its glyphs (${missing.length} missing)`);
}
const excluded = [0x1cea0, 0x1cea3, 0x1cea8, 0x1ceab, 0x1fbe6, 0x1fbe7].map((c) => String.fromCodePoint(c));
ok(!excluded.some((c) => out.includes(c)), "no left-out octant character appears on the card");
ok(out.includes("The mugshot at each step"), "the card shows the mugshot drawn at every step");
ok(out.includes('This terminal gets the "sextant" step.'), "with DOOMBAR_GLYPHS=sextant the card names sextant as this terminal's step");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
