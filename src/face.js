// Mugshot face loader — port of the face logic in tools/mockup_boxes.py.
// chafa rasterises a pre-baked *transparent* sprite into block-art at the
// requested height; when chafa is absent we fall back to the pre-rendered .ans
// (heights 4..16). The ANSI is parsed into rows of [char, fg, bg] (fg/bg an
// [r,g,b] or null = transparent), then composited onto the mugshot background.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESET, sgrBg } from "./ansi.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const ALPHA_DIR = path.join(REPO, "assets", "images", "mugshot", "alpha"); // pre-baked transparent
const ANS_DIR = path.join(REPO, "assets", "images", "mugshot", "ans");
const ANS_SIZES = [4, 16];
const SYMS = "block+half+quad+sextant+wedge+legacy";
const TERM_BG = "term-bg";

const _cache = new Map();

function chafaFace(name, rows) {
  const sprite = path.join(ALPHA_DIR, name + ".png");
  const args = ["-f", "symbols", "--polite", "on", "--colors", "full",
    "--symbols", SYMS, "--size", `9999x${rows}`, sprite];
  const r = spawnSync("chafa", args, { maxBuffer: 1 << 24 });
  if (r.error) return null; // chafa not on PATH
  return r.status === 0 && r.stdout && r.stdout.length ? r.stdout.toString("utf8") : null;
}

function ansiFace(name, rows) {
  const r = Math.max(ANS_SIZES[0], Math.min(ANS_SIZES[1], rows));
  try {
    return readFileSync(path.join(ANS_DIR, String(r), name + ".ans"), "utf8");
  } catch {
    return "";
  }
}

const FINAL = "ABCDEFGHJKSTfhilmnpqrsu"; // CSI final bytes we scan to

function parseAnsi(text) {
  const chars = [...text]; // code points (face glyphs are astral)
  let fgc = null, bgc = null, rev = false;
  const out = [];
  let row = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === "\r") {
      i += 1;
    } else if (c === "\n") {
      out.push(row);
      row = [];
      i += 1;
    } else if (c === "\x1b" && i + 1 < chars.length && chars[i + 1] === "[") {
      let j = i + 2;
      while (j < chars.length && !FINAL.includes(chars[j])) j += 1;
      if (j < chars.length && chars[j] === "m") {
        const ps = chars.slice(i + 2, j).join("").split(";");
        let k = 0;
        while (k < ps.length) {
          const p = ps[k] === "" ? 0 : parseInt(ps[k], 10);
          if (p === 0) { fgc = null; bgc = null; rev = false; }
          else if (p === 7) rev = true;
          else if (p === 27) rev = false;
          else if (p === 39) fgc = null;
          else if (p === 49) bgc = null;
          else if ((p === 38 || p === 48) && k + 4 < ps.length && ps[k + 1] === "2") {
            const col = [parseInt(ps[k + 2], 10), parseInt(ps[k + 3], 10), parseInt(ps[k + 4], 10)];
            if (p === 38) fgc = col; else bgc = col;
            k += 4;
          }
          k += 1;
        }
      }
      i = j + 1;
    } else {
      const [efg, ebg] = rev ? [bgc, fgc] : [fgc, bgc];
      row.push([c, efg, ebg]);
      i += 1;
    }
  }
  if (row.length) out.push(row);
  return out;
}

export function loadFace(name, rows) {
  const key = `${name}@${rows}`;
  if (_cache.has(key)) return _cache.get(key);
  let text = chafaFace(name, rows);
  if (!text) text = ansiFace(name, rows); // no chafa -> pre-rendered ANSI
  let out = parseAnsi(text);
  out = out.slice(0, rows);
  while (out.length < rows) out.push([]); // exactly `rows` lines (fallback clamps)
  _cache.set(key, out);
  return out;
}

const tc = (code, c) => `\x1b[${code};2;${c[0]};${c[1]};${c[2]}m`;

function emitCell(ch, efg, ebg, boxBg) {
  if (boxBg !== TERM_BG) {
    const fcol = efg !== null ? efg : boxBg;
    const bcol = ebg !== null ? ebg : boxBg;
    return "\x1b[27m" + tc(38, fcol) + tc(48, bcol) + ch;
  }
  if (efg === null && ebg === null) return "\x1b[27m\x1b[39m\x1b[49m" + ch;
  if (efg === null) return "\x1b[7m" + tc(38, ebg) + "\x1b[49m" + ch;
  if (ebg === null) return "\x1b[27m" + tc(38, efg) + "\x1b[49m" + ch;
  return "\x1b[27m" + tc(38, efg) + tc(48, ebg) + ch;
}

const bg = (color) => (color === TERM_BG ? "\x1b[49m" : sgrBg(color));

export function faceCell(cells, w, boxBg) {
  const vis = cells.length;
  const total = Math.max(0, w - vis);
  const left = Math.floor(total / 2);
  const right = total - left;
  let s = bg(boxBg) + " " + " ".repeat(left);
  for (const [ch, efg, ebg] of cells) s += emitCell(ch, efg, ebg, boxBg);
  s += RESET + bg(boxBg) + " ".repeat(right) + " " + RESET;
  return s;
}
