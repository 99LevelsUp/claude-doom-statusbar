// The number visual: a count or a percentage, coloured by its value, with characters before and
// after it (a "↓" or a "%").

import { TEXT, sgrFg } from "../ansi.js";
import { vlen, marquee } from "../text.js";
import { colorFor } from "../colors.js";
import { define, param } from "./schema.js";
import { iconParam, alignParam, labelOf, labelWidth, block, pad } from "./paint.js";

export const number = define({
  name: "number",
  title: "Number",
  description: "The value as a number, coloured by how large it is",
  accepts: ["number", "percentage"],
  params: {
    icon: iconParam(),
    color: param("gradient", "", "How the number colours itself by its value; empty for the text colour"),
    prefix: param("text", "", "Characters drawn before the number"),
    suffix: param("text", "", "Characters drawn after the number"),
    width: param("integer", 5, "Columns of the number with its prefix and suffix", { min: 1 }),
    align: alignParam(),
  },
  widths: (p) => {
    const w = labelWidth(p) + p.width;
    return { min: w, natural: w };
  },
  rows: () => 1,
  draw({ value, params: p, width, height = 1 }) {
    const lbl = labelOf(p);
    const room = Math.max(0, width - vlen(lbl));
    const s = `${p.prefix}${value}${p.suffix}`;
    const body = vlen(s) <= room ? pad(s, room, p.align) : marquee(s, room, 0, "clip");
    return block([lbl + sgrFg(colorFor(p.color, Number(value)) ?? TEXT) + body], width, height);
  },
});
