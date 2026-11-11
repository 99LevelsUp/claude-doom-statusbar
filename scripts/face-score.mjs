// Scoring a glyph face against its source image, for comparing converters by numbers next to the
// pictures. The face is drawn back to pixels from the glyphs' exact shapes, sampled 4x4 inside
// every source pixel, and each pixel's colour difference is taken in OKLab (linear light). That is
// a different measure from the squared sRGB error the built-in search minimises on an 8x8 grid,
// so a lower score is not just the search agreeing with itself.

import { glyphByChar, covers } from "../src/glyphs.js";

const toLinear = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };

export function oklab([r8, g8, b8]) {
  const r = toLinear(r8), g = toLinear(g8), b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// The source as the face would show it: transparent pixels (alpha below 128) take the background.
export function sourcePixels(img, background = [0, 0, 0]) {
  const { width: W, height: H, rgba } = img;
  const out = new Array(W * H);
  for (let i = 0; i < W * H; i++) {
    out[i] = rgba[i * 4 + 3] < 128 ? background : [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
  }
  return out;
}

// The face drawn back at the source's pixel size. Cells cover the image evenly; a glyph this table
// does not know is drawn as its background colour.
export function renderBack(face, width, height, background = [0, 0, 0]) {
  const drawn = face.filter((r) => r.length);
  const rows = drawn.length, cols = Math.max(...drawn.map((r) => r.length));
  const out = new Array(width * height);
  const S = 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          const fx = ((x + (i + 0.5) / S) * cols) / width, fy = ((y + (j + 0.5) / S) * rows) / height;
          const c = Math.min(cols - 1, Math.floor(fx)), rr = Math.min(rows - 1, Math.floor(fy));
          const cell = drawn[rr][c] || [" ", null, null];
          const glyph = glyphByChar(cell[0]);
          const on = glyph ? covers(glyph, fx - c, fy - rr) : false;
          const col = (on ? cell[1] : cell[2]) || background;
          r += col[0]; g += col[1]; b += col[2];
        }
      }
      out[y * width + x] = [r / (S * S), g / (S * S), b / (S * S)];
    }
  }
  return { pixels: out, rows, cols };
}

// Mean OKLab distance over all pixels, and the worst cell's mean (one bad eye is visible even
// when the average looks fine).
export function scoreFace(face, img, background = [0, 0, 0]) {
  const { width: W, height: H } = img;
  const src = sourcePixels(img, background);
  const { pixels, rows, cols } = renderBack(face, W, H, background);
  const cellSum = new Float64Array(rows * cols), cellN = new Float64Array(rows * cols);
  let total = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = dist(oklab(src[y * W + x]), oklab(pixels[y * W + x]));
      total += d;
      const k = Math.min(rows - 1, Math.floor((y * rows) / H)) * cols + Math.min(cols - 1, Math.floor((x * cols) / W));
      cellSum[k] += d; cellN[k] += 1;
    }
  }
  let worst = 0;
  for (let k = 0; k < rows * cols; k++) if (cellN[k]) worst = Math.max(worst, cellSum[k] / cellN[k]);
  return { mean: total / (W * H), worst };
}
