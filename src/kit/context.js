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

import { SAMPLE } from "./values.js";

export function renderContext({ values = SAMPLE, step = "octant", background = [0, 0, 0], reaction, now,
  tick = 0, overflow } = {}) {
  return { values, step, background, reaction, now, tick, overflow };
}
