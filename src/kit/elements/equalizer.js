// The equalizer visual: one column per channel (such as each CPU core), each as high and as
// coloured as its own value on an absolute 0 to 1 scale. More channels than columns are averaged
// into the columns; fewer are spread across them.
//
// `sizing` says where its width comes from: "stretch" spreads the values over `columns`, however
// many there are; "values" gives each value `column_width` columns, at most `columns` in all, so 4
// cores take 4 columns and 16 take 16. "values" is meant for a list whose length holds while the bar
// runs (the CPU cores); a series that grows would widen the element as it grows.

import { OK, TERM_RGB, sgrFg, sgrBg, pyround } from "../ansi.js";
import { vlen } from "../text.js";
import { colorFor, bgsgrBox } from "../colors.js";
import { define, param } from "./schema.js";
import { iconParam, labelOf, labelWidth, block, blank, trackRgb } from "./paint.js";

// Exactly `k` columns from `values`: contiguous slices averaged when there are more values, each
// value repeated over its share of the columns when there are fewer.
function columnsOf(values, k) {
  const n = values.length;
  if (n === 0) return [];
  const cols = [];
  for (let i = 0; i < k; i++) {
    if (n < k) { cols.push(values[Math.floor((i * n) / k)]); continue; }
    const lo = Math.floor((i * n) / k), hi = Math.floor(((i + 1) * n) / k);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += values[j];
    cols.push(sum / (hi - lo));
  }
  return cols;
}

export const equalizer = define({
  name: "equalizer",
  title: "Equalizer",
  description: "One column per channel, each as high and as coloured as its own value from 0 to 1",
  accepts: ["list", "timeseries"],
  params: {
    icon: iconParam(),
    color: param("gradient", "threshold", "How each column colours itself by its value"),
    columns: param("integer", 16, "Columns when there is room; with sizing = values, the most it takes", { min: 1 }),
    min_columns: param("integer", 4, "Columns kept when the bar is narrow", { min: 1 }),
    ramp: param("text", " ▁▂▃▄▅▆▇█", "Characters of a column from empty to full"),
    sizing: param("text", "stretch", "Where its width comes from: stretch spreads the values over `columns`; values gives each value `column_width` columns, at most `columns` in all", { allowed: ["stretch", "values"] }),
    column_width: param("integer", 1, "Columns of each value with sizing = values", { min: 1 }),
  },
  widths: (p, value) => {
    const lbl = labelWidth(p);
    if (p.sizing !== "values") return { min: lbl + Math.min(p.min_columns, p.columns), natural: lbl + p.columns };
    const cols = Math.min(p.columns, (Array.isArray(value) ? value.length : 0) * p.column_width);
    return { min: lbl + Math.min(p.min_columns, cols), natural: lbl + cols, max: lbl + cols };
  },
  rows: () => 1,
  draw({ value, params: p, width, height = 1, surface = TERM_RGB }) {
    const lbl = labelOf(p);
    const k = Math.max(0, width - vlen(lbl));
    const values = (Array.isArray(value) ? value : []).map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
    const ramp = [...p.ramp];
    let body = "";
    for (const raw of columnsOf(values, k)) {
      const v = Math.max(0, Math.min(1, raw));
      body += sgrFg(colorFor(p.color, v * 100) ?? OK) + (ramp[pyround(v * (ramp.length - 1))] ?? " ");
    }
    if (!body) body = blank(k);
    return block([lbl + sgrBg(trackRgb(surface)) + body + bgsgrBox(surface)], width, height);
  },
});
