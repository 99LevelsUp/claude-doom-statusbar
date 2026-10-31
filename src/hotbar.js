// "hotbar" layout — the in-game survival HUD instead of a row of boxes:
//
//  <Sonnet 5.5> gg                      ♥  ♥  ♥  ♥  ♥  ♡  ♡    🍖 🍖 🍖 🦴 🦴   <- hearts | hunger
//  Opus 5.5 has made the advanc…        ━━━━━━━━━━━━━━━━ 31 ━━━━━━━━━━━━━━━━━━   <- XP + level
//  <Opus 5.5> hi! busy rn               ┏━━━━━━━┳━━━━━━━┳━━━━━━━┳ ...
//                                       ┃  🪓   ┃  💎   ┃  🌿   ┃ ...          <- 9 slots
//                                       ┃  1M   ┃ $1.83 ┃   3   ┃ ...          <- their values
//                                       ┗━━━━━━━┻━━━━━━━┻━━━━━━━┻ ...
//
// Chosen by a preset with [bar] layout = "hotbar"; the [hotbar] table names which metric
// feeds the hearts / hunger / XP, and each [[slot]] is { icon, id }. The chat on the left
// is the looping script in chat.js.

import { RESET, BOLD, sgrFg as f, sgrBg as b, pyround } from "./ansi.js";
import { vlen } from "./render.js";
import { parseSprite } from "./pixelface.js";
import { chatLog } from "./chat.js";

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const C = {
  heart: hex("#ff3b3b"), heartOff: hex("#c07070"), heartFlash: hex("#ffd0d0"), gold: hex("#ffd84a"),
  xp: hex("#80ff20"), xpOff: hex("#1f3a12"),
  frame: hex("#8b8b8b"), selected: hex("#ffffff"), slot: hex("#262626"),
  text: hex("#ffffff"), dead: hex("#ff5555"),
  chatBg: hex("#1a1a1a"), chatText: hex("#ffffff"), system: hex("#ffff55"), adv: hex("#55ff55"),
};
// The selected model's name in chat is coloured by reasoning effort (the moon icon):
// full moon / sun = bright green, half moon = orange, dark moon = red.
// The selected model's name in chat is coloured by reasoning effort (the moon icon):
//   low 🌒 red · medium 🌓 orange · high 🌔 green · xhigh 🌕 diamond aqua · max 🌞 rainbow
const EFFORT_COLOR = {
  low: hex("#ff5555"), medium: hex("#ffaa00"), high: hex("#55ff55"), xhigh: hex("#55ffff"),
};
const RAINBOW = ["#ff5555", "#ffaa00", "#ffff55", "#55ff55", "#55ffff", "#5555ff", "#ff55ff"].map(hex);

// Colour a name for its effort level. "max" is a rainbow that drifts one step per second.
function effortName(name, level, now) {
  if (level === "max") {
    return [...name].map((ch, i) => f(RAINBOW[(i + Math.floor(now)) % RAINBOW.length]) + ch).join("");
  }
  return f(EFFORT_COLOR[level] || C.chatText) + name;
}

const IDLE_SWITCH = 7;  // seconds between idle slot changes
const REACT_HOLD = 6;   // seconds the slot stays on what just happened

// How many of `per` glyphs stay lit for a used-% value (missing value = all lit).
const fillOf = (usedPct, per) =>
  (usedPct == null ? per : Math.max(0, Math.min(per, pyround(((100 - usedPct) / 100) * per))));

// Fit plain text into `w` columns: clipped, then centred (or left-aligned).
function fit(text, w, align = "center") {
  let s = String(text ?? "");
  while (vlen(s) > w) s = [...s].slice(0, -1).join("");
  const pad = w - vlen(s);
  if (align === "left") return s + " ".repeat(pad);
  const l = Math.floor(pad / 2);
  return " ".repeat(l) + s + " ".repeat(pad - l);
}

// Deterministic "random" pick, so every render in the same second agrees.
function pick(seed, n) {
  let x = Math.imul(seed, 0x9e3779b1) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x85ebca77) >>> 0;
  return ((x ^ (x >>> 13)) >>> 0) % n;
}

// A row of `per` glyphs spread over `span` columns, as positioned cells.
function glyphCells(per, lit, span, gw, on, off, onCol, offCol, fromRight) {
  const gap = per > 1 ? Math.max(1, Math.floor((span - per * gw) / (per - 1))) : 0;
  const width = per * gw + (per - 1) * gap;
  const cells = [];
  for (let i = 0; i < per; i++) {
    const isLit = fromRight ? i >= per - lit : i < lit;
    cells.push({ x: i * (gw + gap), glyph: isLit ? on : off, color: isLit ? onCol : offCol });
  }
  return { cells, width };
}

// Paint positioned cells into a `w`-column line.
function paint(w, cells) {
  let s = "", col = 0;
  for (const c of [...cells].sort((p, q) => p.x - q.x)) {
    if (c.x < col) continue;
    s += " ".repeat(c.x - col) + (c.color ? f(c.color) : "") + c.glyph;
    col = c.x + vlen(c.glyph);
  }
  return s + " ".repeat(Math.max(0, w - col));
}

// The selected slot: what just happened (an error, a write, a finished task) if it was
// recent, otherwise an idle pick that wanders every few seconds like a player scrolling.
function selectedSlot(slots, hb, { expr, exprAge, now }) {
  const react = hb.react || {};
  if (expr && exprAge < REACT_HOLD && react[expr]) {
    const at = slots.findIndex((s) => s.id === react[expr]);
    if (at >= 0) return at;
  }
  return pick(Math.floor(now / IDLE_SWITCH), slots.length);
}

// The chat column: the last `rows` messages, each clipped to `w` columns, on a dark strip.
function chatColumn(values, now, rows, w) {
  const level = values["model.effort_level"];
  return chatLog(values, now, rows).map((parts) => {
    let s = "", used = 0;
    for (const p of parts) {
      if (used >= w) break;
      let t = p.text;
      if (used + vlen(t) > w) { t = [...t].slice(0, Math.max(0, w - used - 1)).join("") + "…"; }
      if (p.role === "me") s += effortName(t, level, now);
      else s += f(p.role === "system" ? C.system : p.role === "adv" ? C.adv : C.chatText) + t;
      used += vlen(t);
    }
    return b(C.chatBg) + " " + s + " ".repeat(Math.max(0, w - used)) + " " + RESET;
  });
}

// Render the hotbar HUD. `values` are the statusline metric values; `opts`:
//   sprite     the DOOM sprite the mugshot would show (hurt / invulnerable flashes)
//   exhausted  out of usage -> "You died!"
//   now        seconds; drives the idle slot, the chat and the rainbow
//   expr, exprAge  the last hook reaction and how long ago, for the reacting slot
//   indent     columns Claude Code shifts the status line right (default 2), so the
//              hotbar lands in the true centre of the terminal
export function buildHotbar(cfg, target, values, opts = {}) {
  const { sprite = "STFST01", exhausted = false, now = Date.now() / 1000, indent = 2 } = opts;
  const hb = cfg.hotbar || {};
  const all = (cfg.slot || []).slice(0, 9);
  const flash = parseSprite(sprite).expr;

  // Slots are an ODD number of columns wide (7, or 5 when narrow), so the mostly
  // odd-length values ($1.83, 2/5, 17%) sit exactly in the middle. Narrower than nine
  // 5-wide slots, the rightmost slots drop off instead of overflowing.
  let n = all.length || 9;
  let inner = Math.max(5, Math.min(7, Math.floor((target - (n + 1)) / n)));
  if (inner % 2 === 0) inner -= 1;
  while (n > 1 && n * inner + n + 1 > target) n--;
  const slots = all.slice(0, n);
  const W = n * inner + n + 1;
  const padN = Math.max(0, Math.floor((target - W) / 2) - indent);
  const sel = slots.length ? selectedSlot(slots, hb, { ...opts, now }) : -1;

  const rows = [];
  // Hearts (left half) and hunger (right half), spread across their half of the bar.
  const half = Math.floor(W / 2) - 1;
  const per = half >= 29 ? 10 : 5; // ten 2-column shanks + gaps need 29 columns
  const hearts = glyphCells(per, exhausted ? 0 : fillOf(values[hb.hearts], per), half, 1, "♥", "♡",
    flash === "god" ? C.gold : flash === "ouch" ? C.heartFlash : C.heart, C.heartOff, false);
  const food = glyphCells(per, fillOf(values[hb.hunger], per), half, 2, "🍖", "🦴",
    null, null, true);
  const foodX = W - food.width;
  const placed = [...hearts.cells, ...food.cells.map((c) => ({ ...c, x: c.x + foodX }))];
  rows.push(exhausted ? BOLD + f(C.dead) + fit("You died!", W) + "\x1b[22m" : paint(W, placed));

  // XP bar across the hotbar width, with the level number cut into its middle.
  const xpPct = Math.max(0, Math.min(100, Number(values[hb.xp] ?? 0)));
  const level = hb.level && values[hb.level] != null ? String(values[hb.level]) : String(pyround(xpPct));
  const lvl = ` ${level} `;
  const at = Math.floor((W - vlen(lvl)) / 2);
  const lit = pyround((xpPct / 100) * W);
  let xp = "";
  for (let i = 0; i < W; i++) {
    if (i === at) { xp += BOLD + f(C.xp) + lvl + "\x1b[22m"; i += vlen(lvl) - 1; continue; }
    xp += f(i < lit ? C.xp : C.xpOff) + "━";
  }
  rows.push(xp);

  // The hotbar: heavy box-drawing lines shared between slots; the selected slot's lines
  // (and the corners it shares with its neighbours) turn white.
  const edge = (k) => (k === sel || k - 1 === sel ? C.selected : C.frame); // border left of slot k
  const rule = (l, m, r) => {
    let s = "";
    for (let k = 0; k < n; k++) s += f(edge(k)) + (k === 0 ? l : m) + f(k === sel ? C.selected : C.frame) + "━".repeat(inner);
    return s + f(edge(n)) + r;
  };
  const cellRow = (content) => {
    let s = "";
    for (let k = 0; k < n; k++) s += RESET + f(edge(k)) + "┃" + b(C.slot) + f(C.text) + content(slots[k] || {});
    return s + RESET + f(edge(n)) + "┃";
  };
  rows.push(rule("┏", "┳", "┓"));
  rows.push(cellRow((s) => fit(s.icon || "", inner)));
  rows.push(cellRow((s) => BOLD + fit(s.id && values[s.id] != null ? values[s.id] : "", inner) + "\x1b[22m"));
  rows.push(rule("┗", "┻", "┛"));

  // Chat on the left, bottom-aligned like the game's, when there is room beside the bar.
  const CHAT_MAX = 44; // the game's chat box has a fixed width too
  const chatW = Math.min(CHAT_MAX, padN - 4); // leave a gap before the hotbar (2 = the strip's own padding)
  const chat = chatW >= 16 ? chatColumn(values, now, rows.length, chatW) : null;
  const lines = rows.map((r, i) => {
    const left = chat ? chat[i] + " ".repeat(padN - (chatW + 2)) : " ".repeat(padN);
    return RESET + left + RESET + r + RESET;
  });
  return { lines, width: W, selected: sel };
}
