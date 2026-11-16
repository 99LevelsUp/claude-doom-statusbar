// Visuals drawn with icons.
//
//   icon-row  a row of glyphs filled by a percentage: hearts, food, a power gauge
//   icon      a value drawn as the icon its map gives it (an effort level as a moon, a permission
//             mode as its sign), and a list of [name, value] pairs as each name's icon and value

import { TEXT, sgrFg, pyround } from "../ansi.js";
import { vlen, marquee } from "../text.js";
import { colorFor, rgbOf } from "../meters.js";
import { define, param } from "./schema.js";
import { iconParam, alignParam, labelOf, labelWidth, block, pad, blank, TEXT_HEX } from "./paint.js";
import { textOf } from "./text.js";

const glyphWidth = (p) => Math.max(vlen(p.glyph), vlen(p.empty_glyph));
const percentWidth = (p) => (p.show_pct ? 5 : 0);

export const iconRow = define({
  name: "icon-row",
  title: "Icon row",
  description: "A row of glyphs filled by the value's percentage, such as hearts",
  accepts: ["percentage"],
  params: {
    icon: iconParam(),
    count: param("integer", 10, "Glyphs in the row", { min: 1 }),
    glyph: param("text", "■", "A filled glyph"),
    empty_glyph: param("text", "■", "An empty glyph"),
    color: param("gradient", "threshold", "How the filled glyphs colour themselves by the value"),
    empty_color: param("color", "#5a5f78", "Colour of the empty glyphs"),
    gap: param("integer", 0, "Spaces between glyphs", { min: 0 }),
    invert: param("boolean", false, "Fill by what is left (100 minus the value), so a used percentage reads as what remains"),
    from_right: param("boolean", false, "Fill from the right end of the row"),
    show_pct: param("boolean", false, "Draw the percentage after the row"),
  },
  widths: (p) => {
    const w = labelWidth(p) + p.count * glyphWidth(p) + (p.count - 1) * p.gap + percentWidth(p);
    return { min: w, natural: w };
  },
  rows: () => 1,
  draw({ value: pct, params: p, width, height = 1 }) {
    const v = p.invert ? 100 - pct : pct;
    const filled = Math.max(0, Math.min(p.count, pyround((v / 100) * p.count)));
    const on = sgrFg(colorFor(p.color, v) ?? TEXT);
    const off = sgrFg(rgbOf(p.empty_color));
    const gw = glyphWidth(p);
    const cells = [];
    for (let i = 0; i < p.count; i++) {
      const lit = p.from_right ? i >= p.count - filled : i < filled;
      cells.push(lit ? on + pad(p.glyph, gw) : off + pad(p.empty_glyph, gw));
    }
    let s = labelOf(p) + cells.join(blank(p.gap));
    if (p.show_pct) s += on + " " + String(v).padStart(3) + "%";
    return block([s + blank(width - vlen(s))], width, height);
  },
});

// Platform icons for the values the metrics report as names: effort levels, permission modes,
// the thinking and fast flags, and the parts of a git working state.
export const PLATFORM_ICONS = Object.freeze({
  low: "🌒", medium: "🌓", high: "🌔", xhigh: "🌕", max: "🌞",
  plan: "📋", auto: "⏩", acceptEdits: "⏩", bypassPermissions: "⏩",
  thinking: "💭", fast: "🚀",
  changed: "✎", behind: "↓", ahead: "↑",
});

export const icon = define({
  name: "icon",
  title: "Icon",
  description: "The value as the icon its map gives it; a list of [name, value] pairs as each name's icon and value",
  accepts: ["text", "list"],
  params: {
    icon: iconParam(),
    icons: param("map", PLATFORM_ICONS, "The icon for each value or name; a value without one is drawn as it is"),
    show_text: param("boolean", false, "Draw a single value's text after its icon"),
    sep: param("text", "  ", "What separates the items of a list"),
    color: param("color", TEXT_HEX, "Colour of the text beside the icons"),
    width: param("integer", 2, "Columns of the icons and text", { min: 1 }),
    align: alignParam(),
  },
  widths: (p) => {
    const w = labelWidth(p) + p.width;
    return { min: w, natural: w };
  },
  rows: () => 1,
  draw({ value, params: p, width, height = 1 }) {
    const iconOf = (name) => (Object.hasOwn(p.icons, name) ? p.icons[name] : null);
    let s;
    if (Array.isArray(value)) {
      s = value.map((item) => {
        if (Array.isArray(item)) return `${iconOf(String(item[0])) ?? item[0]} ${item[1]}`;
        return iconOf(String(item)) ?? String(item);
      }).join(p.sep);
    } else {
      const t = textOf(value).text;
      const ic = iconOf(t);
      s = ic === null ? t : p.show_text ? `${ic} ${t}` : ic;
    }
    const lbl = labelOf(p);
    const room = Math.max(0, width - vlen(lbl));
    const body = vlen(s) <= room ? pad(s, room, p.align) : marquee(s, room, 0, "clip");
    return block([lbl + sgrFg(rgbOf(p.color)) + body], width, height);
  },
});
