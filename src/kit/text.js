// Text primitives for the bar: display width, OSC 8 hyperlinks, the text cap that
// shrinks with the bar cells, the scroll window for long lists, and the marquee
// that fits long text into its column budget.

// SGR + OSC 8 hyperlinks — stripped for width measurement.
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g;

export function vlen(s) {
  let n = 0;
  for (const ch of String(s).replace(ANSI_RE, "")) {
    const cp = ch.codePointAt(0);
    n += (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x23e9 && cp <= 0x23ec)
      || cp === 0x2705 || cp === 0x274c ? 2 : 1; // ✅ ❌ are emoji-presentation (2 cols)
  }
  return n;
}

// OSC8 hyperlink helpers — long hyperlinked labels (cwd, branch) can't be column-sliced
// as-is (slicing corrupts the escape), so we operate on the visible text and re-wrap it
// with the same URL. Matches the format emitted by _link() in src/metrics/session.js.
export const OSC8_RE = /^\x1b\]8;;([^\x1b\x07]*)(?:\x1b\\|\x07)([\s\S]*?)\x1b\]8;;(?:\x1b\\|\x07)$/;
function splitLink(s) {
  const m = String(s).match(OSC8_RE);
  return m ? { url: m[1], inner: m[2] } : null;
}
function wrapLink(text, url) {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
// First `width` visible columns of `text`, no padding, never splitting a 2-col glyph.
function headCols(text, width) {
  let col = 0, out = "";
  for (const ch of [...String(text)]) {
    const cw = vlen(ch);
    if (col + cw > width) break;
    out += ch; col += cw;
  }
  return out;
}

// Display width of a plain text run, capped at `textCap` columns — but only when
// it is marquee-safe. Values carrying ANSI/OSC escapes (coloured text, hyperlinks)
// can't be column-sliced without corrupting the escape, so they keep full width
// (a hard floor): their box shrinks less, which is what trips the preset fallback.
export const TEXTCAP_MAX = 24; // upper bound — matches statusline's clip(…, 24)
const TEXTCAP_MIN = 10; // lower bound — the readable floor before falling back
export const ESC_RE = /\x1b/;
export function capLen(s, textCap) {
  const str = String(s);
  const w = vlen(str);
  // plain text and OSC8 hyperlinks are column-sliceable (marquee/clip operate on the
  // visible text), so cap them to textCap. Other escapes (raw SGR we can't safely slice)
  // keep their full width as a hard floor.
  const sliceable = !ESC_RE.test(str) || OSC8_RE.test(str);
  return sliceable ? Math.min(w, textCap) : w;
}

// The coupled text cap for a given bar-cell count: cells 14 -> cap 24, cells 4 ->
// cap 10, linearly in between. One scale drives bars and text together (approach A).
export function textCapFor(cells) {
  return Math.round(TEXTCAP_MIN + (cells - 4) / (14 - 4) * (TEXTCAP_MAX - TEXTCAP_MIN));
}

export function scrollWindow(n, h, anchor, boundary) {
  if (n <= h) return { start: 0, up: 0, down: 0 };       // all fit: top-aligned
  let start;
  if (anchor === "boundary") start = boundary - Math.floor(h / 2);
  else start = 0;                                         // top anchor
  start = Math.max(0, Math.min(start, n - h));            // clamp: never blank rows
  return { start, up: start, down: n - start - h };
}

// --- horizontal marquee (the "car radio" scroll) ----------------------------
// Long text that won't fit its column budget glides left until its tail shows,
// pauses, then glides back to the start and pauses again — ping-pong, driven by
// the same per-refresh `tick` as the mugshot/geiger. Pure function of `tick`
// (no Date in here) so renders stay deterministic and testable.
const MARQUEE_STEP = 1;   // display columns advanced per tick
const MARQUEE_DWELL = 3;  // ticks held at each end before reversing

// Triangular offset wave 0..span..0 with a dwell at both extremes.
function marqueeOffset(span, tick) {
  if (span <= 0) return 0;
  const sweep = Math.ceil(span / MARQUEE_STEP);
  const cycle = 2 * (MARQUEE_DWELL + sweep);
  let t = ((tick % cycle) + cycle) % cycle;
  if (t < MARQUEE_DWELL) return 0;                            // hold at start
  t -= MARQUEE_DWELL;
  if (t < sweep) return Math.min(span, t * MARQUEE_STEP);     // glide forward 0->span
  t -= sweep;
  if (t < MARQUEE_DWELL) return span;                         // hold at end
  t -= MARQUEE_DWELL;
  return Math.max(0, span - t * MARQUEE_STEP);                // glide back span->0
}

// Take a `width`-wide display window starting `off` columns in, never splitting a
// 2-col glyph; the result is always exactly `width` columns (padded with spaces).
function sliceCols(text, off, width) {
  let col = 0, taken = 0, out = "";
  for (const ch of [...String(text)]) {
    const cw = vlen(ch);
    if (col < off) { col += cw; continue; }          // still left of the window
    if (taken + cw > width) break;                   // glyph would overflow the window
    out += ch; taken += cw; col += cw;
  }
  if (taken < width) out += " ".repeat(width - taken);
  return out;
}

// Fit `text` into exactly `width` display columns. Fits -> left-aligned + padded.
// Overflows -> ping-pong marquee window for the current `tick`.
export function marquee(text, width, tick = 0, mode = "scroll") {
  text = String(text);
  if (width <= 0) return "";
  const link = splitLink(text);                              // hyperlink: fit the visible text, re-wrap
  if (link) return wrapLink(marquee(link.inner, width, tick, mode), link.url);
  const tw = vlen(text);
  if (tw <= width) return text + " ".repeat(width - tw);
  if (mode === "clip") {                                     // static truncation with an ellipsis
    if (width === 1) return "…";
    const h = headCols(text, width - 1);
    return h + "…" + " ".repeat(Math.max(0, width - vlen(h) - 1));
  }
  return sliceCols(text, marqueeOffset(tw - width, tick), width);
}
