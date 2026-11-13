// The frame file: what the render daemon prepares and the bash statusLine client prints.
//
// Layout (LF only, the file ends with a newline):
//
//   doombar-frame v=<contract> daemon=<version> deadline=<µs> slots=<n>
//   slot <start-µs> <lineCount>        (n times, in ascending start order)
//   <lineCount body lines>
//   grey <lineCount>
//   <lineCount greyed body lines>
//
// Times are microseconds since the epoch, plain decimal digits, so the client can compare them
// with ${EPOCHREALTIME//[!0-9]/} (bash prints the locale's decimal separator, a comma in Czech).
// Body lines never contain LF, CR or NUL. Header fields are key=value pairs read by key; unknown
// keys are ignored.
//
// Which text to print at moment `now` (the same rules for every contract version):
//   now > deadline                 -> the greyed copy (one per file, of the last slot)
//   otherwise                      -> the last slot whose start <= now,
//                                     or the first slot when none has started yet
// A file that is missing, malformed or declares a contract newer than FRAME_VERSION is "unknown".

import { RESET, sgrFg } from "../kit/ansi.js";
import { writeAtomic } from "./runtime.js";

export const FRAME_VERSION = 1;

// Grey palette: colour luminance squeezed into a dim band, so the stale bar keeps its shape
// and contrast but reads as switched off.
const GREY_LO = 48;
const GREY_HI = 168;
const greyOf = ([r, g, b]) => {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return Math.round(GREY_LO + (Math.min(255, Math.max(0, lum)) * (GREY_HI - GREY_LO)) / 255);
};

export const OFFLINE_MARKER = `${RESET}${sgrFg([GREY_HI, GREY_HI, GREY_HI])} OFFLINE${RESET}`;

// xterm's 16 base colours, then the 6x6x6 cube and the grey ramp of the 256-colour palette.
const BASE16 = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
const CUBE = [0, 95, 135, 175, 215, 255];
function rgb256(n) {
  if (n < 16) return BASE16[n];
  if (n < 232) { const i = n - 16; return [CUBE[Math.floor(i / 36)], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6]]; }
  const v = 8 + 10 * (n - 232);
  return [v, v, v];
}

const greySgr = (code, rgb) => { const v = greyOf(rgb); return `${code};2;${v};${v};${v}`; };
const num = (s) => { const n = Number(s); return Number.isInteger(n) && n >= 0 ? n : 0; };

// Rewrite one SGR parameter list so every colour in it is a grey. Non-colour attributes
// (reset, bold, reverse, default fg/bg ...) are kept as they are.
function greyParams(params) {
  if (params === "") return params;
  const p = params.split(";");
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const tok = p[i];
    if (tok.includes(":")) { // ISO 8613-6 colon form: 38:2::r:g:b, 38:2:r:g:b, 38:5:n
      const sub = tok.split(":");
      const code = sub[0];
      if (code === "38" || code === "48" || code === "58") {
        if (sub[1] === "2") out.push(greySgr(code, (sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5)).map(num)));
        else if (sub[1] === "5") out.push(greySgr(code, rgb256(num(sub[2]) & 255)));
        continue; // an unrecognised colour form is dropped rather than left in colour
      }
      out.push(tok);
      continue;
    }
    const n = Number(tok);
    if (n === 38 || n === 48 || n === 58) {
      if (p[i + 1] === "2") { out.push(greySgr(n, p.slice(i + 2, i + 5).map(num))); i += 4; }
      else if (p[i + 1] === "5") { out.push(greySgr(n, rgb256(num(p[i + 2]) & 255))); i += 2; }
      else i = p.length; // malformed: the rest of the list cannot be read safely
      continue;
    }
    if (n >= 30 && n <= 37) out.push(greySgr(38, BASE16[n - 30]));
    else if (n >= 90 && n <= 97) out.push(greySgr(38, BASE16[n - 90 + 8]));
    else if (n >= 40 && n <= 47) out.push(greySgr(48, BASE16[n - 40]));
    else if (n >= 100 && n <= 107) out.push(greySgr(48, BASE16[n - 100 + 8]));
    else out.push(tok);
  }
  return out.join(";");
}

// Body text is split on newlines so a section's stated count is always its true line count,
// and loses NUL bytes, which a bash variable cannot hold and `read -d ''` stops at.
const normalise = (lines) => lines.flatMap((l) => String(l).replace(/\0/g, "").split(/\r?\n|\r/));

// The OFFLINE copy of a rendered body: every colour mapped to grey, every visible character and
// every line kept, and the marker appended to the last line (an empty body greys to the marker).
export function greyLines(lines) {
  const body = normalise(lines);
  if (!body.length) return [OFFLINE_MARKER];
  const grey = body.map((l) => l.replace(/\x1b\[([0-9;:]*)m/g, (_, p) => `\x1b[${greyParams(p)}m`));
  grey[grey.length - 1] += OFFLINE_MARKER;
  return grey;
}

const isTime = (n) => Number.isSafeInteger(n) && n >= 0;

// frame = { daemon, deadline, slots: [{ start, lines }] }. Throws on an invalid frame.
export function serializeFrame({ daemon, deadline, slots }) {
  const version = String(daemon);
  if (!/^\S+$/.test(version)) throw new Error("frame: daemon version must be one non-blank word");
  if (!isTime(deadline)) throw new Error("frame: deadline must be a non-negative integer (µs)");
  if (!Array.isArray(slots) || !slots.length) throw new Error("frame: at least one slot is required");
  const ordered = slots
    .map((s) => ({ start: s.start, lines: normalise(s.lines || []) }))
    .sort((a, b) => a.start - b.start);
  if (!ordered.every((s) => isTime(s.start))) throw new Error("frame: slot start must be a non-negative integer (µs)");
  const out = [`doombar-frame v=${FRAME_VERSION} daemon=${version} deadline=${deadline} slots=${ordered.length}`];
  for (const s of ordered) out.push(`slot ${s.start} ${s.lines.length}`, ...s.lines);
  const grey = greyLines(ordered[ordered.length - 1].lines);
  out.push(`grey ${grey.length}`, ...grey);
  return out.join("\n") + "\n";
}

const DIGITS = /^(0|[1-9]\d*)$/;

// Returns { version, daemon, deadline, slots: [{ start, lines }], grey } or null when the text
// is not a complete frame this reader understands.
export function parseFrame(text) {
  if (typeof text !== "string" || !text.endsWith("\n")) return null;
  const lines = text.split("\n");
  lines.pop(); // the empty string after the final newline
  const head = lines[0].split(" ");
  if (head[0] !== "doombar-frame") return null;
  const f = {};
  for (const kv of head.slice(1)) {
    const eq = kv.indexOf("=");
    if (eq > 0) f[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  if (!DIGITS.test(f.v ?? "")) return null;
  const version = Number(f.v);
  if (version < 1 || version > FRAME_VERSION) return null;
  if (!f.daemon || !DIGITS.test(f.deadline ?? "") || !/^[1-9]\d*$/.test(f.slots ?? "")) return null;
  const deadline = Number(f.deadline);
  const count = Number(f.slots);
  if (!isTime(deadline)) return null;

  let i = 1;
  const section = (re) => { // reads "<tag> ... <lineCount>" plus its body, or returns null
    const m = i < lines.length ? lines[i].match(re) : null;
    if (!m) return null;
    const n = Number(m[m.length - 1]);
    if (i + 1 + n > lines.length) return null;
    const body = lines.slice(i + 1, i + 1 + n);
    i += 1 + n;
    return { m, body };
  };
  const slots = [];
  for (let k = 0; k < count; k++) {
    const s = section(/^slot (0|[1-9]\d*) (0|[1-9]\d*)$/);
    if (!s) return null;
    const start = Number(s.m[1]);
    if (!isTime(start) || (slots.length && start < slots[slots.length - 1].start)) return null;
    slots.push({ start, lines: s.body });
  }
  const g = section(/^grey (0|[1-9]\d*)$/);
  if (!g || i !== lines.length) return null;
  return { version, daemon: f.daemon, deadline, slots, grey: g.body };
}

// The text to print at `nowMicros`: { kind: "live" | "grey" | "unknown", lines }.
export function resolveFrame(text, nowMicros) {
  const frame = parseFrame(text);
  if (!frame) return { kind: "unknown", lines: [] };
  if (nowMicros > frame.deadline) return { kind: "grey", lines: frame.grey };
  let pick = frame.slots[0];
  for (const s of frame.slots) if (s.start <= nowMicros) pick = s;
  return { kind: "live", lines: pick.lines };
}

// On Windows the rename fails while the client has the file open; that returns false and the
// daemon writes again on its next pass.
export function writeFrame(file, frame) {
  try {
    writeAtomic(file, serializeFrame(frame));
    return true;
  } catch {
    return false;
  }
}
