// Built-in image-to-glyph conversion: an RGBA image becomes rows of [char, fg, bg] cells, the
// same shape the face loader has always produced (fg/bg an [r,g,b], or null where the area is
// transparent and the box background shows through).
//
// The cell grid follows chafa's size rule, so faces keep the width the layout already plans for:
// a cell is twice as tall as it is wide, the grid fits the image's aspect at the requested rows,
// and it never grows past the image's own pixels (rows beyond that are padded empty).
//
// Each cell is sampled onto an 8x8 sub-grid by bilinear interpolation of the image composited over
// the background, as chafa scales before it picks glyphs. A sub-pixel whose interpolated alpha is
// below 128 counts as transparent and takes the background colour.
//
// Picking the glyph also follows chafa: the cell is split by its two most contrasting sub-pixels
// (on whichever of red, green, blue or alpha varies most), giving a two-colour shape; the five
// glyphs whose masks are nearest to that shape are scored, foreground being the mean of the
// sub-pixels under the mask and background the mean of the rest, and the one with the lowest
// summed squared RGB error wins. Keeping to glyphs of the cell's own shape draws cleaner outlines
// than scoring every glyph, which chases colour error with stray diagonals.

import { GRID, glyphsFor } from "./glyphs.js";

const N = GRID * GRID;
const SHORTLIST = 5;

// Rows and columns the image is drawn in at `rows` requested rows.
export function faceSize(width, height, rows) {
  const drawn = Math.max(1, Math.min(rows, Math.ceil(height / 2)));
  return { rows: drawn, cols: Math.max(1, Math.min(width, Math.ceil((drawn * 2 * width) / height))) };
}

// Per step: each glyph with its mask and the indices of the mask's set sub-pixels.
const _candidates = new Map();
function candidates(step) {
  let list = _candidates.get(step);
  if (!list) {
    list = glyphsFor(step).map((glyph) => {
      const on = [];
      glyph.mask.forEach((b, i) => { if (b) on.push(i); });
      return { glyph, mask: glyph.mask, on: Uint8Array.from(on) };
    });
    _candidates.set(step, list);
  }
  return list;
}

// The image composited over the background (alpha as weight), with its alpha kept:
// [r, g, b, a] per pixel as floats, a in 0..255.
function composited(img, background) {
  const { width: W, height: H, rgba } = img;
  const f = new Float64Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const a = rgba[i * 4 + 3] / 255;
    for (let k = 0; k < 3; k++) f[i * 4 + k] = rgba[i * 4 + k] * a + background[k] * (1 - a);
    f[i * 4 + 3] = rgba[i * 4 + 3];
  }
  return f;
}

export function convertImage(img, rows, step, { background = [0, 0, 0] } = {}) {
  const { width: W, height: H } = img;
  const size = faceSize(W, H, rows);
  const all = candidates(step);
  const comp = composited(img, background);
  const GW = size.cols * GRID, GH = size.rows * GRID;
  const px = new Float64Array(N * 4); // r, g, b, a per sub-pixel
  const clear = new Uint8Array(N);
  const bits = new Uint8Array(N);
  const near = new Array(all.length);
  const out = [];
  let total = 0;

  for (let r = 0; r < size.rows; r++) {
    const line = [];
    for (let c = 0; c < size.cols; c++) {
      // Sample the cell's 8x8 sub-pixels.
      let sr = 0, sg = 0, sb = 0, sq = 0;
      for (let sy = 0; sy < GRID; sy++) {
        const fy = Math.min(H - 1, Math.max(0, ((r * GRID + sy + 0.5) * H) / GH - 0.5));
        const y0 = Math.floor(fy), y1 = Math.min(H - 1, y0 + 1), ty = fy - y0;
        for (let sx = 0; sx < GRID; sx++) {
          const fx = Math.min(W - 1, Math.max(0, ((c * GRID + sx + 0.5) * W) / GW - 0.5));
          const x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), tx = fx - x0;
          const i = sy * GRID + sx;
          for (let k = 0; k < 4; k++) {
            const top = comp[(y0 * W + x0) * 4 + k] * (1 - tx) + comp[(y0 * W + x1) * 4 + k] * tx;
            const bottom = comp[(y1 * W + x0) * 4 + k] * (1 - tx) + comp[(y1 * W + x1) * 4 + k] * tx;
            px[i * 4 + k] = top * (1 - ty) + bottom * ty;
          }
          clear[i] = px[i * 4 + 3] < 128 ? 1 : 0;
          if (clear[i]) { px[i * 4] = background[0]; px[i * 4 + 1] = background[1]; px[i * 4 + 2] = background[2]; }
          const p0 = px[i * 4], p1 = px[i * 4 + 1], p2 = px[i * 4 + 2];
          sr += p0; sg += p1; sb += p2;
          sq += p0 * p0 + p1 * p1 + p2 * p2;
        }
      }

      // The cell's two-colour shape: the most contrasting pair of sub-pixels on the channel that
      // varies most, and every sub-pixel assigned to the nearer of the two.
      let lo = 0, hi = 0, range = -1;
      for (let k = 0; k < 4; k++) {
        let mn = 0, mx = 0;
        for (let i = 1; i < N; i++) {
          if (px[i * 4 + k] < px[mn * 4 + k]) mn = i;
          if (px[i * 4 + k] >= px[mx * 4 + k]) mx = i;
        }
        const rk = px[mx * 4 + k] - px[mn * 4 + k];
        if (rk > range) { range = rk; lo = mn; hi = mx; }
      }
      const dist = (i, j) => (px[i * 4] - px[j * 4]) ** 2 + (px[i * 4 + 1] - px[j * 4 + 1]) ** 2 + (px[i * 4 + 2] - px[j * 4 + 2]) ** 2;
      for (let i = 0; i < N; i++) bits[i] = dist(i, lo) > dist(i, hi) ? 1 : 0;

      // The glyphs nearest to that shape (ties keep table order), scored by colour error.
      for (let k = 0; k < all.length; k++) {
        const m = all[k].mask;
        let h = 0;
        for (let i = 0; i < N; i++) h += m[i] ^ bits[i];
        near[k] = h * 1024 + k;
      }
      const picks = near.slice().sort((a, b) => a - b).slice(0, SHORTLIST);

      let best = null, bestErr = Infinity, bestFg = null;
      for (const p of picks) {
        const cand = all[p % 1024];
        const on = cand.on, n = on.length;
        let fr = 0, fg = 0, fb = 0;
        for (let k = 0; k < n; k++) { const j = on[k] * 4; fr += px[j]; fg += px[j + 1]; fb += px[j + 2]; }
        const nb = N - n;
        const br = sr - fr, bg = sg - fg, bb = sb - fb;
        const err = sq - (n ? (fr * fr + fg * fg + fb * fb) / n : 0) - (nb ? (br * br + bg * bg + bb * bb) / nb : 0);
        if (err < bestErr - 1e-9) { bestErr = err; best = cand; bestFg = [fr, fg, fb, n]; }
      }
      total += Math.max(0, bestErr);

      // Colours, and no colour for a side that is all transparent.
      const [fr, fg, fb, n] = bestFg;
      const nb = N - n;
      let fgClear = n > 0, bgClear = nb > 0;
      for (let i = 0; i < N; i++) {
        if (clear[i]) continue;
        if (best.mask[i]) fgClear = false; else bgClear = false;
      }
      const mean = (a, b, cc, k) => [Math.round(a / k), Math.round(b / k), Math.round(cc / k)];
      const fgCol = n && !fgClear ? mean(fr, fg, fb, n) : null;
      const bgCol = nb && !bgClear ? mean(sr - fr, sg - fg, sb - fb, nb) : null;
      line.push([best.glyph.ch, fgCol, bgCol]);
    }
    out.push(line);
  }
  while (out.length < rows) out.push([]);
  out.error = total;
  return out;
}
