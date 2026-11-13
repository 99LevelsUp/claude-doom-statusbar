// The DOOM box layout: a row of metric boxes around the mugshot column, with
// threshold colours, responsive widths and centering. Faithful port of
// tools/render_preset.py. Reads metric values from VALUES (render.js swaps in
// real data via setValues). Run directly, it previews a preset in the terminal.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { RESET, BOLD, TEXT, sgrFg } from "../../kit/ansi.js";
import { faceCell, loadFace } from "./face.js";
import { portrait } from "./portrait.js";
import { PACKAGE_ROOT } from "../../package-root.js";
import { VALUES } from "../../kit/values.js";
import { vlen, marquee, scrollWindow, ESC_RE, OSC8_RE } from "../../kit/text.js";
import { rgbOf, colorFor, isTerm, bgsgrBox, borderFg, barMeta, renderValue } from "../../kit/meters.js";
import { boxWidth, layoutContext, planLayout } from "../../kit/planner.js";
import { hpRow } from "../../metrics/reaction.js";

const TITLE = [222, 202, 128];

const f = sgrFg;

// No reaction at all (the preview, tests): nothing happened, health from the current values.
const calmReaction = () => ({ expr: null, exprAge: Infinity, flash: null, hp: hpRow(VALUES), god: false, dead: false });

// The mugshot art for a reaction, as the planner asks for it: rows -> rows of cells. The
// planner's fit test and buildBar draw through this, so both measure the same face.
export function mugshotFace(reaction, now) {
  return (rows) => loadFace(portrait(reaction ?? calmReaction(), now), rows);
}

// `reaction` is the session's reaction (src/metrics/reaction.js) and `now` the clock in
// seconds that picks the idle glance; without them the face is the calm, still one.
export function buildBar(cfg, target, reaction, tick = 0, overflow, now) {
  if (!reaction) reaction = calmReaction();
  const faceFor = mugshotFace(reaction, now);
  // How overflowing text fits its box: "scroll" (ping-pong marquee) or "clip" (static …).
  const ovf = overflow || cfg.text_overflow || "scroll";

  const { style, headers, segs, totalRows, face, faceW } = layoutContext(cfg, faceFor);
  const { hp } = reaction;
  const bar = cfg.bar || {};
  const boxRgb = rgbOf(bar.box_background ?? "term-bg");
  const bcol = bar.border_color ?? "term-fg";
  const mugRgb = rgbOf((cfg.mugshot || {}).background ?? "#000000");
  const titleFg = f(bar.title_color ? rgbOf(bar.title_color) : TITLE); // themes recolour box titles

  const { cells, textCap } = planLayout(cfg, target, faceFor);

  const columns = [];
  let mugIdx = null;
  for (const s of segs) {
    if (s.type === "mugshot") {
      mugIdx = columns.length;
      columns.push(Array.from({ length: totalRows }, (_, r) => faceCell(face[r], faceW, mugRgb)));
      continue;
    }
    const w = boxWidth(s, cells, textCap);
    const col = [];
    if (headers) {
      const t = s.title || "";
      const pad = w - vlen(t);
      const left = Math.floor(pad / 2);
      col.push(bgsgrBox(boxRgb) + BOLD + titleFg + " " + " ".repeat(left) + t + " ".repeat(pad - left) + " " + RESET);
    }
    for (const m of s.metric) {
      if (m.render === "list") {
        const icon = m.icon || "";
        const lbl = icon ? icon + " " : "";
        for (const item of VALUES[m.id] || []) {
          let body;
          if (Array.isArray(item) && item.length === 2) {
            const right = f(TEXT) + String(item[1]);
            const budget = Math.max(0, w - vlen(lbl) - vlen(String(item[1])) - 1); // 1 = min gap
            const left = lbl + f(TEXT) + marquee(String(item[0]), budget, tick, ovf);
            body = left + " ".repeat(Math.max(0, w - vlen(left) - vlen(String(item[1])))) + right;
          } else {
            body = lbl + f(TEXT) + marquee(String(item), Math.max(0, w - vlen(lbl)), tick, ovf);
          }
          col.push(bgsgrBox(boxRgb) + " " + body + " " + RESET);
        }
        continue;
      }
      if (m.render === "scroll") {
        const icon = m.icon || "";
        const lbl = icon ? icon + " " : "";
        const items = VALUES[m.id] || [];
        const H = totalRows - (headers ? 1 : 0);
        const boundary = items.filter((it) => !Array.isArray(it) &&
          (it.mark === "✅" || it.mark === "❌")).length; // settled count (ignored for top anchor)
        const win = scrollWindow(items.length, H, m.anchor || "top", boundary);
        const shown = items.slice(win.start, win.start + H);
        shown.forEach((item, k) => {
          const first = k === 0, last = k === shown.length - 1;
          const marker = first && win.up > 0 ? `↑${win.up}` : last && win.down > 0 ? `↓${win.down}` : "";
          const tail = marker ? " " + marker : "";         // right-aligned scroll marker (gap + ↑k/↓k)
          const tailW = vlen(tail);
          let body;
          if (Array.isArray(item)) {                       // [left, right] (agents)
            const right = f(TEXT) + String(item[1]) + (marker ? titleFg + tail : "");
            const rightW = vlen(String(item[1])) + tailW;
            const labelMax = Math.max(0, w - vlen(lbl) - rightW - 1); // 1 = min gap
            const left = lbl + f(TEXT) + marquee(String(item[0]), labelMax, tick, ovf);
            const room = Math.max(0, w - vlen(left) - rightW);
            body = left + " ".repeat(room) + right;
          } else {                                         // {mark, markRgb, text} (tasks)
            const markCol = item.markRgb ? f(item.markRgb) : f(TEXT);
            const m = String(item.mark);
            const mPad = m + (vlen(m) < 2 ? " " : "");      // normalize mark to 2 cols so text aligns
            const head = markCol + mPad + " " + f(TEXT);
            const max = Math.max(0, w - vlen(mPad) - 1 - tailW); // reserve gap + marker on the right
            body = head + marquee(String(item.text), max, tick, ovf);
            body += " ".repeat(Math.max(0, w - tailW - vlen(body)));
            if (tail) body += titleFg + tail;
          }
          col.push(bgsgrBox(boxRgb) + " " + body + " " + RESET);
        });
        continue;
      }
      const rid = m.right;
      const rhs = rid && rid in VALUES ? f(TEXT) + String(VALUES[rid]) : "";
      let body;
      if (m.render === "icons" && m.stretch) {
        // Stretch icons fill the whole box row (hearts end where the box ends), however wide the
        // box came out, rather than a fixed count. A bar's cells is the minimum.
        const [lw, sw] = barMeta(m);
        // With a gap, n glyphs take n + (n-1)*gap columns, so fit as many as the row allows.
        const room = Math.max(cells, w - lw - sw - vlen(rhs));
        const gap = m.gap ?? 0;
        body = renderValue({ ...m, count: Math.max(1, Math.floor((room + gap) / (1 + gap))) }, 0, boxRgb);
      } else {
        body = renderValue(m, m.render === "bar" ? cells : 0, boxRgb);
      }
      // Plain text/number that overflows its column budget -> marquee. Skipped when
      // the value carries ANSI/OSC escapes (colours, hyperlinks): those can't be
      // sliced by column without corrupting the escape sequence.
      const r = m.render || "text";
      if ((r === "text" || r === "number") && !("group" in m) && m.id in VALUES) {
        const raw = String(VALUES[m.id]);
        const lbl = m.icon ? m.icon + " " : "";
        const budget = w - vlen(lbl) - vlen(rhs);
        const sliceable = !ESC_RE.test(raw) || OSC8_RE.test(raw); // plain or hyperlink
        if (sliceable && budget > 0 && vlen(raw) > budget) {
          const col = colorFor(m.color, parseInt(raw.replace(/\D/g, "") || "0", 10)) ?? TEXT;
          body = lbl + f(col) + marquee(raw, budget, tick, ovf);
        }
      }
      body += " ".repeat(Math.max(0, w - vlen(body) - vlen(rhs))) + rhs;
      col.push(bgsgrBox(boxRgb) + " " + body + " " + RESET);
    }
    while (col.length < totalRows) col.push(bgsgrBox(boxRgb) + " ".repeat(w + 2) + RESET);
    columns.push(col);
  }

  let sepstr;
  if (style === "none") sepstr = isTerm(boxRgb) ? RESET + " " : bgsgrBox(boxRgb) + " ";
  else if (bcol === "term-bg") sepstr = RESET + " ";
  else sepstr = bgsgrBox(boxRgb) + borderFg(bcol) + "│";

  const lines = [];
  for (let r = 0; r < totalRows; r++) {
    if (mugIdx === null) {
      const body = columns.map((c) => c[r]).join(sepstr);
      const outer = Math.max(0, Math.floor((target - columns.reduce((a, c) => a + vlen(c[r]), 0) - (columns.length - 1)) / 2));
      lines.push(RESET + " ".repeat(outer) + body + RESET);
      continue;
    }
    let leftSeg = "";
    for (let i = 0; i < mugIdx; i++) leftSeg += (i ? sepstr : "") + columns[i][r];
    if (mugIdx) leftSeg += sepstr;
    let rightSeg = "";
    for (let j = mugIdx + 1; j < columns.length; j++) rightSeg += sepstr + columns[j][r];
    const lw = vlen(leftSeg), rw = vlen(rightSeg), mw = vlen(columns[mugIdx][r]);
    const side = Math.max(lw, rw);
    let outer;
    if (2 * side + mw <= target) {
      leftSeg = " ".repeat(side - lw) + leftSeg;
      rightSeg = rightSeg + " ".repeat(side - rw);
      outer = Math.floor((target - (2 * side + mw)) / 2);
    } else {
      outer = Math.max(0, Math.floor((target - (lw + mw + rw)) / 2));
    }
    lines.push(RESET + " ".repeat(outer) + leftSeg + columns[mugIdx][r] + rightSeg + RESET);
  }
  return { lines, style, headers, cells, hp };
}

// Preview CLI: node src/games/doom/layout.js [PRESET.toml] [width]
function main() {
  const arg = process.argv[2];
  let p;
  if (arg) {
    p = path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg);
    try { readFileSync(p); } catch { p = path.join(PACKAGE_ROOT, "presets", path.basename(arg)); }
  } else {
    p = path.join(PACKAGE_ROOT, "presets", "standard.toml");
  }
  const target = process.argv[3] ? parseInt(process.argv[3], 10) : 100;
  const tick = process.argv[4] ? parseInt(process.argv[4], 10) : 0; // marquee phase for previews
  const cfg = parseToml(readFileSync(p, "utf8"));
  const res = buildBar(cfg, target, undefined, tick);
  const out = ["", `  preset: ${path.basename(p)}   style=${res.style}  headers=${res.headers}  bar=${res.cells}`, ""];
  out.push(...res.lines, "");
  process.stdout.write(out.join("\n") + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
