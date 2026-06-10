// Render a status-bar preset to the terminal — the engine.
// Faithful port of tools/render_preset.py. Reads metric values from VALUES
// (statusline.js swaps in real data via setValues); renders bars, sparks, lists,
// the mugshot column, threshold colours, responsive widths, and centering.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { RESET, BOLD, TERM_RGB, sgrFg, sgrBg, pyround } from "./ansi.js";
import { loadFace, faceCell } from "./face.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

// SGR + OSC 8 hyperlinks — stripped for width measurement.
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g;

const TITLE = [222, 202, 128];
export const TEXT = [182, 186, 200];
export const OK = [96, 200, 104];
const WARN = [224, 184, 64];
export const CRIT = [224, 84, 64];
const SPARK = [120, 184, 232];

const EIGHTHS = [..." ▏▎▍▌▋▊▉"];
const HP_THRESHOLDS = [20, 40, 60, 80];

// Simulated metric values + availability (no live Claude Code data here).
export const SAMPLE = {
  "model.name": "Opus 4.8", "model.effort": "🌔", "advisor.model": "Opus 4.8",
  "model.window": "1M", "model.mode": "💭 on  🚀 off", "model.permission": "⏩ auto", "model.style": "default",
  "usage.reset5h": "2h13m", "usage.reset7d": "3d4h", "sys.session": "5h55m", "loc.churn": "+185 / -62",
  "context.hp": 78, "ratelimit.5h": 64, "ratelimit.7d": 31, "cost.total": "$1.83",
  "git.branch": "main", "git.behind": "↓2", "git.ahead": "↑3", "git.status": "3",
  "pr.state": "#1234",
  "act.subagents": [["hook events", "2m13s"], ["find configs", "12s"]], "act.agents": "2",
  "act.geiger": [0, .25, .5, 1, .75, 1, .5, .6, .3, .1, .4, 1, .8, .4],
  "act.tasks": "2/5", "act.errors": "0", "sys.ram": 47, "sys.cpu": "12%",
  "sys.disk": 63, "sys.clock": "14:23",
};

let VALUES = SAMPLE;
export function setValues(v) { VALUES = v; }

const has = (k) => Object.prototype.hasOwnProperty.call(VALUES, k);
const f = sgrFg;

export function vlen(s) {
  let n = 0;
  for (const ch of String(s).replace(ANSI_RE, "")) {
    const cp = ch.codePointAt(0);
    n += (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x23e9 && cp <= 0x23ec) ? 2 : 1;
  }
  return n;
}

function threshold(pct) {
  return pct < 60 ? OK : pct < 85 ? WARN : CRIT;
}

function rgbOf(spec) {
  if (typeof spec === "string" && spec.startsWith("#")) {
    return [1, 3, 5].map((i) => parseInt(spec.slice(i, i + 2), 16));
  }
  return TERM_RGB; // term-bg / term-fg approximated for blends
}

const isTerm = (rgb) => rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0;

function bgsgrBox(boxRgb) {
  return isTerm(boxRgb) ? "\x1b[49m" : sgrBg(boxRgb);
}

function borderFg(spec) {
  if (typeof spec === "string" && spec.startsWith("#")) return f(rgbOf(spec));
  if (spec === "term-fg") return "\x1b[39m";
  return "\x1b[38;2;0;0;0m"; // term-bg -> black-ish line
}

// --- render styles ----------------------------------------------------------

function rBar(pct, cells, boxRgb, colorSpec, showPct = true) {
  const empty = [0, 1, 2].map((i) => Math.floor((boxRgb[i] + TERM_RGB[i]) / 2));
  const eighths = pyround((pct / 100) * cells * 8);
  const full = Math.min(cells, Math.floor(eighths / 8));
  const rem = full < cells ? eighths % 8 : 0;
  const c = colorSpec === "threshold" ? threshold(pct) : colorSpec ? rgbOf(colorSpec) : TEXT;
  let s = sgrBg(empty) + f(c) + "█".repeat(full);
  if (rem) s += EIGHTHS[rem];
  s += " ".repeat(Math.max(0, cells - full - (rem ? 1 : 0)));
  s += bgsgrBox(boxRgb);
  if (showPct) s += f(c) + " " + String(pct).padStart(3) + "%";
  return s;
}

function rAmmo(pct, colorSpec, segs = 5) {
  const c = colorSpec === "threshold" ? threshold(pct) : WARN;
  const filled = pyround((pct / 100) * segs);
  return f(c) + "▮".repeat(filled) + f([90, 95, 120]) + "▯".repeat(segs - filled) +
    f(c) + " " + String(pct).padStart(3) + "%";
}

// Sparkline glyph tables: rows = left sub-bar height 0..4, cols = right height 0..4.
// Stored as arrays of code points (octants are astral — string[i] would split them).
const SPARK_OCTANT = [
  " ▗▗\u{1cd96}▐",
  "▖▂\u{1cdcb}\u{1cdd3}\u{1cdd5}",
  "▖\u{1cdbb}▄\u{1cde1}▟",
  "\u{1cd48}\u{1cdbf}\u{1cdde}▆\u{1cde5}",
  "▌\u{1cdc0}▙\u{1cde4}█",
].map((r) => [...r]);
const SPARK_BRAILLE = [
  "⠀⢀⢠⢰⢸", "⡀⣀⣠⣰⣸", "⡄⣄⣤⣴⣼", "⡆⣆⣦⣶⣾", "⡇⣇⣧⣷⣿",
].map((r) => [...r]);
const BLOCK_RAMP = [..."▁▂▃▄▅▆▇"];

function rSpark(values, style = "block", boxRgb = TERM_RGB, vmax = null) {
  const empty = [0, 1, 2].map((i) => Math.floor((boxRgb[i] + TERM_RGB[i]) / 2));
  const bg = sgrBg(empty);
  if (!values || values.length === 0) return f(SPARK);
  let nrm;
  if (vmax) {
    nrm = (v) => Math.max(0, Math.min(1, v / vmax));
  } else {
    const lo = Math.min(...values);
    const span = Math.max(...values) - lo;
    nrm = (v) => (span === 0 ? 0 : (v - lo) / span);
  }
  let body = "";
  if (style === "octant" || style === "braille") {
    const tbl = style === "octant" ? SPARK_OCTANT : SPARK_BRAILLE;
    const h = (v) => pyround(nrm(v) * 4);
    for (let i = 0; i < values.length; i += 2) {
      const r = h(values[i]);
      const c = i + 1 < values.length ? h(values[i + 1]) : 0;
      body += tbl[r][c];
    }
  } else {
    for (let i = 0; i < values.length; i += 2) {
      const v = Math.max(...values.slice(i, i + 2));
      body += BLOCK_RAMP[pyround(nrm(v) * 6)];
    }
  }
  return bg + f(SPARK) + body + bgsgrBox(boxRgb);
}

export function renderValue(entry, cells, boxRgb) {
  const icon = entry.icon || "";
  const label = icon ? icon + " " : "";
  const render = entry.render || "text";
  const color = entry.color;

  if ("group" in entry) {
    const sep = entry.sep ?? " ";
    const parts = entry.group.filter((i) => i in VALUES).map((i) => String(VALUES[i]));
    return label + f(TEXT) + parts.join(sep);
  }
  const val = entry.id in VALUES ? VALUES[entry.id] : "?";
  if (render === "bar") {
    let s = label + rBar(val, cells, boxRgb, color || "threshold", entry.show_pct !== false);
    const sid = entry.suffix;
    if (sid && sid in VALUES) s += f(TEXT) + " " + String(VALUES[sid]);
    return s;
  }
  if (render === "ammo") return label + rAmmo(val, color || "threshold");
  if (render === "spark") return label + rSpark(val, entry.spark_style || "block", boxRgb, entry.spark_max);
  if (render === "list") {
    const items = VALUES[entry.id] || [];
    return label + f(TEXT) + items.map((x) => (Array.isArray(x) ? `${x[0]} ${x[1]}` : String(x))).join("  ");
  }
  // number / text
  let col;
  if (color === "threshold") {
    col = threshold(parseInt(String(val).replace(/\D/g, "") || "0", 10));
  } else {
    col = color ? rgbOf(color) : TEXT;
  }
  return label + f(col) + String(val);
}

function barMeta(entry) {
  const icon = entry.icon || "";
  const lw = vlen(icon ? icon + " " : "");
  const r = entry.render;
  if (r === "bar" || r === "ammo") {
    let sw = entry.show_pct === false ? 0 : 5;
    const sid = entry.suffix;
    if (sid && sid in VALUES) sw += 1 + vlen(String(VALUES[sid]));
    return [lw, sw, r];
  }
  return [lw, 0, entry.render || "text"];
}

export function metricFixedWidth(entry) {
  const icon = entry.icon || "";
  const lw = vlen(icon ? icon + " " : "");
  const r = entry.render || "text";
  const rid = entry.right;
  const rextra = rid && rid in VALUES ? 1 + vlen(String(VALUES[rid])) : 0;
  if ("group" in entry) {
    const sep = entry.sep ?? " ";
    return lw + vlen(entry.group.filter((i) => i in VALUES).map((i) => String(VALUES[i])).join(sep)) + rextra;
  }
  if (r === "spark") return lw + Math.floor(((VALUES[entry.id] || []).length + 1) / 2);
  if (r === "ammo") return lw + 5 + vlen(" " + (entry.id in VALUES ? VALUES[entry.id] : 0) + "%");
  if (r === "list") {
    const items = VALUES[entry.id] || [];
    if (items.length === 0) return lw;
    return Math.max(...items.map((it) =>
      Array.isArray(it) && it.length === 2
        ? lw + vlen(String(it[0])) + 1 + vlen(String(it[1]))
        : lw + vlen(String(it))));
  }
  if (r === "bar") return null;
  return lw + vlen(String(entry.id in VALUES ? VALUES[entry.id] : "?")) + rextra;
}

function available(entry) {
  if ("group" in entry) return entry.group.some((i) => i in VALUES);
  if (entry.render === "list") return true;
  return entry.id in VALUES;
}

function boxWidth(box, cells) {
  const widths = [vlen(box.title || "")];
  for (const m of box.metric) {
    let fw = metricFixedWidth(m);
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

function hpRow(thresholds = HP_THRESHOLDS) {
  let headroom;
  if ("ratelimit.5h" in VALUES || "ratelimit.7d" in VALUES) {
    const rem5 = 100 - (VALUES["ratelimit.5h"] ?? 0);
    const rem7 = "ratelimit.7d" in VALUES ? 100 - VALUES["ratelimit.7d"] : 100;
    headroom = Math.min(rem5, rem7);
  } else {
    headroom = 100 - (VALUES["context.hp"] ?? 0);
  }
  return thresholds.filter((t) => headroom < t).length;
}

export function buildBar(cfg, target, spriteFor) {
  if (!spriteFor) spriteFor = (hp) => `STFST${hp}1`;

  const bar = cfg.bar || {};
  const style = bar.border_style ?? "vertical";
  const headers = (bar.headers ?? true) && style !== "frame";
  const boxRgb = rgbOf(bar.box_background ?? "term-bg");
  const bcol = bar.border_color ?? "term-fg";
  const mugRgb = rgbOf((cfg.mugshot || {}).background ?? "#000000");

  // availability: drop metrics whose value is absent; collapse empty boxes.
  const segs = [];
  for (const s of cfg.segment) {
    if (s.type === "mugshot") { segs.push(s); continue; }
    const mets = s.metric.filter(available);
    if (mets.length) segs.push({ ...s, metric: mets });
  }
  const boxes = segs.filter((s) => s.type === "box");
  const rowcount = (b) => b.metric.reduce((n, m) => n + (m.render === "list" ? (VALUES[m.id] || []).length : 1), 0);
  const dataRows = boxes.length ? Math.max(...boxes.map(rowcount)) : 0;
  const headersExtra = headers ? 1 : 0;
  const totalRows = Math.max(dataRows + headersExtra, 4); // 4 = mugshot floor

  const hp = hpRow();
  const face = loadFace(spriteFor(hp), totalRows);
  const faceW = Math.max(...face.map((r) => r.length));

  const colWidths = (cells) => {
    const ws = [];
    let mug = null;
    segs.forEach((s, i) => {
      if (s.type === "mugshot") { ws.push(faceW + 2); mug = i; }
      else ws.push(boxWidth(s, cells) + 2);
    });
    return [ws, mug];
  };

  const balancedWidth = (cells) => {
    const [ws, mug] = colWidths(cells);
    if (mug === null) return ws.reduce((a, b) => a + b, 0) + (ws.length - 1);
    const left = ws.slice(0, mug).reduce((a, b) => a + b, 0) + mug;
    const right = ws.slice(mug + 1).reduce((a, b) => a + b, 0) + (ws.length - 1 - mug);
    return 2 * Math.max(left, right) + ws[mug];
  };

  let cells = 4;
  for (let c = 14; c >= 4; c--) {
    if (balancedWidth(c) <= target) { cells = c; break; }
  }

  const columns = [];
  let mugIdx = null;
  for (const s of segs) {
    if (s.type === "mugshot") {
      mugIdx = columns.length;
      columns.push(Array.from({ length: totalRows }, (_, r) => faceCell(face[r], faceW, mugRgb)));
      continue;
    }
    const w = boxWidth(s, cells);
    const col = [];
    if (headers) {
      const t = s.title || "";
      const pad = w - vlen(t);
      const left = Math.floor(pad / 2);
      col.push(bgsgrBox(boxRgb) + BOLD + f(TITLE) + " " + " ".repeat(left) + t + " ".repeat(pad - left) + " " + RESET);
    }
    for (const m of s.metric) {
      if (m.render === "list") {
        const icon = m.icon || "";
        const lbl = icon ? icon + " " : "";
        for (const item of VALUES[m.id] || []) {
          let body;
          if (Array.isArray(item) && item.length === 2) {
            const left = lbl + f(TEXT) + String(item[0]);
            const right = f(TEXT) + String(item[1]);
            body = left + " ".repeat(Math.max(0, w - vlen(left) - vlen(right))) + right;
          } else {
            body = lbl + f(TEXT) + String(item);
            body += " ".repeat(Math.max(0, w - vlen(body)));
          }
          col.push(bgsgrBox(boxRgb) + " " + body + " " + RESET);
        }
        continue;
      }
      let body = renderValue(m, m.render === "bar" ? cells : 0, boxRgb);
      const rid = m.right;
      const rhs = rid && rid in VALUES ? f(TEXT) + String(VALUES[rid]) : "";
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

// Preview CLI: node src/render.js [PRESET.toml] [width]
function main() {
  const arg = process.argv[2];
  let p;
  if (arg) {
    p = path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg);
    try { readFileSync(p); } catch { p = path.join(REPO, "presets", path.basename(arg)); }
  } else {
    p = path.join(REPO, "presets", "default.toml");
  }
  const target = process.argv[3] ? parseInt(process.argv[3], 10) : 100;
  const cfg = parseToml(readFileSync(p, "utf8"));
  const res = buildBar(cfg, target);
  const out = ["", `  preset: ${path.basename(p)}   style=${res.style}  headers=${res.headers}  bar=${res.cells}`, ""];
  out.push(...res.lines, "");
  process.stdout.write(out.join("\n") + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
