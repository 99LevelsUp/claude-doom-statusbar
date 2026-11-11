#!/usr/bin/env node
// Built-in image-to-glyph conversion: size rule, search, transparency.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "../src/png.js";
import { convertImage, faceSize } from "../src/glyph-render.js";
import { STEPS, glyphByChar, covers } from "../src/glyphs.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const ALPHA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "images", "mugshot", "alpha");
const sprite = (name) => decodePng(readFileSync(path.join(ALPHA, name + ".png")));
const shape = (face) => {
  const drawn = face.filter((r) => r.length);
  return { lines: face.length, drawn: drawn.length, cols: Math.max(0, ...drawn.map((r) => r.length)) };
};

// The size rule is chafa's: fit the sprite's aspect (a cell is twice as tall as wide), never
// larger than the sprite itself, and pad to the requested rows.
{
  const cases = [
    ["STFST01", 4, 4, 7], ["STFST01", 8, 8, 14], ["STFST01", 16, 15, 24],
    ["STFTL00", 16, 15, 26], ["STFDEAD0", 8, 8, 13],
  ];
  for (const [name, rows, drawn, cols] of cases) {
    const s = shape(convertImage(sprite(name), rows, "octant"));
    ok(s.lines === rows && s.drawn === drawn && s.cols === cols,
      `${name} at ${rows} rows draws ${drawn} lines x ${cols} columns (got ${s.drawn} x ${s.cols} of ${s.lines})`);
  }
  const img = sprite("STFST01");
  ok(STEPS.every((st) => JSON.stringify(shape(convertImage(img, 12, st))) === JSON.stringify(shape(convertImage(img, 12, "half")))),
    "the face has the same size at every step");
  ok(JSON.stringify(faceSize(24, 29, 16)) === JSON.stringify({ rows: 15, cols: 24 }), "faceSize reports the drawn grid");
}

// A synthetic 12x12 image is two cells of 6x12 pixels at one row; each cell draws one sextant
// pattern in blocks of 3x4 pixels. Sampling is smooth, so edges blend a little, but the cell's
// shape and colours stay those of the pattern.
function sextantImage(patterns, fg, bg) {
  const W = 12, H = 12, rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cell = Math.floor(x / 6), i = Math.floor(y / 4) * 2 + Math.floor((x % 6) / 3);
      const c = patterns[cell] & (1 << i) ? fg : bg;
      rgba.set([...c, 255], (y * W + x) * 4);
    }
  }
  return { width: W, height: H, rgba };
}
const close = (a, b, tol = 40) => a && b && a.every((v, k) => Math.abs(v - b[k]) <= tol);
{
  const red = [200, 30, 30], blue = [20, 40, 220];
  // 22 and 25 are not each other's inverse (an inverse pattern is the same glyph with swapped colours).
  const face = convertImage(sextantImage([22, 25], red, blue), 1, "sextant");
  // What each of the six sextant areas shows: the glyph's foreground where its shape covers the
  // area's centre, its background elsewhere. A glyph or its inverse with swapped colours look alike.
  const shows = ([ch, fg, bg], i) => (covers(glyphByChar(ch), ((i % 2) + 0.5) / 2, (Math.floor(i / 2) + 0.5) / 3) ? fg : bg);
  const drawsPattern = (cell, bits) => cell && [0, 1, 2, 3, 4, 5].every((i) => close(shows(cell, i), bits & (1 << i) ? red : blue));
  ok(drawsPattern(face[0][0], 22) && drawsPattern(face[0][1], 25),
    `each cell shows its sextant pattern in the two colours (got ${face[0].map((c) => c[0]).join(" ")})`);
}

// Uniform and transparent cells.
function flatImage(W, H, fill) {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgba.set(fill(x, y), (y * W + x) * 4);
  return { width: W, height: H, rgba };
}
{
  // A 2x4 image at one row is exactly one cell.
  const face = convertImage(flatImage(2, 4, () => [10, 200, 90, 255]), 1, "octant");
  const [ch, fg, bg] = face[0][0];
  const colour = ch === " " ? bg : fg;
  ok((ch === " " || ch === "█") && JSON.stringify(colour) === "[10,200,90]", `a uniform cell is a space or full block in its colour (${ch} ${colour})`);

  const clear = convertImage(flatImage(2, 4, () => [0, 0, 0, 0]), 1, "octant")[0][0];
  ok(clear[1] === null && clear[2] === null, "a fully transparent cell has no colours");

  // Left column transparent, right column red: the transparent side has no colour.
  const half = convertImage(flatImage(2, 4, (x) => (x === 0 ? [0, 0, 0, 0] : [220, 0, 0, 255])), 1, "half")[0][0];
  const sides = [half[1], half[2]];
  ok("▌▐".includes(half[0]) && sides.some((c) => c === null) && sides.some((c) => c && c[0] > 150 && c[1] < 30 && c[2] < 30),
    `a half-transparent cell keeps red on one side and nothing on the other (${half[0]} ${JSON.stringify(sides)})`);
}

// Over all 42 sprites, a richer step never has a higher search error than the step below it.
{
  const names = readdirSync(ALPHA).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4));
  const imgs = names.map(sprite);
  const errs = STEPS.map((st) => imgs.reduce((sum, img) => sum + convertImage(img, 10, st).error, 0));
  ok(errs.every((e, i) => i === 0 || e <= errs[i - 1]), `search error falls with each step (${errs.map((e) => Math.round(e)).join(" > ")})`);
  const a = JSON.stringify(convertImage(imgs[0], 9, "wedge"));
  ok(a === JSON.stringify(convertImage(imgs[0], 9, "wedge")), "the same input converts to the same output");
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
