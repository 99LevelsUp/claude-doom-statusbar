// The fit: a loaded skin (src/kit/skin/load.js), the session's metric values and the terminal's
// width become the tree that is drawn, each element with the columns it gets.
//
// When even the minimum widths do not fit, elements drop by the priority the skin gives them,
// lowest first; of equal priorities the one later in the skin's tree (depth first) drops first. An
// element marked "keep", or given no priority at all, is never dropped on its own account, only
// with its container; the root is never dropped.

import path from "node:path";
import { makeWarning } from "./warnings.js";

const NONE = Object.freeze({ columns: 0, rows: 0 });

// A visual that shows only lists keeps its place when the list is absent.
const keepsPlaceEmpty = (desc) => Array.isArray(desc.accepts) && desc.accepts.length === 1 && desc.accepts[0] === "list";
// An element the skin keeps in the bar while its metric is absent.
const keptAbsent = (node) => node.whenAbsent === "empty" || node.whenAbsent === "full";

const extraOf = (node, count) => (node.frame ? node.frame.descriptor.extra(node.frame.params, count) : NONE);

// The parameters a container lays its children out with. A frame that arranges the children itself
// (a grid) draws its own lines between them, in place of the container's separator.
export function layoutParams(node) {
  return node.frame && node.frame.descriptor.arranges ? { ...node.params, separator: "" } : node.params;
}

// A working copy of the tree that drops can change: { node, parent, order, kids, m }.
function grow(node, parent, counter) {
  const t = { node, parent, order: counter.n++, kids: [], m: null };
  t.kids = node.children.map((c) => grow(c, t, counter));
  return t;
}

// `t` without the elements whose metric is absent, or null when nothing of it is left.
function prune(t, values, absent) {
  const { node } = t;
  if (!node.container) {
    if (node.metric === null || Object.hasOwn(values, node.metric) || keepsPlaceEmpty(node.descriptor) || keptAbsent(node)) return t;
    absent.push(node.id);
    return null;
  }
  const had = t.kids.length;
  t.kids = t.kids.map((k) => prune(k, values, absent)).filter(Boolean);
  if (had && !t.kids.length) {
    absent.push(node.id);
    return null;
  }
  return t;
}

// Minimum and natural width and rows of `t` and everything under it, kept on each node as `m`.
function measure(t) {
  const { node } = t;
  if (!node.container) {
    const w = node.descriptor.widths(node.params);
    t.m = { min: w.min, natural: w.natural, rows: node.descriptor.rows(node.params) };
    return t.m;
  }
  const kids = t.kids.map(measure);
  const p = layoutParams(node);
  const w = node.descriptor.widths(p, kids);
  const extra = extraOf(node, t.kids.length);
  t.m = {
    min: w.min + extra.columns,
    natural: w.natural + extra.columns,
    rows: node.descriptor.rows(p, kids.map((k) => k.rows)) + extra.rows,
  };
  return t.m;
}

// The element to drop next: the lowest priority, of equals the latest in depth-first order.
function nextDrop(root) {
  let best = null;
  const walk = (t) => {
    const pr = t.node.priority;
    if (t !== root && Number.isInteger(pr) &&
      (!best || pr < best.node.priority || (pr === best.node.priority && t.order > best.order))) best = t;
    t.kids.forEach(walk);
  };
  walk(root);
  return best;
}

// Drops `t`, and every container above it that is left without children, up to the root.
function drop(t, root, dropped) {
  let cur = t;
  for (;;) {
    dropped.push(cur.node.id);
    const parent = cur.parent;
    parent.kids = parent.kids.filter((k) => k !== cur);
    if (parent === root || parent.kids.length) return;
    cur = parent;
  }
}

// One skin fitted to `width`: its working tree, whether it fits, and what it lost.
function fitOne(skin, values, width) {
  const absent = [], dropped = [];
  const tree = prune(grow(skin.root, null, { n: 0 }), values, absent);
  if (!tree) return { tree: null, fits: true, dropped, absent };
  // A root whose children have all dropped has nothing left to show: it does not fit.
  const emptied = () => tree.node.container && tree.node.children.length > 0 && tree.kids.length === 0;
  for (;;) {
    measure(tree);
    if (tree.m.min <= width && !emptied()) return { tree, fits: true, dropped, absent };
    const next = nextDrop(tree);
    if (!next) return { tree, fits: false, dropped, absent };
    drop(next, tree, dropped);
  }
}

// The fitted node of `t` at `width` columns, its children given their share.
function place(t, width) {
  const { node } = t;
  if (!node.container) return Object.freeze({ id: node.id, node, width, rows: t.m.rows, children: Object.freeze([]) });
  const extra = extraOf(node, t.kids.length);
  const shares = node.descriptor.share(layoutParams(node), Math.max(0, width - extra.columns), t.kids.map((k) => k.m));
  return Object.freeze({
    id: node.id, node, width, rows: t.m.rows,
    children: Object.freeze(t.kids.map((k, i) => place(k, shares[i]))),
  });
}

function cycleWarning(skin, name) {
  const label = path.basename(skin.file || skin.name || "skin");
  return makeWarning({
    key: [skin.file, "", "smaller-cycle", name].join("|"),
    cause: "smaller-cycle", skin: skin.file, subject: name,
    message: `skin "${label}" names smaller skin "${name}", which is already in its chain; drawn clipped`,
  });
}

// Fits `skin` to `width` columns with the session's `values` (metric id to raw value).
// `loadSmaller(name)` returns the loaded skin of that name, or null when there is none.
export function fitSkin(skin, { values = {}, width, loadSmaller = () => null } = {}) {
  const warnings = [];
  const seen = new Set([skin.name]);
  let current = skin;
  let result = fitOne(skin, values, width);
  while (!result.fits) {
    const name = current.smaller;
    if (!name) break;
    if (seen.has(name)) {
      warnings.push(cycleWarning(current, name));
      break;
    }
    seen.add(name);
    const next = loadSmaller(name);
    if (!next) break;
    seen.add(next.name);
    current = next;
    result = fitOne(next, values, width);
  }
  const { tree, fits, dropped, absent } = result;
  const used = !tree ? 0 : fits ? Math.min(tree.m.natural, width) : tree.m.min;
  return {
    skin: current,
    tree: tree ? place(tree, used) : null,
    width: used,
    clipped: !fits,
    dropped,
    absent,
    warnings,
  };
}
