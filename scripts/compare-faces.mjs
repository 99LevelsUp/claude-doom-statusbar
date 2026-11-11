#!/usr/bin/env node
// Side by side: the built-in face and chafa's, at the same glyph step and size, with their scores
// (mean and worst-cell OKLab distance from the sprite, lower is closer). A third, unscored column
// shows chafa with the symbol set the bar used before the built-in converter.
//
//   node scripts/compare-faces.mjs                     faces of all 42 sprites at 8 rows, octant step,
//                                                      then the score summary for every height 4-16
//   node scripts/compare-faces.mjs --rows 12 --step sextant --sprite STFST01
//   node scripts/compare-faces.mjs --all-steps         the summary for every step (slow: one chafa
//                                                      process per face and height)

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "../src/png.js";
import { convertImage, faceSize } from "../src/glyph-render.js";
import { STEPS } from "../src/glyphs.js";
import { sgrFg, sgrBg } from "../src/ansi.js";
import { scoreFace } from "./face-score.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALPHA = path.join(ROOT, "assets", "images", "mugshot", "alpha");
const CHAFA_SYMBOLS = {
  half: "space+solid+half", quadrant: "space+solid+half+quad", sextant: "space+solid+half+quad+sextant",
  wedge: "space+solid+half+quad+sextant+wedge", octant: "space+solid+half+quad+sextant+wedge+octant",
};
const BEFORE = "block+half+quad+sextant+wedge+legacy"; // the set the bar gave chafa before

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const showRows = Number(opt("--rows", 8));
const showStep = opt("--step", "octant");
const only = opt("--sprite", null);
if (!STEPS.includes(showStep)) { console.error(`--step must be one of: ${STEPS.join(", ")}`); process.exit(2); }

const names = readdirSync(ALPHA).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4))
  .filter((n) => !only || n === only).sort();
const images = new Map(names.map((n) => [n, decodePng(readFileSync(path.join(ALPHA, n + ".png")))]));

// chafa's ANSI output as exactly `rows` rows of [char, fg, bg] cells, the shape the converter
// returns. Reverse video (7) swaps the colours, as the terminal would.
function toFace(text, rows) {
  const out = [];
  let row = [], fgc = null, bgc = null, rev = false;
  const chars = [...text]; // code points: the glyphs are astral
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "\r") continue;
    if (c === "\n") { out.push(row); row = []; continue; }
    if (c === "\x1b" && chars[i + 1] === "[") {
      let j = i + 2;
      while (j < chars.length && !/[A-Za-z]/.test(chars[j])) j++;
      if (chars[j] === "m") {
        const ps = chars.slice(i + 2, j).join("").split(";").map((p) => (p === "" ? 0 : Number(p)));
        for (let k = 0; k < ps.length; k++) {
          const p = ps[k];
          if (p === 0) { fgc = null; bgc = null; rev = false; }
          else if (p === 7) rev = true;
          else if (p === 27) rev = false;
          else if (p === 39) fgc = null;
          else if (p === 49) bgc = null;
          else if ((p === 38 || p === 48) && ps[k + 1] === 2 && k + 4 < ps.length) {
            const col = ps.slice(k + 2, k + 5);
            if (p === 38) fgc = col; else bgc = col;
            k += 4;
          }
        }
      }
      i = j;
      continue;
    }
    row.push(rev ? [c, bgc, fgc] : [c, fgc, bgc]);
  }
  if (row.length) out.push(row);
  const face = out.slice(0, rows);
  while (face.length < rows) face.push([]);
  return face;
}

// chafa's face for one sprite at the converter's size.
function chafaFace(name, rows, symbols) {
  const img = images.get(name);
  const size = faceSize(img.width, img.height, rows);
  const r = spawnSync("chafa", ["-f", "symbols", "--polite", "on", "--colors", "full", "--symbols", symbols,
    "--size", `${size.cols}x${size.rows}`, path.join(ALPHA, name + ".png")], { encoding: "utf8", windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return toFace(r.stdout, rows);
}

const cellStr = ([ch, fg, bg]) => sgrFg(fg || [0, 0, 0]) + sgrBg(bg || [0, 0, 0]) + ch;
const lineOf = (row, width) => (row || []).map(cellStr).join("") + "\x1b[0m" + " ".repeat(Math.max(0, width - (row || []).length));
const fmt = (s) => (s ? `${s.mean.toFixed(4)} / ${s.worst.toFixed(4)}` : "chafa missing");

if (spawnSync("chafa", ["--version"]).error) { console.error("chafa is not on PATH"); process.exit(2); }

console.log(`Faces at ${showRows} rows, ${showStep} step: built-in | chafa, same step | chafa, the set used before`);
console.log("Scores: mean / worst-cell OKLab distance from the sprite, lower is closer.\n");
for (const name of names) {
  const img = images.get(name);
  const ours = convertImage(img, showRows, showStep);
  const theirs = chafaFace(name, showRows, CHAFA_SYMBOLS[showStep]);
  const before = chafaFace(name, showRows, BEFORE);
  const width = faceSize(img.width, img.height, showRows).cols;
  console.log(`${name}   built-in ${fmt(scoreFace(ours, img))}   chafa ${fmt(theirs && scoreFace(theirs, img))}`);
  for (let r = 0; r < showRows; r++) {
    console.log("  " + [ours, theirs, before].map((f) => lineOf(f && f[r], width)).join("   "));
  }
}

// Every face here starts one chafa process; --all-steps scores all five steps (five times as many).
const summarySteps = args.includes("--all-steps") ? STEPS : [showStep];
console.log("\nScore summary over all sprites, every height 4-16 (mean of means / mean of worst cells):");
console.log("step      built-in             chafa                built-in better on");
for (const step of summarySteps) {
  let om = 0, ow = 0, cm = 0, cw = 0, n = 0, better = 0;
  for (const name of names) {
    const img = images.get(name);
    for (let rows = 4; rows <= 16; rows++) {
      const o = scoreFace(convertImage(img, rows, step), img);
      const cf = chafaFace(name, rows, CHAFA_SYMBOLS[step]);
      if (!cf) continue;
      const c = scoreFace(cf, img);
      om += o.mean; ow += o.worst; cm += c.mean; cw += c.worst; n++;
      if (o.mean <= c.mean) better++;
    }
  }
  console.log(`${step.padEnd(9)} ${(om / n).toFixed(4)} / ${(ow / n).toFixed(4)}   ${(cm / n).toFixed(4)} / ${(cw / n).toFixed(4)}   ${better} of ${n} faces`);
}
