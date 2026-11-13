#!/usr/bin/env node
// The face score used to compare the built-in converter with chafa.
import { oklab, renderBack, scoreFace } from "../../scripts/face-score.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

{
  const [L, a, b] = oklab([255, 255, 255]);
  ok(near(L, 1) && near(a, 0) && near(b, 0), `white is L=1, a=0, b=0 (got ${[L, a, b].map((v) => v.toFixed(4))})`);
  const [L0] = oklab([0, 0, 0]);
  ok(near(L0, 0), "black is L=0");
}

// A 4x8 opaque image drawn as a 2x2 grid of cells (each cell 2x4 pixels).
function image(fill) {
  const W = 4, H = 8, rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgba.set([...fill(x, y), 255], (y * W + x) * 4);
  return { width: W, height: H, rgba };
}
{
  const red = [200, 0, 0], blue = [0, 0, 200];
  const img = image(() => red);
  const exact = [[["█", red, null], ["█", red, null]], [["█", red, null], ["█", red, null]]];
  const back = renderBack(exact, 4, 8).pixels;
  ok(back.every((p) => p[0] === 200 && p[1] === 0 && p[2] === 0), "the render-back of red full blocks is uniformly red");
  ok(scoreFace(exact, img).mean === 0 && scoreFace(exact, img).worst === 0, "a face identical to its image scores 0");
  const oneOff = [[["█", red, null], ["█", red, null]], [["█", red, null], ["█", blue, null]]];
  const s = scoreFace(oneOff, img);
  ok(s.worst > s.mean && s.mean > 0, `one wrong cell raises the worst-cell score more than the mean (${s.mean.toFixed(3)} < ${s.worst.toFixed(3)})`);
  const half = [[["▀", red, blue], ["▀", red, blue]], [["▀", red, blue], ["▀", red, blue]]];
  const halfBack = renderBack(half, 4, 8).pixels;
  ok(halfBack[0][0] === 200 && halfBack[3 * 4][2] === 200, "an upper half block draws its foreground on top and background below");
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
