// The text visual: a value as text in a fixed number of columns. Text that links somewhere
// ({ text, url }) is drawn as a terminal hyperlink; text longer than its columns scrolls back and
// forth with the render tick or is clipped with an ellipsis.

import { sgrFg } from "../ansi.js";
import { vlen, marquee, wrapLink } from "../text.js";
import { rgbOf } from "../colors.js";
import { define, param } from "./schema.js";
import { isPlainObject } from "../is.js";
import { iconParam, alignParam, labelOf, labelWidth, block, pad, TEXT_HEX } from "./paint.js";

export function textOf(value) {
  if (isPlainObject(value)) {
    return { text: String(value.text ?? ""), url: value.url || null };
  }
  return { text: String(value ?? ""), url: null };
}

export const text = define({
  name: "text",
  title: "Text",
  description: "The value as text; a value longer than its columns scrolls or is clipped",
  accepts: ["text", "number", "percentage"],
  params: {
    icon: iconParam(),
    color: param("color", TEXT_HEX, "Colour of the text"),
    width: param("integer", 24, "Columns of the value when there is room", { min: 1 }),
    min_width: param("integer", 10, "Columns the value keeps when the bar is narrow", { min: 1 }),
    align: alignParam(),
    overflow: param("text", "scroll", "How a value longer than its columns fits: scroll back and forth, or clip it with an ellipsis", { allowed: ["scroll", "clip"] }),
    link: param("boolean", true, "Draw a value that links somewhere as a terminal hyperlink"),
    words: param("integer", 0, "Draw only the value's first this many words (a model's name without its version); 0 draws it all", { min: 0 }),
  },
  widths: (p) => ({ min: labelWidth(p) + Math.min(p.min_width, p.width), natural: labelWidth(p) + p.width }),
  rows: () => 1,
  draw({ value, params: p, width, height = 1, ctx = {} }) {
    const lbl = labelOf(p);
    const room = width - vlen(lbl);
    if (room < 0) return block([marquee(lbl, width, 0, "clip")], width, height);
    const { text: all, url } = textOf(value);
    const t = p.words > 0 ? all.trim().split(/\s+/).slice(0, p.words).join(" ") : all;
    const shown = url && p.link ? wrapLink(t, url) : t;
    const body = vlen(t) <= room ? pad(shown, room, p.align) : marquee(shown, room, ctx.tick ?? 0, p.overflow);
    return block([lbl + sgrFg(rgbOf(p.color)) + body], width, height);
  },
});
