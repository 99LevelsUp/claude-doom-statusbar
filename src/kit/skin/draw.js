// Drawing a fitted skin (src/kit/skin/fit.js) into the bar's lines.
//
// Every element is drawn by its descriptor (src/kit/elements) at the width the fit gave it. A row
// draws each child at the row's own height, so boxes side by side stand equally tall; a column
// draws each child at the rows it asks for. A container that wears a frame draws its children on
// the frame's background inside it; a frame that arranges its children (a grid) draws them itself,
// with the cell its element's script selects.
//
// The bar is centred in the terminal's width. A bar the fit could not fit is cut at the terminal's
// width instead, its colours reset and an open hyperlink closed.
//
// Scripts are not run here: `scripts` holds what each element's script returned for this render,
// by element id. An element without an entry draws its default visual.
//
// A metric element the fit kept while its metric is absent (`when_absent` "empty" or "full") draws
// a stand-in value; metricValue below says which.

import { RESET, TERM_RGB } from "../ansi.js";
import { vlen } from "../text.js";
import { CATALOGUE } from "../../metrics/catalogue.js";
import { CONTAINERS } from "../elements/index.js";
import { blank } from "../elements/paint.js";

// The value a metric element draws: { value, standIn }.
//   - its metric's value, standIn null, while the session reports the metric;
//   - while it does not, and the element's `when_absent` is "empty" or "full" (the fit kept it), a
//     stand-in value and standIn set to that word. "full" and "empty" say how the visual looks, not
//     what the metric measures: "full" is a bar filled to its end and every glyph of a row lit,
//     "empty" the opposite, whether the metric counts what is used (context.hp, ratelimit.5h) or
//     what is left (health.headroom). The stand-in of a percentage is the descriptor contract's
//     (src/kit/elements/index.js). For any other value type there is no stand-in value
//     (undefined), and every visual draws that as it draws a missing value: blank text and
//     numbers, no icons, an empty graph or list, an animation's default frame;
//   - otherwise undefined, standIn null.
export function metricValue(node, values) {
  if (node.metric === null || node.metric === undefined) return { value: undefined, standIn: null };
  if (Object.hasOwn(values, node.metric)) return { value: values[node.metric], standIn: null };
  const mode = node.whenAbsent;
  if (mode !== "empty" && mode !== "full") return { value: undefined, standIn: null };
  let value;
  if (Object.hasOwn(CATALOGUE, node.metric) && CATALOGUE[node.metric].type === "percentage") {
    value = typeof node.descriptor.standIn === "function" ? node.descriptor.standIn(node.params, mode) : mode === "full" ? 100 : 0;
  }
  return { value, standIn: mode };
}

// An SGR sequence, or an OSC 8 hyperlink sequence with its address captured (empty when it closes
// a link).
const ESCAPE = /\x1b\[[0-9;]*m|\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x1b\\|\x07)/y;
const CLOSE_LINK = "\x1b]8;;\x1b\\";

// `line` cut to `width` columns. Escape sequences take no columns and are kept, a wide glyph that
// would cross the edge is left out, and a cut line ends with an open link closed and the colours
// reset. A line that fits is returned as it is.
export function clipLine(line, width) {
  if (vlen(line) <= width) return line;
  let out = "", col = 0, i = 0, linkOpen = false;
  while (i < line.length) {
    ESCAPE.lastIndex = i;
    const m = ESCAPE.exec(line);
    if (m) {
      out += m[0];
      if (m[1] !== undefined) linkOpen = m[1] !== "";
      i = ESCAPE.lastIndex;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i));
    const cw = vlen(ch);
    if (col + cw > width) break;
    out += ch;
    col += cw;
    i += ch.length;
  }
  return out + (linkOpen ? CLOSE_LINK : "") + RESET;
}

// The lines of the fitted node `t`, `height` rows tall, on the background `surface`.
function drawNode(t, height, surface, env) {
  const { node } = t;
  const script = Object.hasOwn(env.scripts, t.id) ? env.scripts[t.id] : null;
  if (!node.container) {
    const { value } = metricValue(node, env.values);
    return node.descriptor.draw({ value, params: node.params, width: t.width, height, surface, ctx: env.ctx, script: script ?? {}, values: env.values });
  }
  const f = node.frame;
  const extra = f ? f.descriptor.extra(f.params, t.children.length) : { columns: 0, rows: 0 };
  const innerWidth = Math.max(0, t.width - extra.columns);
  const innerHeight = Math.max(0, height - extra.rows);
  const inner = f ? f.descriptor.surface(f.params) : surface;
  const sideBySide = node.descriptor === CONTAINERS.row;
  const children = t.children.map((k) => ({
    lines: drawNode(k, sideBySide ? innerHeight : k.rows, inner, env),
    width: k.width,
  }));
  if (f && f.descriptor.arranges) {
    return f.descriptor.draw({ params: f.params, width: t.width, height, children, selected: script?.selected });
  }
  const content = node.descriptor.draw({ params: node.params, width: innerWidth, height: innerHeight, children, surface: inner });
  return f ? f.descriptor.draw({ params: f.params, width: t.width, height, content }) : content;
}

// The bar's lines for `fit` in a terminal `width` columns wide. `values` are the session's metric
// values, `ctx` the render context the visuals read (tick, step, resolveAsset), `scripts` each
// element's script output by element id.
export function drawFit(fit, { values = {}, width, ctx = {}, scripts = {} } = {}) {
  if (!fit.tree) return [];
  const lines = drawNode(fit.tree, fit.tree.rows, TERM_RGB, { values, ctx, scripts });
  if (fit.width > width) return lines.map((l) => clipLine(RESET + l + RESET, width));
  const outer = blank(Math.floor((width - fit.width) / 2));
  return lines.map((l) => RESET + outer + l + RESET);
}
