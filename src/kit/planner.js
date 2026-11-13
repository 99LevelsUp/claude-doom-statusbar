// The width planner: how wide each metric and box is, which metrics are shown, and
// the largest bar scale whose balanced layout fits the terminal, walking the preset
// fallback chain when none does.

import { loadFace } from "../games/doom/face.js";
import { hpRow } from "../games/doom/layout.js";
import { VALUES } from "./values.js";
import { vlen, capLen, textCapFor, TEXTCAP_MAX } from "./text.js";
import { EQ_MAX, iconsWidth, barMeta } from "./meters.js";

export function metricFixedWidth(entry, textCap = TEXTCAP_MAX) {
  const icon = entry.icon || "";
  const lw = vlen(icon ? icon + " " : "");
  const r = entry.render || "text";
  const rid = entry.right;
  const rextra = rid && rid in VALUES ? 1 + vlen(String(VALUES[rid])) : 0;
  if ("group" in entry) {
    const sep = entry.sep ?? " ";
    return lw + capLen(entry.group.filter((i) => i in VALUES).map((i) => String(VALUES[i])).join(sep), textCap) + rextra;
  }
  if (r === "spark") return lw + Math.floor(((VALUES[entry.id] || []).length + 1) / 2);
  if (r === "equalizer") return lw + Math.min((VALUES[entry.id] || []).length, EQ_MAX) + rextra;
  if (r === "icons") return entry.stretch ? null : lw + iconsWidth(entry) + rextra; // stretch: sized like a bar
  if (r === "ammo") return lw + 5 + vlen(" " + (entry.id in VALUES ? VALUES[entry.id] : 0) + "%");
  if (r === "list") {
    const items = VALUES[entry.id] || [];
    if (items.length === 0) return lw;
    return Math.max(...items.map((it) =>
      Array.isArray(it) && it.length === 2
        ? lw + capLen(it[0], textCap) + 1 + vlen(String(it[1]))
        : lw + capLen(it, textCap)));
  }
  if (r === "scroll") {
    const items = VALUES[entry.id] || [];
    if (items.length === 0) return lw;
    return Math.max(...items.map((it) => {
      if (Array.isArray(it) && it.length === 2)
        return lw + capLen(it[0], textCap) + 1 + vlen(String(it[1]));
      // object {mark, text}
      return lw + vlen(String(it.mark || "")) + 1 + capLen(it.text || "", textCap);
    }));
  }
  if (r === "bar") return null;
  return lw + capLen(entry.id in VALUES ? VALUES[entry.id] : "?", textCap) + rextra;
}

function available(entry) {
  if ("group" in entry) return entry.group.some((i) => i in VALUES);
  if (entry.render === "list") return true;
  return entry.id in VALUES;
}

export function boxWidth(box, cells, textCap = TEXTCAP_MAX) {
  const widths = [vlen(box.title || "")];
  for (const m of box.metric) {
    let fw = metricFixedWidth(m, textCap);
    if (fw === null) {
      const [lw, sw] = barMeta(m);
      fw = lw + cells + sw;
    }
    widths.push(fw);
  }
  let w = Math.max(...widths);
  if ("min_width" in box) w = Math.max(w, box.min_width);
  if ("max_width" in box) w = Math.min(w, box.max_width);
  return w;
}

// Width-relevant layout context shared by buildBar (render) and planLayout (fit
// test). Filters unavailable metrics, computes the row count, and loads the mugshot
// art so its width counts toward the layout. spriteFor defaults to the idle face;
// the exact sprite never changes the mugshot's column width.
export function layoutContext(cfg, spriteFor) {
  if (!spriteFor) spriteFor = (hp) => `STFST${hp}1`;
  const bar = cfg.bar || {};
  const style = bar.border_style ?? "vertical";
  const headers = (bar.headers ?? true) && style !== "frame";
  const segs = [];
  for (const s of cfg.segment) {
    if (s.type === "mugshot") { segs.push(s); continue; }
    const mets = s.metric.filter(available);
    if (mets.length) segs.push({ ...s, metric: mets });
  }
  const boxes = segs.filter((s) => s.type === "box");
  const rowcount = (b) => b.metric.reduce((n, m) =>
    n + (m.render === "list" ? (VALUES[m.id] || []).length : (m.render === "scroll" ? 0 : 1)), 0);
  const dataRows = boxes.length ? Math.max(...boxes.map(rowcount)) : 0;
  const totalRows = Math.max(dataRows + (headers ? 1 : 0), 4); // 4 = mugshot floor
  const hp = hpRow();
  const face = loadFace(spriteFor(hp), totalRows);
  const faceW = Math.max(...face.map((r) => r.length));
  return { bar, style, headers, segs, totalRows, hp, face, faceW };
}

function colWidthsOf(segs, faceW, cells, textCap) {
  const ws = [];
  let mug = null;
  segs.forEach((s, i) => {
    if (s.type === "mugshot") { ws.push(faceW + 2); mug = i; }
    else ws.push(boxWidth(s, cells, textCap) + 2);
  });
  return [ws, mug];
}

function balancedWidthOf(segs, faceW, cells, textCap) {
  const [ws, mug] = colWidthsOf(segs, faceW, cells, textCap);
  if (mug === null) return ws.reduce((a, b) => a + b, 0) + (ws.length - 1);
  const left = ws.slice(0, mug).reduce((a, b) => a + b, 0) + mug;
  const right = ws.slice(mug + 1).reduce((a, b) => a + b, 0) + (ws.length - 1 - mug);
  return 2 * Math.max(left, right) + ws[mug];
}

// Largest lockstep scale (bars 14->4, text 24->10) whose balanced layout fits
// `target`. Returns the minimum scale with fits=false when nothing fits — the
// caller (statusline) reads `fits` to decide whether to fall back to a smaller
// preset. Pure: no filesystem, deterministic for a given cfg + VALUES.
export function planLayout(cfg, target, spriteFor) {
  const { segs, faceW } = layoutContext(cfg, spriteFor);
  for (let c = 14; c >= 4; c--) {
    const textCap = textCapFor(c);
    const width = balancedWidthOf(segs, faceW, c, textCap);
    if (width <= target) return { cells: c, textCap, width, fits: true };
  }
  const textCap = textCapFor(4);
  return { cells: 4, textCap, width: balancedWidthOf(segs, faceW, 4, textCap), fits: false };
}

// Walk the per-preset fallback chain from `chosenCfg` (the ceiling) downward and
// return the first preset whose layout fits `target`; if none fit, return the last
// (smallest) one reached. `loadByName(name) -> cfg | null` loads a sibling preset;
// returning null (missing/unreadable) ends the chain. Stateless: ceiling + recovery
// fall out of re-deriving from `target` each call. Guards against fallback cycles.
export function resolvePreset(chosenCfg, target, loadByName, spriteFor) {
  let cfg = chosenCfg, last = chosenCfg;
  const seen = new Set();
  while (cfg) {
    last = cfg;
    // Fit-test with the SAME sprite buildBar will render, so the mugshot column
    // width matches: plan.fits then implies the rendered layout actually fits.
    if (planLayout(cfg, target, spriteFor).fits) return cfg;
    const next = cfg.bar && cfg.bar.fallback;
    if (!next || seen.has(next)) break;   // terminus or cycle
    seen.add(next);
    const loaded = loadByName(next);
    if (!loaded) break;                    // missing/unreadable fallback
    cfg = loaded;
  }
  return last;                             // nothing fit -> smallest reached
}
