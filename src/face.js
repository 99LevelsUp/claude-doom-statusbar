// Mugshot face loader. Each sprite is a pre-baked transparent PNG; the built-in converter turns it
// into rows of [char, fg, bg] (fg/bg an [r,g,b] or null = transparent) at the requested height,
// with the glyph step the session's terminal allows. faceCell then composites the rows onto the
// mugshot background.
//
// chafa draws the face instead only when DOOMBAR_FACE_RENDERER=chafa asks for it, with the same
// glyph step and the same size; when chafa is missing or fails, the built-in face is drawn.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESET, sgrBg } from "./ansi.js";
import { decodePng } from "./png.js";
import { convertImage, faceSize } from "./glyph-render.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const ALPHA_DIR = path.join(REPO, "assets", "images", "mugshot", "alpha"); // pre-baked transparent
const TERM_BG = "term-bg";

const WARM_TIMEOUT_MS = 10000; // a hung chafa must not outlive its warm-up

// chafa symbol classes matching each glyph step.
const CHAFA_SYMBOLS = {
  half: "space+solid+half",
  quadrant: "space+solid+half+quad",
  sextant: "space+solid+half+quad+sextant",
  wedge: "space+solid+half+quad+sextant+wedge",
  octant: "space+solid+half+quad+sextant+wedge+octant",
};

const _cache = new Map();
const _warming = new Map(); // key -> in-flight chafa warm-up promise
const _images = new Map(); // sprite name -> decoded RGBA, or null when it cannot be read
let _noSpawn = false;
let _chafaRuns = 0;
let _opts = { step: "octant", renderer: "builtin", background: [0, 0, 0] };

// The face settings of the render about to run: the glyph step the session may use, the
// renderer, and the mugshot background transparent areas are fitted against. Set right before
// the builders run; one session renders at a time.
export function setFaceOptions({ step = "octant", renderer = "builtin", background = [0, 0, 0] } = {}) {
  _opts = { step, renderer: renderer === "chafa" ? "chafa" : "builtin", background };
}

// No-spawn mode is for long-lived processes: a cache miss never waits on chafa. With the chafa
// renderer it returns the built-in face at once and warms the chafa face in the background.
export function setFaceNoSpawn(on = true) {
  _noSpawn = Boolean(on);
}

// How many chafa processes this module has started (synchronous and warm-up alike).
export const chafaRuns = () => _chafaRuns;

function image(name) {
  if (!_images.has(name)) {
    let img = null;
    try { img = decodePng(readFileSync(path.join(ALPHA_DIR, name + ".png"))); } catch { /* no face */ }
    _images.set(name, img);
  }
  return _images.get(name);
}

function builtinFace(name, rows, step, background) {
  const img = image(name);
  if (!img) return Array.from({ length: rows }, () => []);
  return convertImage(img, rows, step, { background });
}

function chafaArgs(name, rows, step) {
  const img = image(name);
  const size = img ? faceSize(img.width, img.height, rows) : { cols: 9999, rows };
  return ["-f", "symbols", "--polite", "on", "--colors", "full", "--symbols", CHAFA_SYMBOLS[step],
    "--size", `${size.cols}x${size.rows}`, path.join(ALPHA_DIR, name + ".png")];
}

function chafaFace(name, rows, step) {
  _chafaRuns += 1;
  const r = spawnSync("chafa", chafaArgs(name, rows, step), { maxBuffer: 1 << 24, windowsHide: true });
  if (r.error) return null; // chafa not on PATH
  return r.status === 0 && r.stdout && r.stdout.length ? r.stdout.toString("utf8") : null;
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
  while (out.length < rows) out.push([]); // exactly `rows` lines
  return out;
}

const keyOf = (name, rows, o) => `${name}@${rows}@${o.step}@${o.renderer}`;

// Draw one face with an asynchronous chafa and put it in the cache under the current options.
// Resolves true when the chafa face landed, false when chafa is missing, fails or times out (the
// built-in face then stays). Concurrent calls for one key share a single child process.
export function warmFace(name, rows) {
  const o = _opts;
  const key = keyOf(name, rows, o);
  const pending = _warming.get(key);
  if (pending) return pending;
  _chafaRuns += 1;
  const p = new Promise((resolve) => {
    let settled = false;
    const done = (text) => {
      if (settled) return;
      settled = true;
      _warming.delete(key);
      if (text) _cache.set(key, toFace(text, rows));
      else if (!_cache.has(key)) _cache.set(key, builtinFace(name, rows, o.step, o.background));
      resolve(Boolean(text));
    };
    let child;
    try {
      child = spawn("chafa", chafaArgs(name, rows, o.step), {
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
  const o = _opts;
  const key = keyOf(name, rows, o);
  if (_cache.has(key)) return _cache.get(key);
  let out;
  if (o.renderer !== "chafa") {
    out = builtinFace(name, rows, o.step, o.background);
  } else if (_noSpawn) {
    out = builtinFace(name, rows, o.step, o.background); // the warm-up replaces it when chafa lands
    _cache.set(key, out);
    warmFace(name, rows);
    return out;
  } else {
    const text = chafaFace(name, rows, o.step);
    out = text ? toFace(text, rows) : builtinFace(name, rows, o.step, o.background);
  }
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
