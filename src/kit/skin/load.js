// The skin loader: a TOML skin file becomes a tree of elements, each checked against its descriptor
// (src/kit/elements) and each bound metric against the catalogue (src/metrics/catalogue.js).
//
// A skin file:
//   version   the format version (a whole number)
//   name      the skin's name; the file name without .toml when absent
//   games     the games whose assets the skin uses
//   root      the id of the element the bar starts from
//   smaller   the name of the skin to switch to when this one does not fit
//   [element.<id>]   one table per element, keyed by id
//
// An element table holds the element's `kind` (a container, or the visual of a metric element), the
// settings every element shares, and the parameters of its kind's descriptor. The shared settings:
//   metric    the catalogue id a metric element shows
//   priority  a whole number (the lowest is dropped first when the bar is too narrow), or "keep";
//             the loader keeps it as written, and leaves what no priority means to the fit
//   script    a script asset the element runs each render
//   when_absent  what a metric element does while the session does not report its metric:
//             "hide" (the default) leaves it out of the bar; "empty" and "full" keep it at its
//             widths and draw it with a stand-in value (src/kit/skin/draw.js). Containers have none.
//   children  a container's child ids, in the order they are drawn
//   frame     the frame a container wears: { kind = "box" | "grid", ...its parameters }
// A shared setting a descriptor declares as its own parameter (an animation's `script`) also reaches
// that descriptor. Asset references stay the strings the skin wrote; resolving them is not the
// loader's work.
//
// Nothing that no longer holds stops the rest of the skin from loading:
//   - an unknown or invalid parameter is ignored (an invalid one keeps its default), the element stays;
//   - an unknown frame, or one that cannot frame the element, is dropped, the element stays;
//   - an element without a kind, of an unknown kind, binding an unknown metric, or binding a metric
//     its visual cannot show is skipped with everything under it;
//   - a child id no element has, or one already in the tree (listed twice, or a cycle), is skipped.
// Each such part adds one warning. A skin with nothing left to draw (it cannot be read or parsed, or
// its root is missing or skipped) gives way to the default skin the caller names.
//
// A warning: { key, cause, skin, element, subject, message }
//   cause    unreadable, parse-error, no-root, unknown-key, invalid-key, no-kind, unknown-kind,
//            unknown-metric, type-mismatch, missing-child, duplicate-child, unknown-param,
//            invalid-param, unknown-frame
//   skin     the file the warning is about; element the element id or null; subject the parameter,
//            child, metric, kind or frame involved, or null
//   key      the same cause in the same place gives the same key on every load
//   message  one line for the person reading the bar, naming the skin file
//
// A loaded skin: { file, name, version, games, smaller, root }, root an element node:
//   { id, kind, container, descriptor, params, metric, priority, script, whenAbsent, frame, children }
//   container   true for a row or column, false for a metric element
//   params      the descriptor's validated parameters, defaults filled in
//   metric      the bound catalogue id, or null (a metric element may bind none)
//   priority    a whole number, "keep", or null when the skin gives none
//   script      the script reference as written, or null
//   whenAbsent  "hide", "empty" or "full"; "hide" for a container and whenever the skin gives none
//   frame       { kind, descriptor, params } or null
//   children    element nodes; a metric element has none
// Loaded skins are cached and shared by every render, so the tree is frozen.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { CATALOGUE } from "../../metrics/catalogue.js";
import { elementKind, frame as frameKind, canShow } from "../elements/index.js";
import { makeWarning } from "./warnings.js";
import { isPlainObject } from "../is.js";

const TOP_KEYS = ["version", "name", "games", "root", "smaller", "element"];
const SHARED = ["kind", "metric", "priority", "script", "when_absent", "children", "frame"];
const WHEN_ABSENT = ["hide", "empty", "full"];

const isTable = (v) => isPlainObject(v) && !(v instanceof Date);
const isNames = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const firstLine = (s) => String(s).split(/\r?\n/).find((l) => l.trim()) || "";

// Collects the warnings of one skin file.
function warner(file) {
  const label = path.basename(file || "skin");
  const list = [];
  const add = (cause, element, subject, text) => {
    const where = element === null ? "" : `, element "${element}":`;
    list.push(makeWarning({
      key: [file, element ?? "", cause, subject ?? ""].join("|"),
      cause, skin: file, element, subject,
      message: `skin "${label}"${where} ${text}`,
    }));
  };
  return { list, add };
}

// The skin's own settings, each checked; a wrong one is reported and left at its default.
function settings(data, file, add) {
  for (const k of Object.keys(data)) if (!TOP_KEYS.includes(k)) add("unknown-key", null, k, `has unknown setting "${k}"; ignored`);
  const check = (k, valid, def, must) => {
    if (!Object.hasOwn(data, k)) return def;
    if (valid(data[k])) return data[k];
    add("invalid-key", null, k, `setting "${k}" must be ${must}; ignored`);
    return def;
  };
  return {
    version: check("version", Number.isInteger, null, "a whole number"),
    name: check("name", (v) => typeof v === "string", path.basename(file || "skin", ".toml"), "a name"),
    games: check("games", isNames, [], "a list of game names"),
    smaller: check("smaller", (v) => typeof v === "string", null, "a skin name"),
  };
}

// The frame a container wears, or null.
function frameOf(id, spec, layout, add) {
  if (!isTable(spec)) {
    add("invalid-param", id, "frame", `parameter "frame" must be a table with a kind; ignored`);
    return null;
  }
  const { kind, ...given } = spec;
  const f = typeof kind === "string" ? frameKind(kind) : null;
  if (!f) {
    add("unknown-frame", id, typeof kind === "string" ? kind : null,
      typeof kind === "string" ? `has unknown frame "${kind}"; ignored` : "has a frame without a kind; ignored");
    return null;
  }
  if (!f.layouts.includes(layout)) {
    add("unknown-frame", id, kind, `frame "${kind}" cannot frame a ${layout}; ignored`);
    return null;
  }
  const { params, problems } = f.validate(given);
  for (const p of problems) add(`${p.problem}-param`, id, `frame.${p.param}`, `frame: ${p.message}; ignored`);
  return Object.freeze({ kind, descriptor: f, params: Object.freeze(params) });
}

// Builds the element `id` and everything under it, or returns null when it is skipped. `seen`
// holds every id already in the tree.
function build(id, elements, seen, add) {
  seen.add(id);
  const el = elements[id];
  if (!isTable(el) || typeof el.kind !== "string") {
    add("no-kind", id, null, "has no kind; skipped");
    return null;
  }
  const desc = elementKind(el.kind);
  if (!desc) {
    add("unknown-kind", id, el.kind, `has unknown kind "${el.kind}"; skipped`);
    return null;
  }
  const container = !desc.accepts;
  let metric = null;
  if (!container && Object.hasOwn(el, "metric")) {
    const m = el.metric;
    if (typeof m !== "string" || !Object.hasOwn(CATALOGUE, m)) {
      add("unknown-metric", id, String(m), `binds unknown metric "${String(m)}"; skipped`);
      return null;
    }
    if (!canShow(desc, m)) {
      add("type-mismatch", id, m, `kind "${el.kind}" cannot show metric "${m}" (${CATALOGUE[m].type}); skipped`);
      return null;
    }
    metric = m;
  }

  const unknown = (k) => add("unknown-param", id, k, `unknown parameter "${k}"; ignored`);
  const invalid = (k, must) => add("invalid-param", id, k, `parameter "${k}" must be ${must}; ignored`);
  if (container && Object.hasOwn(el, "metric")) unknown("metric");

  let priority = null;
  if (Object.hasOwn(el, "priority")) {
    if (Number.isInteger(el.priority) || el.priority === "keep") priority = el.priority;
    else invalid("priority", `a whole number or "keep"`);
  }

  let script = null;
  if (Object.hasOwn(el, "script")) {
    if (typeof el.script === "string") script = el.script;
    else invalid("script", "a script reference");
  }

  let whenAbsent = "hide";
  if (Object.hasOwn(el, "when_absent")) {
    if (container) unknown("when_absent");
    else if (WHEN_ABSENT.includes(el.when_absent)) whenAbsent = el.when_absent;
    else invalid("when_absent", `"hide", "empty" or "full"`);
  }

  let childIds = [];
  if (Object.hasOwn(el, "children")) {
    if (!container) unknown("children");
    else if (isNames(el.children)) childIds = el.children;
    else invalid("children", "a list of element ids");
  }

  let frame = null;
  if (Object.hasOwn(el, "frame")) {
    if (!container) unknown("frame");
    else frame = frameOf(id, el.frame, el.kind, add);
  }

  const given = {};
  for (const [k, v] of Object.entries(el)) {
    if (!SHARED.includes(k) || (Object.hasOwn(desc.params, k) && (k !== "script" || script !== null))) given[k] = v;
  }
  const { params, problems } = desc.validate(given);
  for (const p of problems) add(`${p.problem}-param`, id, p.param, `${p.message}; ignored`);

  const children = [];
  for (const c of childIds) {
    if (!Object.hasOwn(elements, c)) {
      add("missing-child", id, c, `lists child "${c}", which no element has; skipped`);
    } else if (seen.has(c)) {
      add("duplicate-child", id, c, `lists child "${c}", which is already in the skin; skipped`);
    } else {
      const node = build(c, elements, seen, add);
      if (node) children.push(node);
    }
  }

  return Object.freeze({
    id, kind: el.kind, container, descriptor: desc, params: Object.freeze(params),
    metric, priority, script, whenAbsent, frame, children: Object.freeze(children),
  });
}

// Builds a skin from parsed TOML `data`. `file` names the skin in its warnings. The skin is null
// when nothing of it can be drawn.
export function buildSkin(data, file = null) {
  const { list, add } = warner(file);
  if (!isTable(data)) {
    add("parse-error", null, null, "is not a table of settings");
    return { skin: null, warnings: list };
  }
  const own = settings(data, file, add);
  const elements = isTable(data.element) ? data.element : {};
  if (Object.hasOwn(data, "element") && !isTable(data.element)) add("invalid-key", null, "element", `setting "element" must be a table of elements; ignored`);
  let root = null;
  if (typeof data.root !== "string") {
    add("no-root", null, null, "names no root element; nothing to draw");
  } else if (!Object.hasOwn(elements, data.root)) {
    add("no-root", null, data.root, `has no root element "${data.root}"; nothing to draw`);
  } else {
    root = build(data.root, elements, new Set(), add);
    if (!root) add("no-root", null, data.root, `lost its root element "${data.root}"; nothing to draw`);
  }
  const skin = root ? Object.freeze({ file, ...own, games: Object.freeze([...own.games]), root }) : null;
  return { skin, warnings: list };
}

// Loaded skins by file, loaded again when the file's size or mtime changes.
const cache = new Map();

// One skin file, through the cache: { skin, warnings }, skin null when nothing of it can be drawn.
function loadFile(file) {
  let st;
  try {
    st = statSync(file);
  } catch (e) {
    const { list, add } = warner(file);
    add("unreadable", null, null, `cannot be read (${e.code || firstLine(e.message)})`);
    return { skin: null, warnings: list };
  }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.result;
  let result;
  try {
    result = buildSkin(parseToml(readFileSync(file, "utf8")), file);
  } catch (e) {
    const { list, add } = warner(file);
    add(e.code ? "unreadable" : "parse-error", null, null,
      e.code ? `cannot be read (${e.code})` : `does not parse: ${firstLine(e.message)}`);
    result = { skin: null, warnings: list };
  }
  cache.set(file, { key, result });
  return result;
}

// Loads the skin `file`. When nothing of it can be drawn, the skin at `fallback` (the default skin
// the caller chooses) loads in its place, its warnings after the ones that say why. `skin` is null
// when neither can be drawn; `warnings` is a new array on every call.
export function loadSkin(file, { fallback = null } = {}) {
  const own = loadFile(file);
  if (own.skin || !fallback || path.resolve(fallback) === path.resolve(file)) return { skin: own.skin, warnings: [...own.warnings] };
  const def = loadFile(fallback);
  return { skin: def.skin, warnings: [...own.warnings, ...def.warnings] };
}
