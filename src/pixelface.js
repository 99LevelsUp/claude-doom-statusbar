// Pixel-art mugshots for the non-DOOM themes (minecraft, satisfactory).
//
// The DOOM theme rasterises real sprites through chafa. The other themes draw small,
// original 8x8 pixel faces straight from code instead: no image files, no chafa. Each
// pair of pixel rows becomes one terminal row of half-blocks (▀ / ▄), so pixels come out
// square. The face scales by whole pixels to the HUD height, and a one-row "caption"
// (hearts, a power gauge) goes under it once there is room.
//
// The statusline still asks for faces by DOOM sprite name (STFST21, STFOUCH3, STFDEAD0…),
// so every theme reacts to exactly the same events. parseSprite() turns a name into
// { expr, hp, glance } and each theme decides how that looks.
//
// Output format matches face.js loadFace(): `rows` arrays of [char, fg, bg] cells, where
// fg/bg is [r,g,b] or null (= transparent, composited onto the mugshot background).

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const grey = (c) => { const y = Math.round(0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]); return [y, y, y]; };

// "STFST21" -> { expr: "idle", hp: 2, glance: 1 }. hp is 0 (healthy) .. 4 (nearly dead).
export function parseSprite(name) {
  const s = String(name || "");
  if (s === "STFDEAD0") return { expr: "dead", hp: 4, glance: 1 };
  if (s === "STFGOD0") return { expr: "god", hp: 0, glance: 1 };
  let m;
  if ((m = /^STF(OUCH|KILL|EVL)(\d)$/.exec(s))) return { expr: m[1].toLowerCase(), hp: +m[2], glance: 1 };
  if ((m = /^STF(TL|TR)(\d)0$/.exec(s))) return { expr: m[1].toLowerCase(), hp: +m[2], glance: m[1] === "TL" ? 0 : 2 };
  if ((m = /^STFST(\d)(\d)$/.exec(s))) return { expr: "idle", hp: +m[1], glance: +m[2] };
  return { expr: "idle", hp: 0, glance: 1 };
}

// Replace characters in one grid row, starting at column x.
function put(grid, y, x, str) {
  const row = [...grid[y]];
  [...str].forEach((ch, i) => { if (ch !== "_") row[x + i] = ch; }); // "_" = leave as is
  grid[y] = row.join("");
}

// --- Minecraft-style: a blocky miner -------------------------------------------------------
// An original 8x8 character (sandy hair, green eyes), not a copy of any game texture.
const MC_PAL = {
  H: hex("#c8a050"), h: hex("#9c7432"), // hair, hair shade
  S: hex("#e8b48c"), s: hex("#c98e68"), // skin, skin shade
  W: hex("#ffffff"), E: hex("#3aa04a"), // eye white, iris
  M: hex("#7a3c28"), K: hex("#2a1a14"), // mouth, dark
};
const MC_BASE = [
  "HHHHHHHH",
  "HhHHHHhH",
  "HSSSSSSH",
  "SSSSSSSS",
  "SWEssEWS",
  "SSSssSSS",
  "SSMMMMSS",
  "SSSSSSSS",
];

function minecraftGrid({ expr, hp, glance }) {
  const g = [...MC_BASE];
  // Eyes: the iris follows the glance (0 left, 1 centre, 2 right).
  if (glance === 0) put(g, 4, 1, "EW__EW");
  else if (glance === 2) put(g, 4, 1, "WE__WE");
  if (expr === "ouch") put(g, 4, 1, "KK__KK");               // squeezed shut
  if (expr === "evl") { put(g, 3, 1, "KK__KK"); put(g, 6, 2, "MMMM"); } // angry brows
  if (expr === "kill") { put(g, 6, 1, "M____M"); put(g, 7, 2, "MMMM"); } // big grin
  if (expr === "dead") { put(g, 3, 1, "K_K"); put(g, 4, 1, "_K_"); put(g, 5, 1, "K_K");
    put(g, 3, 4, "K_K"); put(g, 4, 4, "_K_"); put(g, 5, 4, "K_K"); put(g, 6, 2, "SMMS"); }
  if (expr !== "kill" && expr !== "dead" && hp >= 3) { put(g, 6, 2, "SMMS"); put(g, 7, 1, "_M__M_"); } // frown
  return g;
}

function minecraftColor(ch, { expr, hp }) {
  let c = MC_PAL[ch];
  if (!c) return null;
  if (expr === "dead") return mix(grey(c), [40, 40, 40], 0.3);
  if (expr === "god") return mix(c, hex("#ffd84a"), 0.45);  // golden glow
  if (expr === "ouch") return mix(c, hex("#ff2020"), 0.55); // the red hurt flash
  return mix(c, hex("#ff3030"), hp * 0.07);                 // reddens as health drops
}

// Hearts under the face: one heart lost per health step, gold while invulnerable.
function minecraftCaption({ expr, hp }) {
  const full = expr === "dead" ? 0 : 5 - Math.min(hp, 4);
  const on = expr === "god" ? hex("#ffd84a") : hex("#ff3b3b");
  const off = hex("#5a2a2a");
  // Spaced out ("♥ ♥ ♥ ♡ ♡"); a null colour is a plain gap cell.
  return Array.from({ length: 9 }, (_, i) => (i % 2 ? [" ", null]
    : i / 2 < full ? ["♥", on] : ["♡", off]));
}

// --- Satisfactory-style: an engineer in a work helmet --------------------------------------
// An original 8x8 helmet with a glowing visor. The visor colour reads health at a glance.
const SF_PAL = {
  O: hex("#f39a2e"), o: hex("#b86a1a"), // helmet orange, shade
  G: hex("#8a8f98"), K: hex("#2a2d33"), // fittings grey, dark
  V: null,                              // visor: depends on health (see sfVisor)
  v: null,                              // visor highlight / eyes
};
const SF_BASE = [
  "..OOOO..",
  ".OOOOOO.",
  "OOoOOoOO",
  "OVVVVVVO",
  "OVvVVvVO",
  "OVVVVVVO",
  "oOGKKGOo",
  ".oGKKGo.",
];
const SF_VISOR = ["#38d6f0", "#3ae0b0", "#e8d040", "#ff4a4a", "#c81e1e"].map(hex);

function satisfactoryGrid({ expr, glance }) {
  const g = [...SF_BASE];
  if (glance === 0) put(g, 4, 1, "vVVvVV");
  else if (glance === 2) put(g, 4, 1, "VVvVVv");
  if (expr === "kill") { put(g, 3, 1, "VvVVvV"); put(g, 4, 1, "vVvvVv"); } // ^ ^ happy eyes
  if (expr === "evl") { put(g, 3, 1, "vVVVVv"); put(g, 4, 1, "VvVVvV"); }  // \ / angry eyes
  if (expr === "ouch") { put(g, 3, 1, "VVvVVV"); put(g, 4, 1, "VvVvVV"); put(g, 5, 1, "vVVVvV"); } // cracked
  if (expr === "dead") { put(g, 3, 1, "VvVVvV"); put(g, 4, 1, "VVvvVV"); put(g, 5, 1, "VvVVvV"); } // X X
  return g;
}

function satisfactoryColor(ch, { expr, hp }) {
  let visor = SF_VISOR[Math.min(hp, 4)];
  if (expr === "god") visor = hex("#ffd84a");
  if (expr === "ouch") visor = hex("#ff3b30");
  if (expr === "dead") visor = hex("#151515");
  let c;
  if (ch === "V") c = visor;
  else if (ch === "v") c = expr === "dead" ? hex("#ff3b30") : mix(visor, [255, 255, 255], 0.75);
  else c = SF_PAL[ch];
  if (!c) return null;
  if (expr === "dead" && ch !== "v") return mix(grey(c), [30, 30, 30], 0.3);
  return c;
}

// A five-cell power gauge; it reads FUSE! when the grid has tripped (out of usage).
function satisfactoryCaption({ expr, hp }) {
  if (expr === "dead") return [..."FUSE!"].map((ch) => [ch, hex("#ff3b30")]);
  const full = 5 - Math.min(hp, 4);
  const on = expr === "god" ? hex("#ffd84a") : SF_VISOR[Math.min(hp, 4)];
  return Array.from({ length: 5 }, (_, i) => (i < full ? ["▰", on] : ["▱", hex("#4a4f58")]));
}

const THEMES = {
  minecraft: { grid: minecraftGrid, color: minecraftColor, caption: minecraftCaption },
  satisfactory: { grid: satisfactoryGrid, color: satisfactoryColor, caption: satisfactoryCaption },
};

export const PIXEL_FACES = Object.keys(THEMES);

// Render a theme's face for a DOOM sprite name at exactly `rows` terminal rows.
export function pixelFace(theme, spriteName, rows) {
  const t = THEMES[theme];
  const st = parseSprite(spriteName);
  const grid = t.grid(st);
  const gw = grid[0].length, gh = grid.length;

  const withCaption = rows >= 5;
  const area = withCaption ? rows - 1 : rows;            // terminal rows for the face itself
  const scale = Math.max(1, Math.floor((2 * area) / gh)); // whole-pixel scaling keeps it crisp
  const px = (x, y) => t.color(grid[Math.floor(y / scale)][Math.floor(x / scale)], st);
  const W = gw * scale, H = gh * scale;

  const faceRows = [];
  for (let y = 0; y < H; y += 2) {
    const row = [];
    for (let x = 0; x < W; x++) {
      const top = px(x, y), bot = y + 1 < H ? px(x, y + 1) : null;
      if (top && bot) row.push(["▀", top, bot]);
      else if (top) row.push(["▀", top, null]);
      else if (bot) row.push(["▄", bot, null]);
      else row.push([" ", null, null]);
    }
    faceRows.push(row);
  }

  const out = [];
  const padTop = Math.max(0, Math.floor((area - faceRows.length) / 2));
  for (let i = 0; i < padTop; i++) out.push([]);
  out.push(...faceRows.slice(0, area));
  while (out.length < area) out.push([]);
  if (withCaption) out.push(t.caption(st).map(([ch, fg]) => [ch, fg, null]));
  return out;
}
