// The render context: everything one render reads about its session. renderSession builds one
// per render and passes it to the layout, the planner, the meters and the face loader, so nothing
// about a session lives in module state and sessions rendered in turn cannot see each other's.
//
//   values      the metric values (src/metrics); SAMPLE, the preview data, when none are given
//   step        the glyph step the session's terminal allows for the mugshot
//   background  the mugshot background, [r, g, b], that transparent face areas are fitted against
//   reaction    the session's reaction (src/metrics/reaction.js); unset means calm
//   now         the clock in seconds; unset means no clock (the preview's still face)
//   tick        the marquee phase
//   overflow    how overflowing text fits its box ("scroll" or "clip"); unset defers to the preset
//   indent      the columns Claude Code shifts the status line right, for a layout that centres
//               itself on the terminal
//   presetByName  name -> another parsed preset from the chosen preset's folder, or null; the
//               narrow-width fallback chain loads through it
//
// A game's layout (src/games/index.js) is called as layout(cfg, target, ctx) and returns the lines.

import { SAMPLE } from "./values.js";

const noPreset = () => null;

export function renderContext({ values = SAMPLE, step = "octant", background = [0, 0, 0], reaction, now,
  tick = 0, overflow, indent = 2, presetByName = noPreset } = {}) {
  return { values, step, background, reaction, now, tick, overflow, indent, presetByName };
}
