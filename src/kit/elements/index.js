// The platform's bar elements: one descriptor per element kind, per container frame and per metric
// visual. A skin names an element's kind (a container, or the visual of a metric element), and the
// descriptor says everything about it: its name and meaning, its parameters (src/kit/elements/
// schema.js), the value types it can show, its widths and how it draws. The set grows with the
// platform; games and skins only choose from it.
//
// A metric visual:
//   name, title, description
//   accepts      the value types it can show (src/metrics/catalogue.js)
//   params       its parameter schema
//   validate(given) -> { params, problems }   the parameters to draw with, and what was skipped
//   widths(params) -> { min, natural }         columns, from its parameters only, never its value
//   rows(params)   -> the rows it asks for
//   draw({ value, params, width, height, surface, ctx, script, values }) -> `height` lines, each
//                 exactly `width` columns. `surface` is the background it is drawn on ([r, g, b];
//                 black stands for the terminal's own), `ctx` the render context (tick, step,
//                 resolveAsset, now), `script` what the element's script returned for this render
//                 and `values` all of the session's metric values (the chat says what they are).
//   libraries(params) -> optional: the conversation libraries the script pass runs for the
//                 element (src/kit/skin/scripts.js); their results reach the draw as
//                 `script.conversations`
//
// A container (row, column):
//   params, validate, as above
//   widths(params, children widths) -> { min, natural }
//   share(params, width, children widths) -> each child's width
//   rows(params, children rows) -> rows
//   draw({ params, width, height, children: [{ lines, width }], surface }) -> lines
//
// A frame (box, grid), worn by a container:
//   params, validate, as above
//   layouts      the containers it can frame
//   arranges     true when it draws the children itself instead of the container
//   extra(params, children count) -> { columns, rows } it adds around the children
//   surface(params) -> the background its children are drawn on
//   draw({ params, width, height, content | children, selected }) -> lines

import { CATALOGUE } from "../../metrics/catalogue.js";
import { row, column, box, grid } from "./containers.js";
import { text } from "./text.js";
import { number } from "./number.js";
import { progress } from "./progress.js";
import { sparkline } from "./sparkline.js";
import { equalizer } from "./equalizer.js";
import { iconRow, icon } from "./icon-row.js";
import { scrollList } from "./scroll-list.js";
import { animation, animation3d } from "./animation.js";
import { chat } from "./chat.js";

export { validateParams, PARAM_TYPES } from "./schema.js";
export { PLATFORM_ICONS } from "./icon-row.js";

const byName = (list) => Object.freeze(Object.fromEntries(list.map((d) => [d.name, d])));

export const CONTAINERS = byName([row, column]);
export const FRAMES = byName([box, grid]);
export const VISUALS = byName([text, number, progress, sparkline, equalizer, icon, iconRow, scrollList, chat, animation, animation3d]);

// The descriptor of a skin element's kind: a container or a metric visual, or null.
export function elementKind(name) {
  if (Object.hasOwn(CONTAINERS, name)) return CONTAINERS[name];
  return Object.hasOwn(VISUALS, name) ? VISUALS[name] : null;
}

export const frame = (name) => (Object.hasOwn(FRAMES, name) ? FRAMES[name] : null);

// Whether `visual` can show values of `type`.
export const accepts = (visual, type) => visual.accepts.includes(type);

// Whether `visual` can show the catalogue metric `metricId`: an unknown metric it cannot.
export function canShow(visual, metricId) {
  return Object.hasOwn(CATALOGUE, metricId) && accepts(visual, CATALOGUE[metricId].type);
}
