// Colours the bar's visuals share: colour stops and interpolation, "#rrggbb" specs, and the
// background escape of a surface.

import { TERM_RGB, OK, CRIT, sgrBg } from "./ansi.js";

const WARN = [224, 184, 64];

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
