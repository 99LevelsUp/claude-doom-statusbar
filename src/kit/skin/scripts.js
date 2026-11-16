// Scripts in the render pass: after the fit (src/kit/skin/fit.js), every drawn element that names a
// script is run, all of a session's scripts in one batch through the script host
// (src/platform/scripts/host.js), and what they return changes how those elements look before they
// are drawn (src/kit/skin/draw.js). A script never changes an element's size: every element is
// drawn at the columns and rows the fit gave it, and what a script makes wider is cut there.
//
// Where a script comes from. A path the skin writes is read from the skin's own folder (a user
// skin's folder, a bundled skin's game folder); one that leads outside it is refused with a
// warning and never run. A reference to a game's asset (`<game>:<path>`) is found by the render
// context's resolveAsset; while it cannot be found the element draws its default, and the missing
// asset is the asset store's to report.
//
// What a script gets, as the argument of its `render(input)`:
//   value     its element's metric value, raw as the catalogue gives it (null without a metric, and
//             null while the session does not report it)
//   standIn   null while the value is the metric's own; "empty" or "full" while the session does not
//             report the metric and the element draws a stand-in in its place (its `when_absent`,
//             src/kit/skin/draw.js)
//   metric    the metric id, or null
//   params    its element's parameters, as the skin set them
//   reaction  the session's game-neutral reaction (src/metrics/reaction.js); it travels as JSON,
//             so an age that is Infinity arrives as null
//   now       the time in seconds; `tick` the render tick
//   width     the columns the fit gave the element; `rows` its rows
//   children  a container's drawn children: [{ id, metric, value, standIn, width }], in order
//   state     what the script returned as `state` the last time it ran for this element in this
//             session ({} the first time, and again whenever the skin or the script changes)
//
// What it returns (anything else is ignored):
//   frame     the frame an animation draws, by name
//   selected  the index of the child a grid selects, among `children`
//   params    parameters drawn instead of the skin's this render: characters, colours, icons. A
//             value the element's visual does not accept keeps the skin's. On a container they
//             change its frame, except any that would change the frame's size.
//   state     kept for the next run (it is the only way back: the input reaches the script as a
//             copy)
//
// A chat's conversation libraries (src/kit/elements/chat.js) run in the same batch: each library's
// `conversations(facts)` gets the session's facts (src/kit/chat/metrics-library.js), and what the
// libraries return reaches the chat as `conversations`, in the order the skin names them. A library
// that fails is left out of the chat, with a warning naming it.
//
// A script that throws or runs past its budget leaves its element on its default visual and puts a
// warning under the bar, and the host keeps it off until its file or its skin changes. When the pass
// has no time left for a session, that session's elements draw their defaults for this render only:
// no warning, nothing turned off.

import { statSync } from "node:fs";
import path from "node:path";
import { vlen } from "../text.js";
import { clipLine, metricValue } from "./draw.js";
import { blank } from "../elements/paint.js";
import { createScriptHost } from "../../platform/scripts/host.js";
import { facts } from "../chat/metrics-library.js";

export const CALL_BUDGET_MS = 20;
export const PASS_BUDGET_MS = 200;

// The time scripts get in one render pass, shared by every session the pass renders. Each batch
// gets the smaller of what is left and `callBudgetMs` per script. Only the time spent running
// batches counts (a worker's restart and start-up included), not the rest of each session's render,
// and it is measured on the real clock, whatever time the render draws.
export function createScriptPass({ budgetMs = PASS_BUDGET_MS, callBudgetMs = CALL_BUDGET_MS } = {}) {
  let spent = 0;
  return { callBudgetMs, left: () => budgetMs - spent, spend: (ms) => { spent += ms; } };
}

// A host for callers that bring none, made when a script first needs it. Its worker does not keep
// the process alive.
let shared = null;
export const sharedScriptHost = () => (shared ??= createScriptHost());

const stampOf = (file) => {
  try { const st = statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return "missing"; }
};

// A game asset reference: a game's name, a colon, a path. A drive letter is not a game's name.
const ASSET_REF = /^[A-Za-z0-9][A-Za-z0-9_-]+:/;

// The file a script reference names: { file } (null while an asset cannot be found), or
// { outside: true } for a path that leads out of `folder`.
export function resolveScript(ref, folder, resolveAsset) {
  if (ASSET_REF.test(ref)) return { file: typeof resolveAsset === "function" ? resolveAsset(ref) || null : null };
  const file = path.resolve(folder, ref);
  const rel = path.relative(folder, file);
  if (path.isAbsolute(ref) || rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { outside: true };
  return { file };
}

// Lines of an element drawn by a visual whose parameters a script changed: exactly `width` columns
// and `height` rows, whatever the parameters made of them.
function fitted(lines, width, height) {
  const out = lines.slice(0, height).map((l) => {
    const w = vlen(l);
    return w > width ? clipLine(l, width) : w < width ? l + blank(width - w) : l;
  });
  while (out.length < height) out.push(blank(width));
  return out;
}

// `given` laid over `own`, each value checked by `descriptor`; one it refuses keeps `own`'s.
function overParams(descriptor, own, given) {
  const { params, problems } = descriptor.validate({ ...own, ...given });
  const out = { ...params };
  for (const p of problems) if (Object.hasOwn(own, p.param)) out[p.param] = own[p.param];
  return Object.freeze(out);
}

const sameExtra = (a, b) => a.columns === b.columns && a.rows === b.rows;

// The node `t` draws with the parameters `given` instead of its own.
function withParams(t, given) {
  const { node } = t;
  if (!node.container) {
    const desc = node.descriptor;
    const descriptor = Object.freeze({ ...desc, draw: (a) => fitted(desc.draw(a), a.width, a.height) });
    return Object.freeze({ ...node, descriptor, params: overParams(desc, node.params, given) });
  }
  const f = node.frame;
  if (!f) return node;
  const params = overParams(f.descriptor, f.params, given);
  const n = t.children.length;
  if (!sameExtra(f.descriptor.extra(params, n), f.descriptor.extra(f.params, n))) return node;
  return Object.freeze({ ...node, frame: Object.freeze({ ...f, params }) });
}

// The fitted tree with the nodes in `nodes` (fitted node -> replacement) swapped in.
function rebuild(t, nodes) {
  const children = t.children.map((k) => rebuild(k, nodes));
  const node = nodes.get(t) ?? t.node;
  if (node === t.node && children.every((k, i) => k === t.children[i])) return t;
  return Object.freeze({ ...t, node, children: Object.freeze(children) });
}

// Why each failed script failed, by its warning's key, for as long as this process lives.
const reasons = new Map();

// The conversation libraries a drawn element names (a chat's), or none.
const librariesOf = (node) => (!node.container && typeof node.descriptor.libraries === "function" ? node.descriptor.libraries(node.params) : []);

const valueOf = (node, values) => (node.metric !== null && Object.hasOwn(values, node.metric) ? values[node.metric] : null);
const standInOf = (node, values) => (node.container ? null : metricValue(node, values).standIn);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Runs the scripts of the drawn elements of `fit` and returns what to draw:
//   { fit, scripts, warnings }
//   fit       `fit`, with the elements whose parameters a script changed swapped in (`fit` itself
//             when no script changed any)
//   scripts   element id -> what its script returned, for drawFit
//   warnings  in the loader's form: { key, cause, skin, element, subject, message }
// options:
//   host          the script host; by default one shared by this process
//   pass          the pass the time comes from (createScriptPass); by default one of this render's own
//   state         this session's script state: a Map the caller keeps between renders
//   values, reaction, now, tick   the session's render
//   folderOf(skin)  the folder the skin's own script paths are read from; by default its file's
//   resolveAsset    finds a game asset's file, or null
export function runScripts(fit, { host, pass = createScriptPass(), state = new Map(), values = {}, reaction = null, now = 0, tick = 0,
  folderOf = (skin) => path.dirname(skin.file || "."), resolveAsset = null } = {}) {
  const warnings = [];
  const skin = fit.skin;
  const elements = [], talkers = [];
  const walk = (t) => {
    if (typeof t.node.script === "string" && t.node.script !== "") elements.push(t);
    if (librariesOf(t.node).length) talkers.push(t);
    t.children.forEach(walk);
  };
  if (fit.tree) walk(fit.tree);
  if (!elements.length && !talkers.length) return { fit, scripts: {}, warnings };

  const skinKey = `${skin.file}@${stampOf(skin.file)}`;
  const folder = folderOf(skin);
  const warn = (t, cause, subject, message) => warnings.push(Object.freeze({
    key: [skin.file, t.id, cause, subject].join("|"), cause, skin: skin.file, element: t.id, subject, message,
  }));

  const calls = [], runs = [];
  for (const t of elements) {
    const ref = t.node.script;
    const where = resolveScript(ref, folder, resolveAsset);
    if (where.outside) {
      warn(t, "script-outside", ref, `${t.id}: script ${ref} is outside the skin's folder; not run`);
      continue;
    }
    if (!where.file) continue;
    const stamp = `${skinKey}|${where.file}@${stampOf(where.file)}`;
    const kept = state.get(t.id);
    const own = kept && kept.stamp === stamp ? kept.state : {};
    runs.push({ t, ref, file: where.file, stamp });
    calls.push({
      script: where.file, skin: skinKey,
      input: {
        value: valueOf(t.node, values), standIn: standInOf(t.node, values), metric: t.node.metric, params: t.node.params,
        reaction, now, tick, width: t.width, rows: t.rows,
        children: t.children.map((k) => ({
          id: k.id, metric: k.node.metric, value: valueOf(k.node, values), standIn: standInOf(k.node, values), width: k.width,
        })),
        state: own,
      },
    });
  }
  // The conversation libraries of the drawn chats, in the same batch: each gets the session's facts.
  let known = null;
  for (const t of talkers) {
    for (const ref of librariesOf(t.node)) {
      const where = resolveScript(ref, folder, resolveAsset);
      if (where.outside) {
        warn(t, "script-outside", ref, `${t.id}: conversation library ${ref} is outside the skin's folder; not run`);
        continue;
      }
      if (!where.file) continue;
      runs.push({ t, ref, file: where.file, library: true });
      calls.push({ script: where.file, skin: skinKey, fn: "conversations", input: (known ??= facts(values)) });
    }
  }

  const scripts = {};
  const heard = new Map(); // chat element -> its libraries' results, in order
  const nodes = new Map();
  if (calls.length) {
    const left = pass.left();
    let results = calls.map(() => ({ status: "skipped" }));
    if (left > 0) {
      const started = performance.now();
      results = (host ?? sharedScriptHost()).runBatch(calls, { deadlineMs: Math.min(left, pass.callBudgetMs * calls.length) });
      pass.spend(performance.now() - started);
    }
    results.forEach((r, i) => {
      const { t, ref, file, stamp, library } = runs[i];
      if (r.status === "ok" && library) {
        if (isPlainObject(r.output)) heard.set(t, [...(heard.get(t) ?? []), r.output]);
      } else if (r.status === "ok") {
        const out = isPlainObject(r.output) ? r.output : {};
        scripts[t.id] = out;
        if (isPlainObject(out.params)) nodes.set(t, withParams(t, out.params));
        if (Object.hasOwn(out, "state")) state.set(t.id, { stamp, state: isPlainObject(out.state) ? out.state : {} });
      } else if (r.status !== "skipped") {
        const msg = String(r.message || "").replace(`${file}: `, "");
        const why = r.status === "error" ? `failed: ${msg}` : msg;
        const key = [skin.file, t.id, "script-failed", ref].join("|");
        // Once the host has turned the script off it only says so; the warning keeps naming why.
        if (r.status !== "disabled") reasons.set(key, why);
        warn(t, "script-failed", ref, library
          ? `${t.id}: conversation library ${ref} ${reasons.get(key) ?? why}; the chat plays without it`
          : `${t.id}: script ${ref} ${reasons.get(key) ?? why}; drawn without it`);
      }
    });
  }
  for (const t of talkers) scripts[t.id] = { ...(scripts[t.id] ?? {}), conversations: heard.get(t) ?? [] };
  return { fit: nodes.size ? { ...fit, tree: rebuild(fit.tree, nodes) } : fit, scripts, warnings };
}
