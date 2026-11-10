// Mugshot face loader — port of the face logic in tools/mockup_boxes.py.
// chafa rasterises a pre-baked *transparent* sprite into block-art at the
// requested height; when chafa is absent we fall back to the pre-rendered .ans
// (heights 4..16). The ANSI is parsed into rows of [char, fg, bg] (fg/bg an
// [r,g,b] or null = transparent), then composited onto the mugshot background.

import { spawn, spawnSync } from "node:child_process";
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

const WARM_TIMEOUT_MS = 10000; // a hung chafa must not outlive its warm-up

const _cache = new Map();
const _warming = new Map(); // key -> in-flight warm-up promise
let _noSpawn = false;
let _warmupsStarted = 0;

const chafaArgs = (name, rows) => ["-f", "symbols", "--polite", "on", "--colors", "full",
  "--symbols", SYMS, "--size", `9999x${rows}`, path.join(ALPHA_DIR, name + ".png")];

function chafaFace(name, rows) {
  const r = spawnSync("chafa", chafaArgs(name, rows), { maxBuffer: 1 << 24 });
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

function toFace(text, rows) {
  const out = parseAnsi(text).slice(0, rows);
  while (out.length < rows) out.push([]); // exactly `rows` lines (fallback clamps)
  return out;
}

// No-spawn mode is for long-lived processes: a cache miss never waits on chafa. It returns
// the pre-rendered .ans face at once and warms the chafa face in the background; the
// one-shot statusline keeps the synchronous default.
export function setFaceNoSpawn(on = true) {
  _noSpawn = Boolean(on);
}

export const faceWarmupsStarted = () => _warmupsStarted;

// Rasterise one face with an asynchronous chafa and put it in the cache. Resolves true when
// the chafa face landed, false when chafa is missing, fails or times out (the .ans face then
// stays). Concurrent calls for one key share a single child process.
export function warmFace(name, rows) {
  const key = `${name}@${rows}`;
  const pending = _warming.get(key);
  if (pending) return pending;
  _warmupsStarted += 1;
  const p = new Promise((resolve) => {
    let settled = false;
    const done = (text) => {
      if (settled) return;
      settled = true;
      _warming.delete(key);
      if (text) _cache.set(key, toFace(text, rows));
      else if (!_cache.has(key)) _cache.set(key, toFace(ansiFace(name, rows), rows));
      resolve(Boolean(text));
    };
    let child;
    try {
      child = spawn("chafa", chafaArgs(name, rows), {
        stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: WARM_TIMEOUT_MS,
      });
    } catch {
      done(null);
      return;
    }
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", () => done(null)); // chafa not on PATH, or killed on timeout
    child.on("close", (code) => {
      const out = Buffer.concat(chunks);
      done(code === 0 && out.length ? out.toString("utf8") : null);
    });
  });
  _warming.set(key, p);
  return p;
}

export function loadFace(name, rows) {
  const key = `${name}@${rows}`;
  if (_cache.has(key)) return _cache.get(key);
  if (_noSpawn) {
    const out = toFace(ansiFace(name, rows), rows);
    _cache.set(key, out); // the warm-up replaces it with the chafa face when it lands
    warmFace(name, rows);
    return out;
  }
  let text = chafaFace(name, rows);
  if (!text) text = ansiFace(name, rows); // no chafa -> pre-rendered ANSI
  const out = toFace(text, rows);
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
