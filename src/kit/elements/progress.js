// The progress visual: a bar filled to a percentage, partly filled cells drawn with finer
// characters, and the percentage after the bar or cut into its middle. The fill, partial and empty
// characters and their colours are parameters, so the same visual draws a smooth block bar or a
// line of "━" with its level in the middle.

import { TEXT, BOLD, TERM_RGB, sgrFg, sgrBg, pyround } from "../ansi.js";
import { colorFor, rgbOf, bgsgrBox } from "../colors.js";
import { define, param } from "./schema.js";
import { iconParam, labelOf, labelWidth, block, trackRgb } from "./paint.js";

const EIGHTHS = " ▏▎▍▌▋▊▉";
const BOLD_OFF = "\x1b[22m";

const percentWidth = (p) => (p.percent === "right" ? 5 : 0);

export const progress = define({
  name: "progress",
  title: "Progress bar",
  description: "A bar filled to the value's percentage, with the percentage beside it or in its middle",
  accepts: ["percentage"],
  params: {
    icon: iconParam(),
    color: param("gradient", "threshold", "How the filled part colours itself by the value"),
    cells: param("integer", 14, "Cells of the bar when there is room", { min: 1 }),
    min_cells: param("integer", 4, "Cells the bar keeps when the bar is narrow", { min: 1 }),
    percent: param("text", "right", "Where the percentage is drawn: after the bar, cut into its middle, or nowhere", { allowed: ["right", "middle", "none"] }),
    fill: param("text", "█", "Character of a filled cell", { length: 1 }),
    partials: param("text", EIGHTHS, "Characters of a partly filled cell, emptiest first, the first standing for empty; empty for whole cells only"),
    empty: param("text", " ", "Character of an empty cell", { length: 1 }),
    empty_color: param("color", "none", "Colour of the empty cells; none keeps the filled part's colour", { keywords: ["none"] }),
    track: param("color", "blend", "Background of the bar: blend (between the surface and the terminal), none, or a colour", { keywords: ["blend", "none"] }),
  },
  widths: (p) => {
    const fixed = labelWidth(p) + percentWidth(p);
    return { min: fixed + Math.min(p.min_cells, p.cells), natural: fixed + p.cells };
  },
  rows: () => 1,
  draw({ value: pct, params: p, width, height = 1, surface = TERM_RGB }) {
    const lbl = labelOf(p);
    const pctW = percentWidth(p);
    const cells = Math.max(0, width - labelWidth(p) - pctW);
    const c = colorFor(p.color, pct) ?? TEXT;
    const partials = [...p.partials];
    const steps = Math.max(1, partials.length);
    const units = Math.max(0, pyround((pct / 100) * cells * steps));
    const full = Math.min(cells, Math.floor(units / steps));
    const rem = full < cells ? units % steps : 0;

    const glyphs = []; // [character, "lit" | "empty" | "mid"], one per cell
    for (let i = 0; i < full; i++) glyphs.push([p.fill, "lit"]);
    if (rem) glyphs.push([partials[rem], "lit"]);
    while (glyphs.length < cells) glyphs.push([p.empty, "empty"]);
    if (p.percent === "middle") {
      const mid = [...` ${pyround(pct)} `];
      if (mid.length <= cells) {
        const at = Math.floor((cells - mid.length) / 2);
        mid.forEach((ch, i) => { glyphs[at + i] = [ch, "mid"]; });
      }
    }

    const track = p.track === "none" ? null : p.track === "blend" ? trackRgb(surface) : rgbOf(p.track);
    const emptyRgb = p.empty_color === "none" ? null : rgbOf(p.empty_color);
    let s = lbl + (track ? sgrBg(track) : "") + sgrFg(c);
    let state = "lit";
    for (const [ch, kind] of glyphs) {
      if (kind !== state) {
        if (state === "mid") s += BOLD_OFF;
        if (kind === "lit") s += sgrFg(c);
        else if (kind === "mid") s += BOLD + sgrFg(c);
        else if (emptyRgb) s += sgrFg(emptyRgb);
        state = kind;
      }
      s += ch;
    }
    if (state === "mid") s += BOLD_OFF;
    if (track) s += bgsgrBox(surface);
    if (pctW) s += sgrFg(c) + " " + String(pct).padStart(3) + "%";
    return block([s], width, height);
  },
});
