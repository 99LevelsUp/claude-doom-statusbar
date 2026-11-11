// Built-in image-to-glyph conversion: an RGBA image becomes rows of [char, fg, bg] cells, the
// same shape the face loader has always produced (fg/bg an [r,g,b], or null where the area is
// transparent and the box background shows through).
//
// The cell grid follows chafa's size rule, so faces keep the width the layout already plans for:
// a cell is twice as tall as it is wide, the grid fits the image's aspect at the requested rows,
// and it never grows past the image's own pixels (rows beyond that are padded empty).
//
// Each cell is sampled onto an 8x8 sub-grid. For every glyph allowed at the step, the foreground
// is the mean of the pixels under the glyph's mask and the background the mean of the rest; the
// error is the summed squared RGB difference, and the glyph with the lowest error wins (ties go
// to the earlier, simpler glyph). Pixels with alpha below 128 count as transparent: for fitting
// they take the background colour, and a side of the cell made only of them has no colour.

import { GRID, glyphsFor } from "./glyphs.js";

const N = GRID * GRID;

// Rows and columns the image is drawn in at `rows` requested rows.
export function faceSize(width, height, rows) {
  const drawn = Math.max(1, Math.min(rows, Math.ceil(height / 2)));
  return { rows: drawn, cols: Math.max(1, Math.min(width, Math.ceil((drawn * 2 * width) / height))) };
}

// Per step: each glyph with the indices of its mask's set sub-pixels.
const _candidates = new Map();
function candidates(step) {
  let list = _candidates.get(step);
  if (!list) {
    list = glyphsFor(step).map((glyph) => {
      const on = [];
      glyph.mask.forEach((b, i) => { if (b) on.push(i); });
      return { glyph, on: Uint8Array.from(on) };
    });
    _candidates.set(step, list);
  }
  return list;
}

export function convertImage(img, rows, step, { background = [0, 0, 0] } = {}) {
  const { width: W, height: H, rgba } = img;
  const size = faceSize(W, H, rows);
  const cands = candidates(step);
  const px = new Float64Array(N * 3);
  const clear = new Uint8Array(N);
  const out = [];
  let total = 0;

  for (let r = 0; r < size.rows; r++) {
    const line = [];
    for (let c = 0; c < size.cols; c++) {
      // Sample the cell's 8x8 sub-pixels from the nearest image pixel.
      let sr = 0, sg = 0, sb = 0, sq = 0, nClear = 0;
      for (let sy = 0; sy < GRID; sy++) {
        const y = Math.min(H - 1, Math.floor(((r + (sy + 0.5) / GRID) * H) / size.rows));
        for (let sx = 0; sx < GRID; sx++) {
          const x = Math.min(W - 1, Math.floor(((c + (sx + 0.5) / GRID) * W) / size.cols));
          const o = (y * W + x) * 4, i = sy * GRID + sx;
          const transparent = rgba[o + 3] < 128;
          const p0 = transparent ? background[0] : rgba[o];
          const p1 = transparent ? background[1] : rgba[o + 1];
          const p2 = transparent ? background[2] : rgba[o + 2];
          px[i * 3] = p0; px[i * 3 + 1] = p1; px[i * 3 + 2] = p2;
          clear[i] = transparent ? 1 : 0;
          nClear += clear[i];
          sr += p0; sg += p1; sb += p2;
          sq += p0 * p0 + p1 * p1 + p2 * p2;
        }
      }

      // Lowest error: sum of squares minus the two means' contributions.
      let best = cands[0], bestErr = Infinity, bestFg = null;
      for (const cand of cands) {
        const on = cand.on, n = on.length;
        let fr = 0, fg = 0, fb = 0;
        for (let k = 0; k < n; k++) { const j = on[k] * 3; fr += px[j]; fg += px[j + 1]; fb += px[j + 2]; }
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
      const covered = new Uint8Array(N);
      for (const i of best.on) covered[i] = 1;
      for (let i = 0; i < N; i++) {
        if (clear[i]) continue;
        if (covered[i]) fgClear = false; else bgClear = false;
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
