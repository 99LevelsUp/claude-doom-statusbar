// Meters for the bar: colour stops and interpolation, and the value renderers
// (bar, ammo, icons, spark, equalizer, text) that draw one metric from VALUES.

import { TERM_RGB, TEXT, OK, CRIT, sgrFg, sgrBg, pyround } from "./ansi.js";
import { vlen } from "./text.js";
import { VALUES } from "./values.js";

const WARN = [224, 184, 64];
const SPARK = [120, 184, 232];

const EIGHTHS = [..." ▏▎▍▌▋▊▉"];

const f = sgrFg;

// Default heat gradient: green (0) -> yellow (50) -> red (100). Higher = hotter,
// the orientation every caller wants (context usage, rate limits, CPU, disk, RAM).
const DEFAULT_STOPS = [[0, OK], [50, WARN], [100, CRIT]];

const lerp1 = (a, b, t) => Math.round(a + (b - a) * t);

// Interpolate an RGB colour at `pct` (0..100) across sorted [value, rgb] stops.
// Below the first stop / above the last it clamps to that stop. A single stop is a
// solid colour; adjacent stops (e.g. 50 then 51) make a near-hard transition.
function interpStops(stops, pct) {
  if (pct <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (pct >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [v0, c0] = stops[i - 1], [v1, c1] = stops[i];
    if (pct <= v1) {
      const t = v1 === v0 ? 0 : (pct - v0) / (v1 - v0);
      return [0, 1, 2].map((j) => lerp1(c0[j], c1[j], t));
    }
  }
  return last[1];
}

// Resolve a metric's `color` spec to an RGB at `pct` (0..100):
//   "threshold"        -> the default green->yellow->red gradient
//   [[v, "#hex"], ...] -> a custom gradient (a single pair = a solid colour)
//   "#rrggbb"          -> a solid colour
//   unset / unknown    -> null, so the caller can pick its own default
export function colorFor(spec, pct) {
  if (spec === "threshold") return interpStops(DEFAULT_STOPS, pct);
  if (Array.isArray(spec) && spec.length) {
    const stops = spec.map(([v, c]) => [v, rgbOf(c)]).sort((a, b) => a[0] - b[0]);
    return interpStops(stops, pct);
  }
  if (typeof spec === "string" && spec.startsWith("#")) return rgbOf(spec);
  return null;
}

export function rgbOf(spec) {
  if (typeof spec === "string" && spec.startsWith("#")) {
    return [1, 3, 5].map((i) => parseInt(spec.slice(i, i + 2), 16));
  }
  return TERM_RGB; // term-bg / term-fg approximated for blends
}

export const isTerm = (rgb) => rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0;

export function bgsgrBox(boxRgb) {
  return isTerm(boxRgb) ? "\x1b[49m" : sgrBg(boxRgb);
}

export function borderFg(spec) {
  if (typeof spec === "string" && spec.startsWith("#")) return f(rgbOf(spec));
  if (spec === "term-fg") return "\x1b[39m";
  return "\x1b[38;2;0;0;0m"; // term-bg -> black-ish line
}

// --- render styles ----------------------------------------------------------

function rBar(pct, cells, boxRgb, colorSpec, showPct = true) {
  const empty = [0, 1, 2].map((i) => Math.floor((boxRgb[i] + TERM_RGB[i]) / 2));
  const eighths = pyround((pct / 100) * cells * 8);
  const full = Math.min(cells, Math.floor(eighths / 8));
  const rem = full < cells ? eighths % 8 : 0;
  const c = colorFor(colorSpec, pct) ?? TEXT;
  let s = sgrBg(empty) + f(c) + "█".repeat(full);
  if (rem) s += EIGHTHS[rem];
  s += " ".repeat(Math.max(0, cells - full - (rem ? 1 : 0)));
  s += bgsgrBox(boxRgb);
  if (showPct) s += f(c) + " " + String(pct).padStart(3) + "%";
  return s;
}

function rAmmo(pct, colorSpec, segs = 5) {
  const c = colorFor(colorSpec, pct) ?? WARN;
  const filled = pyround((pct / 100) * segs);
  return f(c) + "▮".repeat(filled) + f([90, 95, 120]) + "▯".repeat(segs - filled) +
    f(c) + " " + String(pct).padStart(3) + "%";
}

// A row of glyphs, filled by value: Minecraft-style hearts / food, a power gauge, etc.
// `invert` fills by what is LEFT (100 - pct), so a "used %" metric reads as health.
function rIcons(entry, pct) {
  const count = entry.count ?? 10;
  const v = entry.invert ? 100 - pct : pct;
  const filled = Math.max(0, Math.min(count, pyround((v / 100) * count)));
  const on = colorFor(entry.color || "threshold", v) ?? TEXT;
  const off = colorFor(entry.empty_color, v) ?? [90, 95, 120];
  const glyph = entry.glyph || "■", empty = entry.empty_glyph || glyph;
  const sp = " ".repeat(entry.gap ?? 0); // spaces between glyphs ("♥ ♥ ♥" with gap = 1)
  const cells = Array.from({ length: count }, (_, i) => (i < filled ? f(on) + glyph : f(off) + empty));
  let s = cells.join(sp);
  if (entry.show_pct) s += f(on) + " " + String(v).padStart(3) + "%";
  return s;
}

export function iconsWidth(entry) {
  const count = entry.count ?? 10;
  let w = count * Math.max(vlen(entry.glyph || "■"), vlen(entry.empty_glyph || entry.glyph || "■"))
    + Math.max(0, count - 1) * (entry.gap ?? 0);
  if (entry.show_pct) w += 5;
  if (entry.suffix && entry.suffix in VALUES) w += 1 + vlen(String(VALUES[entry.suffix]));
  return w;
}

// Sparkline glyph tables: rows = left sub-bar height 0..4, cols = right height 0..4.
// Stored as arrays of code points (octants are astral — string[i] would split them).
const SPARK_OCTANT = [
  " ▗▗\u{1cd96}▐",
  "▖▂\u{1cdcb}\u{1cdd3}\u{1cdd5}",
  "▖\u{1cdbb}▄\u{1cde1}▟",
  "\u{1cd48}\u{1cdbf}\u{1cdde}▆\u{1cde5}",
  "▌\u{1cdc0}▙\u{1cde4}█",
].map((r) => [...r]);
const SPARK_BRAILLE = [
  "⠀⢀⢠⢰⢸", "⡀⣀⣠⣰⣸", "⡄⣄⣤⣴⣼", "⡆⣆⣦⣶⣾", "⡇⣇⣧⣷⣿",
].map((r) => [...r]);
const BLOCK_RAMP = [..."▁▂▃▄▅▆▇"];
// The equalizer's OWN 9-level height ramp (empty 0/8 .. full 8/8), so an idle
// channel reads as empty and a maxed one as a full block -- deliberately wider at
// both ends than spark's BLOCK_RAMP, which never shows empty or full. Index via
// pyround(clamp(v,0,1) * 8).
const EQ_RAMP = [..." ▁▂▃▄▅▆▇█"];
export const EQ_MAX = 16; // column cap: more channels than this densify by averaging

function rSpark(values, style = "block", boxRgb = TERM_RGB, vmax = null) {
  const empty = [0, 1, 2].map((i) => Math.floor((boxRgb[i] + TERM_RGB[i]) / 2));
  const bg = sgrBg(empty);
  if (!values || values.length === 0) return f(SPARK);
  let nrm;
  if (vmax) {
    nrm = (v) => Math.max(0, Math.min(1, v / vmax));
  } else {
    const lo = Math.min(...values);
    const span = Math.max(...values) - lo;
    nrm = (v) => (span === 0 ? 0 : (v - lo) / span);
  }
  let body = "";
  if (style === "octant" || style === "braille") {
    const tbl = style === "octant" ? SPARK_OCTANT : SPARK_BRAILLE;
    const h = (v) => pyround(nrm(v) * 4);
    for (let i = 0; i < values.length; i += 2) {
      const r = h(values[i]);
      const c = i + 1 < values.length ? h(values[i + 1]) : 0;
      body += tbl[r][c];
    }
  } else {
    for (let i = 0; i < values.length; i += 2) {
      const v = Math.max(...values.slice(i, i + 2));
      body += BLOCK_RAMP[pyround(nrm(v) * 6)];
    }
  }
  return bg + f(SPARK) + body + bgsgrBox(boxRgb);
}

// Densify N channel values into exactly K = min(N, EQ_MAX) columns by averaging
// each column's contiguous slice. K columns by construction, so the rendered width
// always equals metricFixedWidth's min(N, EQ_MAX) -- the box-layout invariant.
function eqColumns(values) {
  const n = values.length;
  const k = Math.min(n, EQ_MAX);
  const cols = [];
  for (let i = 0; i < k; i++) {
    const lo = Math.floor((i * n) / k), hi = Math.floor(((i + 1) * n) / k);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += values[j];
    cols.push(sum / (hi - lo));
  }
  return cols;
}

// One-row VU-meter: one block column per channel (densified past EQ_MAX), each
// column coloured by its OWN value via the metric's colour spec (default gradient).
// Absolute 0..1 scale (no span-normalize), 9-level EQ_RAMP. Fixed-width: no `cells`.
function rEqualizer(values, boxRgb, colorSpec) {
  if (!values || values.length === 0) return f(SPARK);
  const empty = [0, 1, 2].map((i) => Math.floor((boxRgb[i] + TERM_RGB[i]) / 2));
  let body = sgrBg(empty);
  for (const raw of eqColumns(values)) {
    const v = Math.max(0, Math.min(1, raw));
    body += f(colorFor(colorSpec, v * 100) ?? OK) + EQ_RAMP[pyround(v * 8)];
  }
  return body + bgsgrBox(boxRgb);
}

export function renderValue(entry, cells, boxRgb) {
  const icon = entry.icon || "";
  const label = icon ? icon + " " : "";
  const render = entry.render || "text";
  const color = entry.color;

  if ("group" in entry) {
    const sep = entry.sep ?? " ";
    const parts = entry.group.filter((i) => i in VALUES).map((i) => String(VALUES[i]));
    return label + f(TEXT) + parts.join(sep);
  }
  const val = entry.id in VALUES ? VALUES[entry.id] : "?";
  if (render === "bar") {
    let s = label + rBar(val, cells, boxRgb, color || "threshold", entry.show_pct !== false);
    const sid = entry.suffix;
    if (sid && sid in VALUES) s += f(TEXT) + " " + String(VALUES[sid]);
    return s;
  }
  if (render === "ammo") return label + rAmmo(val, color || "threshold");
  if (render === "icons") {
    let s = label + rIcons(entry, val);
    const sid = entry.suffix;
    if (sid && sid in VALUES) s += f(TEXT) + " " + String(VALUES[sid]);
    return s;
  }
  if (render === "spark") return label + rSpark(val, entry.spark_style || "block", boxRgb, entry.spark_max);
  if (render === "equalizer") return label + rEqualizer(val, boxRgb, color || "threshold");
  if (render === "list") {
    const items = VALUES[entry.id] || [];
    return label + f(TEXT) + items.map((x) => (Array.isArray(x) ? `${x[0]} ${x[1]}` : String(x))).join("  ");
  }
  // number / text
  const col = colorFor(color, parseInt(String(val).replace(/\D/g, "") || "0", 10)) ?? TEXT;
  return label + f(col) + String(val);
}

export function barMeta(entry) {
  const icon = entry.icon || "";
  const lw = vlen(icon ? icon + " " : "");
  const r = entry.render;
  if (r === "bar" || r === "ammo") {
    let sw = entry.show_pct === false ? 0 : 5;
    const sid = entry.suffix;
    if (sid && sid in VALUES) sw += 1 + vlen(String(VALUES[sid]));
    return [lw, sw, r];
  }
  if (r === "icons") { // only reached for stretch icons: the glyph row takes the bar's cells
    let sw = entry.show_pct ? 5 : 0;
    if (entry.suffix && entry.suffix in VALUES) sw += 1 + vlen(String(VALUES[entry.suffix]));
    return [lw, sw, r];
  }
  return [lw, 0, entry.render || "text"];
}
