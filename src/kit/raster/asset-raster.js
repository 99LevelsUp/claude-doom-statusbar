// The image-to-glyph cache. An image asset (a transparent PNG) becomes rows of [char, fg, bg] cells
// (fg/bg an [r,g,b], or null where the image is transparent) at the asked height and glyph step, by
// the built-in converter. Drawing an image never starts a process.
//
// Images are known by their file path, size and modification time, so same-named images of two
// games never share an entry, and an image that is rewritten or arrives while the bar runs is drawn
// from its new content on the next render. Images that cannot be read draw nothing: the caller
// falls back to its default.

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESET, sgrFg, sgrBg } from "../ansi.js";
import { decodePng } from "./png.js";
import { isPlainObject } from "../is.js";
import { convertImage } from "./glyph-render.js";
import { writeAtomic, runtimeDir, FACES_PREFIX } from "../../platform/runtime.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The converter's sources: a change to any of them invalidates the images cached on disk.
const CONVERTER_FILES = ["glyphs.js", "glyph-render.js", "png.js"].map((f) => path.join(HERE, f));
const TERM_BG = "term-bg";

const _assets = new Map();

function stampOf(file) {
  try {
    const st = statSync(file);
    return st.isFile() ? `${st.size}@${Math.round(st.mtimeMs)}` : null;
  } catch {
    return null;
  }
}

// Converted images are also kept on disk so the one-shot status line (a new process every tick on
// Linux and macOS) converts each image once instead of on every tick. The file name carries the
// converter sources' size and time, so a changed converter never reads images an older one drew.
// It is only a cache: a missing, unreadable or lost-in-a-race file just means converting again.
function converterStamp() {
  const parts = ["asset-raster"];
  for (const f of CONVERTER_FILES) {
    try { const st = statSync(f); parts.push(st.size, Math.round(st.mtimeMs)); } catch { parts.push(path.basename(f)); }
  }
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}
// Named on first use, not at load, so the runtime directory in force when an image is first drawn
// is the one used.
let _diskFile = null;
const diskFile = () => (_diskFile ||= path.join(runtimeDir(), `${FACES_PREFIX}${converterStamp()}.json`));
let _disk = null;
function diskCache() {
  if (!_disk) {
    try { _disk = JSON.parse(readFileSync(diskFile(), "utf8")); } catch { _disk = {}; }
    if (!isPlainObject(_disk)) _disk = {};
  }
  return _disk;
}

// Caches an older converter wrote are never read again. Once per process, the first time this one
// writes its own, remove the ones untouched for a day. Not every other one: a second installation
// uses its own file at the same time, and the two would keep deleting each other's.
const STALE_CACHE_MS = 24 * 3600 * 1000;
const CACHE_FILE = new RegExp(`^${FACES_PREFIX}[0-9a-f]{12}\\.json$`);
let _pruned = false;
function dropStaleCaches() {
  if (_pruned) return;
  _pruned = true;
  const dir = path.dirname(diskFile()), own = path.basename(diskFile());
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - STALE_CACHE_MS;
  for (const n of names) {
    if (n === own || !CACHE_FILE.test(n)) continue;
    const file = path.join(dir, n);
    try { if (statSync(file).mtimeMs < cutoff) unlinkSync(file); } catch { /* gone already, or not ours to remove */ }
  }
}

// `img` on a transparent canvas of `canvas` pixels, centred across and standing on its bottom edge,
// so every frame of an animation drawn on the same canvas keeps one scale and one place. An image
// as large as the canvas, or larger, is drawn as it is.
export function onCanvas(img, canvas) {
  if (!canvas || (canvas.width <= img.width && canvas.height <= img.height)) return img;
  const W = Math.max(canvas.width, img.width), H = Math.max(canvas.height, img.height);
  const rgba = new Uint8Array(W * H * 4);
  const ox = Math.floor((W - img.width) / 2), oy = H - img.height;
  for (let y = 0; y < img.height; y++) {
    rgba.set(img.rgba.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((oy + y) * W + ox) * 4);
  }
  return { ...img, width: W, height: H, rgba };
}

function convert(file, entry, key, rows, step, background, canvas) {
  const disk = diskCache();
  const own = `${file}|${entry.stamp}|`;
  if (Array.isArray(disk[own + key])) return disk[own + key];
  if (entry.image === undefined) {
    try { entry.image = decodePng(readFileSync(file)); } catch { entry.image = null; }
  }
  if (!entry.image) return null;
  const cells = convertImage(onCanvas(entry.image, canvas), rows, step, { background });
  // The file's entries from an earlier version of it are never read again.
  for (const k of Object.keys(disk)) if (k.startsWith(`${file}|`) && !k.startsWith(own)) delete disk[k];
  disk[own + key] = cells;
  try { writeAtomic(diskFile(), JSON.stringify(disk)); } catch { /* a cache that cannot be written is skipped */ }
  dropStaleCaches();
  return cells;
}

// The image at `file` as `rows` rows of cells at glyph `step`, transparent areas fitted against
// `background`, or null when the file is missing or not an image. With a `canvas` ({ width, height }
// in pixels, see frameCanvas) the image is drawn on it (onCanvas), so frames of different sizes come
// out at one scale and one size in cells.
export function rasterize(file, rows, { step = "octant", background = [0, 0, 0], canvas = null } = {}) {
  const stamp = stampOf(file);
  if (!stamp) {
    _assets.delete(file);
    return null;
  }
  let entry = _assets.get(file);
  if (!entry || entry.stamp !== stamp) {
    entry = { stamp, image: undefined, rows: new Map() };
    _assets.set(file, entry);
  }
  const key = `${rows}@${step}@${background.join(",")}${canvas ? `@${canvas.width}x${canvas.height}` : ""}`;
  if (!entry.rows.has(key)) entry.rows.set(key, convert(file, entry, key, rows, step, background, canvas));
  return entry.rows.get(key);
}

// The size in pixels of the PNG at `file`, from its header alone, or null when it is not a PNG.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function imageSize(file) {
  const head = Buffer.alloc(24);
  let fd = null;
  try {
    fd = openSync(file, "r");
    if (readSync(fd, head, 0, 24, 0) < 24) return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
  }
  if (head.length < 24 || !head.subarray(0, 8).equals(PNG_SIGNATURE) || head.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = head.readUInt32BE(16), height = head.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

// The canvas of a folder of frames: the width of its widest PNG and the height of its tallest, in
// pixels, or null when the folder holds none. Kept per folder until the folder changes (a frame
// added, removed or replaced), so the fit measures the frames once, not on every render.
const _canvases = new Map();
export function frameCanvas(dir) {
  let stamp;
  try { stamp = Math.round(statSync(dir).mtimeMs); } catch { return null; }
  const hit = _canvases.get(dir);
  if (hit && hit.stamp === stamp) return hit.canvas;
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".png")); } catch { return null; }
  let canvas = null;
  for (const n of names) {
    const s = imageSize(path.join(dir, n));
    if (!s) continue;
    canvas = canvas ? { width: Math.max(canvas.width, s.width), height: Math.max(canvas.height, s.height) } : s;
  }
  _canvases.set(dir, { stamp, canvas });
  return canvas;
}

// One cell over the background: a colour, or "term-bg" for the terminal's own, which a transparent
// foreground can only show through reverse video.
function emitCell(ch, efg, ebg, background) {
  if (background !== TERM_BG) {
    return "\x1b[27m" + sgrFg(efg !== null ? efg : background) + sgrBg(ebg !== null ? ebg : background) + ch;
  }
  if (efg === null && ebg === null) return "\x1b[27m\x1b[39m\x1b[49m" + ch;
  if (efg === null) return "\x1b[7m" + sgrFg(ebg) + "\x1b[49m" + ch;
  if (ebg === null) return "\x1b[27m" + sgrFg(efg) + "\x1b[49m" + ch;
  return "\x1b[27m" + sgrFg(efg) + sgrBg(ebg) + ch;
}

const bgOf = (background) => (background === TERM_BG ? "\x1b[49m" : sgrBg(background));

// One row of cells centred in exactly `width` columns on `background` ([r, g, b] or "term-bg"),
// ending with the attributes reset.
export function rasterLine(cells, width, background) {
  const shown = cells.slice(0, Math.max(0, width));
  const room = Math.max(0, width - shown.length);
  const left = Math.floor(room / 2);
  let s = bgOf(background) + " ".repeat(left);
  for (const [ch, efg, ebg] of shown) s += emitCell(ch, efg, ebg, background);
  return s + RESET + bgOf(background) + " ".repeat(room - left) + RESET;
}
