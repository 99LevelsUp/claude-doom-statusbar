// Containers and their frames.
//
// A container lays out its children side by side (row) or one under another (column), and decides
// how its children shrink when the width runs short (`shrink`), what they do with width to spare
// (`grow`), and what it does itself when nothing under it has anything to show (`when_empty`, which
// the fit applies). It may wear a frame:
//
//   box   a titled box on a background, the children padded inside it
//   grid  a cell per child with lines between and around the cells; one selected cell, chosen by a
//         script, is drawn with its own lines and colour (a hotbar)
//
// A container draws children that are already drawn: each child is { lines, width }, its lines
// exactly `width` columns wide. A frame that `arranges` its children (the grid) draws them itself
// in place of the container, and its lines replace the container's separator; any other frame (the
// box) wraps the container's own arrangement, given as `content`.

import { TERM_RGB, RESET, BOLD, sgrFg } from "../ansi.js";
import { vlen } from "../text.js";
import { rgbOf, bgOf, bgsgrBox } from "../colors.js";
import { define, param } from "./schema.js";
import { block, blank, fitText } from "./paint.js";

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const childAlignParam = () => param("text", "start", "Where the children sit when the container is wider than they are", { allowed: ["start", "center", "end"] });
// The fit reads these two (src/kit/skin/fit.js); emptiness is defined there, in isEmptyNode.
const whenEmptyParam = () => param("text", "keep",
  "What the container does when nothing under it has anything to show: keep its width, shrink to its minimum (a box to its title) without drawing its children, or hide from the bar so its space goes to the others",
  { allowed: ["keep", "shrink", "hide"] });
const growParam = (what) => param("text", "none", what, { allowed: ["none", "fill"] });

// The most columns a child can use: its `max`, unbounded when it gives none.
const maxOf = (k) => k.max ?? Infinity;

// `ws` widened by `surplus` columns shared evenly among the children that can still grow, each up
// to its most; an odd column goes to the earliest child that can take it.
function spread(ws, kids, surplus) {
  const out = [...ws];
  let left = surplus;
  for (;;) {
    const open = out.map((w, i) => i).filter((i) => out[i] < maxOf(kids[i]));
    if (left <= 0 || !open.length) return out;
    const each = Math.floor(left / open.length);
    if (each === 0) {
      for (const i of open.slice(0, left)) out[i]++;
      return out;
    }
    for (const i of open) {
      const add = Math.min(each, maxOf(kids[i]) - out[i]);
      out[i] += add;
      left -= add;
    }
  }
}

function leftRoom(room, align) {
  if (align === "center") return Math.floor(room / 2);
  return align === "end" ? room : 0;
}

// Widths for children { min, natural } sharing `avail` columns. In lockstep every child shrinks by
// the same share of its own range; from the start or the end, children shrink one after another to their minimum. Children that cannot all fit are
// left at their minimum: dropping elements is the fit's decision, not the container's.
function shrink(kids, avail, how) {
  const nat = kids.map((k) => k.natural);
  if (sum(nat) <= avail) return nat;
  const ranges = kids.map((k) => Math.max(0, k.natural - k.min));
  if (how === "lockstep") {
    const span = Math.max(0, ...ranges);
    for (let s = span; s >= 0; s--) {
      const ws = kids.map((k, i) => k.min + (span ? Math.floor((ranges[i] * s) / span) : 0));
      if (sum(ws) <= avail) return ws;
    }
    return kids.map((k) => k.min);
  }
  const ws = [...nat];
  const order = kids.map((_, i) => i);
  if (how === "end") order.reverse();
  let over = sum(ws) - avail;
  for (const i of order) {
    if (over <= 0) break;
    const cut = Math.min(ranges[i], over);
    ws[i] -= cut;
    over -= cut;
  }
  return ws;
}

const fgOf = (spec) => (spec === "term-fg" ? "\x1b[39m" : sgrFg(rgbOf(spec)));

export const row = define({
  name: "row",
  title: "Row",
  description: "Lays its children out side by side",
  params: {
    separator: param("text", "", "Characters drawn between children"),
    separator_color: param("color", "term-fg", "Colour of the separator", { keywords: ["term-fg"] }),
    separator_background: param("color", "term-bg", "Background of the separator", { keywords: ["term-bg"] }),
    align: childAlignParam(),
    shrink: param("text", "lockstep", "How children shrink when the width runs short: all together, from the start, or from the end", { allowed: ["lockstep", "start", "end"] }),
    grow: growParam("What the row does with width it has to spare: none leaves it to `align`; fill shares it evenly among the children that can grow, each up to the most it can use"),
    center: param("text", "",
      "The id of a child that sits in the middle of the row, the children before it at the row's start and those after it right behind it; when they leave no room for that, the children sit side by side. The bar's root row with a centre takes the terminal's whole width"),
    when_empty: whenEmptyParam(),
  },
  widths: (p, kids) => {
    const seps = vlen(p.separator) * Math.max(0, kids.length - 1);
    return { min: sum(kids.map((k) => k.min)) + seps, natural: sum(kids.map((k) => k.natural)) + seps };
  },
  share: (p, width, kids) => {
    const avail = width - vlen(p.separator) * Math.max(0, kids.length - 1);
    const ws = shrink(kids, avail, p.shrink);
    return p.grow === "fill" ? spread(ws, kids, avail - sum(ws)) : ws;
  },
  rows: (p, kidRows) => Math.max(0, ...kidRows),
  // `ids` are the children's element ids, in order, for `center`.
  draw({ params: p, width, height, children, ids = [], surface = TERM_RGB }) {
    const sep = p.separator ? bgOf(p.separator_background) + fgOf(p.separator_color) + p.separator + bgsgrBox(surface) : "";
    const sepW = vlen(p.separator);
    const used = sum(children.map((c) => c.width)) + sepW * Math.max(0, children.length - 1);
    const room = Math.max(0, width - used);
    const lineOf = (c, r) => c.lines[r] ?? blank(c.width);
    const at = p.center ? ids.indexOf(p.center) : -1;
    if (at >= 0) {
      // The children before the centre at the start, the centre in the middle of the row when
      // they leave room for it, the rest right behind it.
      const before = children.slice(0, at);
      const beforeW = sum(before.map((c) => c.width)) + sepW * before.length;
      const start = Math.max(beforeW, Math.floor((width - children[at].width) / 2));
      const gap = start - beforeW;
      return Array.from({ length: height }, (_, r) => {
        const head = before.map((c) => lineOf(c, r) + sep).join("");
        const tail = children.slice(at).map((c) => lineOf(c, r)).join(sep);
        return head + blank(gap) + tail + blank(Math.max(0, room - gap));
      });
    }
    const left = leftRoom(room, p.align);
    return Array.from({ length: height }, (_, r) =>
      blank(left) + children.map((c) => lineOf(c, r)).join(sep) + blank(room - left));
  },
});

export const column = define({
  name: "column",
  title: "Column",
  description: "Lays its children out one under another",
  params: {
    align: childAlignParam(),
    grow: growParam("How wide each child is: none keeps its own width, placed by `align`; fill gives it the column's whole width, up to the most it can use (a visual that cannot grow keeps its width and `align` places it)"),
    when_empty: whenEmptyParam(),
  },
  widths: (p, kids) => ({ min: Math.max(0, ...kids.map((k) => k.min)), natural: Math.max(0, ...kids.map((k) => k.natural)) }),
  share: (p, width, kids) => kids.map((k) => Math.max(k.min, Math.min(width, p.grow === "fill" ? maxOf(k) : k.natural))),
  rows: (p, kidRows) => sum(kidRows),
  draw({ params: p, width, height, children }) {
    const lines = children.flatMap((c) => {
      const room = Math.max(0, width - c.width);
      const left = leftRoom(room, p.align);
      return c.lines.map((l) => blank(left) + l + blank(room - left));
    });
    return block(lines, width, height);
  },
});

const surfaceOf = (spec) => (spec === "term-bg" ? TERM_RGB : rgbOf(spec));

export const box = define({
  name: "box",
  title: "Box",
  description: "A box on a background with a centred title row above its children",
  layouts: ["row", "column"],
  arranges: false,
  params: {
    title: param("text", "", "The title"),
    header: param("boolean", true, "Draw the title row"),
    title_color: param("color", "#deca80", "Colour of the title"),
    background: param("color", "term-bg", "Background of the box", { keywords: ["term-bg"] }),
    padding: param("integer", 1, "Columns of background on each side of the children", { min: 0 }),
  },
  extra: (p) => ({ columns: 2 * p.padding, rows: p.header ? 1 : 0 }),
  // A box is never narrower than its title row, so its title is never clipped.
  minWidth: (p) => (p.header ? vlen(p.title) + 2 * p.padding : 0),
  surface: (p) => surfaceOf(p.background),
  draw({ params: p, width, height, content }) {
    const bg = bgsgrBox(surfaceOf(p.background));
    const inner = Math.max(0, width - 2 * p.padding);
    const side = blank(p.padding);
    const lines = [];
    if (p.header) {
      lines.push(bg + BOLD + sgrFg(rgbOf(p.title_color)) + side + fitText(p.title, inner, { align: "center" }) + side + RESET);
    }
    for (const l of content) lines.push(bg + side + l + side + RESET);
    while (lines.length < height) lines.push(bg + blank(width) + RESET);
    return lines.slice(0, height);
  },
});

const GRID_LINES = "┏━┳┓┃┗┻┛";
// Positions in a grid's line characters.
const TOP_LEFT = 0, HORIZONTAL = 1, TOP_JOINT = 2, TOP_RIGHT = 3, VERTICAL = 4, BOTTOM_LEFT = 5, BOTTOM_JOINT = 6, BOTTOM_RIGHT = 7;

export const grid = define({
  name: "grid",
  title: "Grid",
  description: "A cell per child with lines between and around the cells; the selected cell has its own lines and colour",
  layouts: ["row"],
  arranges: true,
  params: {
    lines: param("text", GRID_LINES, "Line characters: top-left corner, horizontal line, top joint, top-right corner, vertical line, bottom-left corner, bottom joint, bottom-right corner", { length: 8 }),
    selected_lines: param("text", GRID_LINES, "Line characters around the selected cell, in the same order", { length: 8 }),
    line_color: param("color", "#8b8b8b", "Colour of the lines"),
    selected_color: param("color", "#ffffff", "Colour of the lines around the selected cell"),
    background: param("color", "#262626", "Background of the cells", { keywords: ["term-bg"] }),
  },
  extra: (p, count) => ({ columns: count + 1, rows: 2 }),
  minWidth: () => 0,
  surface: (p) => surfaceOf(p.background),
  // `selected` is the index of the selected cell; any other value selects none.
  draw({ params: p, width, height, children, selected: chosen = -1 }) {
    const n = children.length;
    const selected = Number.isInteger(chosen) && chosen >= 0 && chosen < n ? chosen : null;
    const plain = [...p.lines], picked = [...p.selected_lines];
    const lineFg = sgrFg(rgbOf(p.line_color)), pickedFg = sgrFg(rgbOf(p.selected_color));
    // The line left of cell k belongs to the selected cell when cell k or the one before it is.
    const edgeSel = (k) => k === selected || k - 1 === selected;
    const edge = (k, at) => (edgeSel(k) ? pickedFg + picked[at] : lineFg + plain[at]);
    const across = (k) => (k === selected ? pickedFg + picked[HORIZONTAL].repeat(children[k].width)
      : lineFg + plain[HORIZONTAL].repeat(children[k].width));
    const used = sum(children.map((c) => c.width)) + n + 1;
    const tail = blank(width - used);
    // A joint beside the selected cell is drawn as that cell's corner, without the plain cell's
    // half of the line: a joint glyph has one colour, so its far half would wear the wrong one.
    const jointAt = (k, left, joint, right) => (k === 0 ? left : k === selected ? left : k - 1 === selected ? right : joint);
    const rule = (left, joint, right) => {
      let s = "";
      for (let k = 0; k < n; k++) s += edge(k, jointAt(k, left, joint, right)) + across(k);
      return s + edge(n, right) + RESET + tail;
    };
    const cellBg = bgOf(p.background);
    const lines = [rule(TOP_LEFT, TOP_JOINT, TOP_RIGHT)];
    for (let r = 0; r < height - 2; r++) {
      let s = "";
      for (let k = 0; k < n; k++) s += RESET + edge(k, VERTICAL) + cellBg + (children[k].lines[r] ?? blank(children[k].width));
      lines.push(s + RESET + edge(n, VERTICAL) + RESET + tail);
    }
    lines.push(rule(BOTTOM_LEFT, BOTTOM_JOINT, BOTTOM_RIGHT));
    return lines;
  },
});
