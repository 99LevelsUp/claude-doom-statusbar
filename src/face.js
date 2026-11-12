// Mugshot face loader. Each sprite is a pre-baked transparent PNG; the built-in converter turns it
// into rows of [char, fg, bg] (fg/bg an [r,g,b] or null = transparent) at the requested height,
// with the glyph step the session's terminal allows. faceCell then composites the rows onto the
// mugshot background. Drawing a face never starts a process.

import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESET, sgrBg } from "./ansi.js";
import { decodePng } from "./png.js";
import { convertImage } from "./glyph-render.js";
import { writeAtomic, packageVersion, runtimeDir } from "./fold.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const ALPHA_DIR = path.join(REPO, "assets", "images", "mugshot", "alpha"); // pre-baked transparent
const TERM_BG = "term-bg";

const _cache = new Map();
const _images = new Map(); // sprite name -> decoded RGBA, or null when it cannot be read
let _opts = { step: "octant", background: [0, 0, 0] };

// The face settings of the render about to run: the glyph step the session may use and the
// mugshot background transparent areas are fitted against. Set right before the builders run;
// one session renders at a time.
export function setFaceOptions({ step = "octant", background = [0, 0, 0] } = {}) {
  _opts = { step, background };
}

function image(name) {
  if (!_images.has(name)) {
    let img = null;
    try { img = decodePng(readFileSync(path.join(ALPHA_DIR, name + ".png"))); } catch { /* no face */ }
    _images.set(name, img);
  }
  return _images.get(name);
}

// Converted faces are also kept on disk so the one-shot status line (a new process every tick on
// Linux and macOS) converts each face once instead of on every tick. The file name carries the
// package version and the converter sources' size and time, so a changed converter never reads
// faces an older one drew. It is only a cache: a missing, unreadable or lost-in-a-race file just
// means converting again.
function converterStamp() {
  const parts = [packageVersion()];
  for (const f of ["glyphs.js", "glyph-render.js", "png.js"]) {
    try { const st = statSync(path.join(HERE, f)); parts.push(st.size, Math.round(st.mtimeMs)); } catch { parts.push(f); }
  }
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}
// Named on first use, not at load, so the runtime directory in force when a face is first drawn
// is the one used.
let _diskFile = null;
const diskFile = () => (_diskFile ||= path.join(runtimeDir(), `doombar_faces_${converterStamp()}.json`));
let _disk = null;
function diskCache() {
  if (!_disk) {
    try { _disk = JSON.parse(readFileSync(diskFile(), "utf8")); } catch { _disk = {}; }
    if (!_disk || typeof _disk !== "object" || Array.isArray(_disk)) _disk = {};
  }
  return _disk;
}

function convertFace(key, name, rows, step, background) {
  const disk = diskCache();
  if (Array.isArray(disk[key])) return disk[key];
  const img = image(name);
  if (!img) return Array.from({ length: rows }, () => []);
  const face = convertImage(img, rows, step, { background });
  disk[key] = face;
  try { writeAtomic(diskFile(), JSON.stringify(disk)); } catch { /* a cache that cannot be written is skipped */ }
  dropStaleCaches();
  return face;
}

// Caches an older converter or package version wrote are never read again. Once per process, the
// first time this one writes its own, remove the ones untouched for a day. Not every other one: a
// second installation (another version) uses its own file at the same time, and the two would
// keep deleting each other's.
const STALE_CACHE_MS = 24 * 3600 * 1000;
let _pruned = false;
function dropStaleCaches() {
  if (_pruned) return;
  _pruned = true;
  const dir = path.dirname(diskFile()), own = path.basename(diskFile());
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - STALE_CACHE_MS;
  for (const n of names) {
    if (n === own || !/^doombar_faces_[0-9a-f]{12}\.json$/.test(n)) continue;
    const file = path.join(dir, n);
    try { if (statSync(file).mtimeMs < cutoff) unlinkSync(file); } catch { /* gone already, or not ours to remove */ }
  }
}

export function loadFace(name, rows) {
  const { step, background } = _opts;
  const key = `${name}@${rows}@${step}@${background.join(",")}`;
  let face = _cache.get(key);
  if (!face) {
    face = convertFace(key, name, rows, step, background);
    _cache.set(key, face);
  }
  return face;
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
