// The chat visual: a chat log that plays conversations, newest line at the bottom, one message
// every few seconds, picked by the clock. It costs no tokens; the conversations are written ahead
// and chosen by what the session's metrics say.
//
// Where the conversations come from, in this order:
//   1. the platform's metrics library (src/kit/chat/metrics-library.js), which always plays, in
//      the one-shot status line too;
//   2. the conversation libraries the skin names in `libraries`, scripts that define
//      `conversations(facts)`; they run in the render daemon's script pass
//      (src/kit/skin/scripts.js), which hands their results to the draw as `script.conversations`,
//      and are silent where no scripts run;
//   3. the skin's own `conversations`.
// A later source replaces a conversation of an earlier one with the same key, in its place; a new
// key plays after the rest. Then every key in `drop` is left out.
//
// A skin's own conversation is text, one line per line: "role: text" is a message ("me" is the
// running model, another role a name of the cast or the name itself), any other line a plain line
// in the system colour. Facts and cast roles in braces are filled in, as in a library's lines.

import { sgrFg, TERM_RGB } from "../ansi.js";
import { vlen } from "../text.js";
import { rgbOf, bgOf, bgsgrBox } from "../colors.js";
import { define, param } from "./schema.js";
import { blank } from "./paint.js";
import { facts as metricFacts, conversations as metricsLibrary } from "../chat/metrics-library.js";
import { isPlainObject } from "../is.js";

// Timing feels like people typing: an answer to a question comes quickly, anything else after a
// varied pause. The pauses are fixed per line (not truly random), so every render in the same
// second shows the same chat.
const ANSWER_DELAY_S = 2;
const PAUSE_MIN_S = 3, PAUSE_MAX_S = 10;

// Fill {placeholders} from the cast and the facts; null when one is not known.
function fill(text, cast, F) {
  if (typeof text !== "string") return null;
  let missing = false;
  const out = text.replace(/\{(\w+)\}/g, (_, k) => {
    if (Object.hasOwn(cast, k)) return cast[k];
    const v = Object.hasOwn(F, k) ? F[k] : null;
    if (v === null || v === undefined || v === "") { missing = true; return ""; }
    return String(v);
  });
  return missing ? null : out;
}

const ROLES = new Set(["text", "me", "system", "accent"]);

// One line of a conversation as styled parts [{ text, role }], or null to leave it out.
function message(line, cast, F) {
  if (typeof line === "string") {
    const text = fill(line, cast, F);
    return text === null ? null : [{ text, role: "system" }];
  }
  if (!Array.isArray(line) || !line.length) return null;
  if (isPlainObject(line[0])) {
    const parts = line.map((p) => (isPlainObject(p) ? { text: fill(p.text, cast, F), role: ROLES.has(p.role) ? p.role : "text" } : null));
    return parts.every((p) => p && p.text !== null) ? parts : null;
  }
  const [role, said] = line;
  if (typeof role !== "string") return null;
  const options = Array.isArray(said) ? said : [said];
  const text = options.map((o) => fill(o, cast, F)).find((t) => t !== null && t !== undefined);
  if (text === undefined || text === null) return null;
  const name = Object.hasOwn(cast, role) ? cast[role] : role;
  return [
    { text: "<", role: "text" },
    { text: name, role: role === "me" ? "me" : "text" },
    { text: "> " + text, role: "text" },
  ];
}

// A skin's own conversation, written as text, as lines.
function ownLines(text) {
  return String(text).split("\n").filter((l) => l.trim()).map((l) => {
    const m = /^([^\s:]+): (.*)$/.exec(l);
    return m ? [m[1], m[2]] : l;
  });
}

// The cast and the conversations of `libraries` ([{ cast, conversations }], in order) and of the
// skin's own parameters, merged by key.
function merge(libraries, p) {
  const cast = {};
  const keyed = new Map();
  for (const lib of libraries) {
    if (!isPlainObject(lib)) continue;
    if (isPlainObject(lib.cast)) for (const [role, name] of Object.entries(lib.cast)) if (typeof name === "string") cast[role] = name;
    if (!isPlainObject(lib.conversations)) continue;
    for (const [key, conv] of Object.entries(lib.conversations)) {
      // A conversation of one plain line may be given as that line.
      const lines = typeof conv === "string" ? [conv] : conv;
      if (Array.isArray(lines)) keyed.set(key, lines);
    }
  }
  for (const [key, text] of Object.entries(p.conversations)) keyed.set(key, ownLines(text));
  for (const key of p.drop) keyed.delete(key);
  return { cast, lines: [...keyed.values()].flat() };
}

// Deterministic per-line "random" pause in [PAUSE_MIN_S, PAUSE_MAX_S].
function pauseFor(i) {
  let x = Math.imul(i + 1, 0x9e3779b1) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca77) >>> 0;
  return PAUSE_MIN_S + ((x ^ (x >>> 13)) >>> 0) % (PAUSE_MAX_S - PAUSE_MIN_S + 1);
}

const plainText = (parts) => parts.map((p) => p.text).join("");

// What the chat plays at `now` (seconds):
//   { script, messages, cycle }
//   script    every message of one cycle, as styled parts, in order
//   messages  the `rows` most recent at `now`, oldest first (none when nothing applies)
//   cycle     the seconds one cycle takes
// `libraries` are the results of the skin's conversation libraries; the metrics library comes first
// on its own.
export function playChat({ facts: F, libraries = [], params: p, now = 0, rows = 1 }) {
  const { cast: own, lines } = merge([metricsLibrary(F), ...libraries], p);
  const cast = { ...own, me: F.model || "Claude" };
  const script = lines.map((l) => message(l, cast, F)).filter(Boolean);
  if (!script.length) return { script, messages: [], cycle: 0 };
  const at = [];
  let t = 0;
  script.forEach((m, i) => {
    at.push(t);
    t += plainText(m).trim().endsWith("?") ? ANSWER_DELAY_S : pauseFor(i);
  });
  const pos = ((now % t) + t) % t;
  let idx = 0;
  while (idx + 1 < script.length && at[idx + 1] <= pos) idx++;
  const messages = [];
  for (let i = rows - 1; i >= 0; i--) messages.push(script[(((idx - i) % script.length) + script.length) % script.length]);
  return { script, messages, cycle: t };
}

// Word-wrap one message (styled parts) into lines of at most `w` columns, like a game's chat: break
// at spaces, and split a word only when it alone is wider than the line. Each continuation line
// starts with one space, so a wrapped message reads as one message.
const WRAP_INDENT = " ";
export function wrapMessage(parts, w) {
  const tokens = [];
  for (const p of parts) for (const t of p.text.split(/( +)/)) if (t) tokens.push({ text: t, role: p.role });
  const lines = [[]];
  let used = 0, start = 0;
  const push = (text, role) => { lines[lines.length - 1].push({ text, role }); used += vlen(text); };
  const newline = () => { lines.push([]); used = 0; push(WRAP_INDENT, "text"); start = used; };
  for (const { text, role } of tokens) {
    if (/^ +$/.test(text)) { if (used > start && used + vlen(text) < w) push(text, role); else if (used > start) newline(); continue; }
    if (used > start && used + vlen(text) > w) newline();
    let rest = [...text];
    while (vlen(rest.join("")) > w - used) { // a word longer than a whole line: hard split
      const room = Math.max(1, w - used);
      push(rest.slice(0, room).join(""), role);
      rest = rest.slice(room);
      newline();
    }
    if (rest.length) push(rest.join(""), role);
  }
  return lines.filter((l) => l.some((part) => part.text.trim()));
}

// The running model's name in the colour of its effort level; "rainbow" drifts one colour a second.
function effortName(name, level, now, p) {
  const spec = typeof level === "string" && Object.hasOwn(p.effort_colors, level) ? p.effort_colors[level] : null;
  if (spec === "rainbow" && p.rainbow.length) {
    return [...name].map((ch, i) => sgrFg(rgbOf(p.rainbow[(i + Math.floor(now)) % p.rainbow.length])) + ch).join("");
  }
  return sgrFg(rgbOf(spec && spec.startsWith("#") ? spec : p.color)) + name;
}

// `messages` painted into `height` lines of exactly `width` columns: wrapped to the strip, the
// newest at the bottom, on the chat's background with one column of padding each side. `level` is
// the running model's effort level, `surface` the background the chat sits on.
export function paintChat(messages, { width, height, params: p, level = null, now = 0, surface = TERM_RGB }) {
  const inner = Math.max(0, width - 2);
  const lines = inner > 0 ? messages.flatMap((m) => wrapMessage(m, inner)).slice(-height) : [];
  while (lines.length < height) lines.unshift([]);
  const bg = bgOf(p.background);
  const colorOf = { text: p.color, system: p.system_color, accent: p.accent_color };
  return lines.map((line) => {
    if (width < 2) return blank(width);
    let s = "", used = 0;
    for (const part of line) {
      s += part.role === "me" ? effortName(part.text, level, now, p) : sgrFg(rgbOf(colorOf[part.role] ?? p.color)) + part.text;
      used += vlen(part.text);
    }
    return bg + " " + s + blank(inner - used) + " " + bgsgrBox(surface);
  });
}

export const chat = define({
  name: "chat",
  title: "Chat",
  description: "A chat log that plays conversations about the session; the platform's metrics library always plays, a skin adds libraries and conversations",
  accepts: ["conversation"],
  params: {
    libraries: param("list", [], "Conversation libraries played after the metrics library: game assets (<game>:<path>) or paths in the skin's folder; they run in the render daemon only"),
    drop: param("list", [], "Keys of conversations that never play"),
    conversations: param("map", {}, "The skin's own conversations by key (in quotes when the key has a dot), one \"role: text\" line per line; one with a library's key plays instead of it"),
    color: param("color", "#ffffff", "Colour of the messages"),
    system_color: param("color", "#ffff55", "Colour of plain lines"),
    accent_color: param("color", "#55ff55", "Colour of the parts of a line a library marks as accent"),
    background: param("color", "#1a1a1a", "Background of the chat strip", { keywords: ["term-bg"] }),
    effort_colors: param("map", { low: "#ff5555", medium: "#ffaa00", high: "#55ff55", xhigh: "#55ffff", max: "rainbow" },
      "Colour (#rrggbb, or rainbow) of the running model's name at each effort level; the message colour when unset"),
    rainbow: param("list", ["#ff5555", "#ffaa00", "#ffff55", "#55ff55", "#55ffff", "#5555ff", "#ff55ff"], "The colours a rainbow name cycles through (#rrggbb)"),
    width: param("integer", 40, "Columns of the chat when there is room, its padding included", { min: 4 }),
    min_width: param("integer", 18, "Columns the chat keeps when the bar is narrow", { min: 4 }),
    rows: param("integer", 6, "Rows of the chat", { min: 1 }),
  },
  widths: (p) => ({ min: Math.min(p.min_width, p.width), natural: p.width }),
  rows: (p) => p.rows,
  // The conversation libraries the script pass runs for this element.
  libraries: (p) => p.libraries,
  draw({ params: p, width, height = p.rows, surface = TERM_RGB, ctx = {}, script = {}, values = {} }) {
    const F = metricFacts(values);
    const libraries = script && Array.isArray(script.conversations) ? script.conversations : [];
    const now = typeof ctx.now === "number" ? ctx.now : 0;
    const { messages } = playChat({ facts: F, libraries, params: p, now, rows: height });
    return paintChat(messages, { width, height, params: p, level: F.effort, now, surface });
  },
});
