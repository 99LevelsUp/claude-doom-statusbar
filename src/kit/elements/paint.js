// Small drawing helpers the visuals share: the label in front of a value, blank lines, padding by
// display width and the background blend a track is drawn on.

import { TERM_RGB } from "../ansi.js";
import { vlen } from "../text.js";
import { param } from "./schema.js";

// Parameters several visuals share.
export const iconParam = () => param("text", "", "An icon or word drawn in front of the value");
export const alignParam = () => param("text", "left", "Where a value shorter than its columns sits", { allowed: ["left", "center", "right"] });

// The icon in front of a value and the space after it, or nothing.
export const labelOf = (p) => (p.icon ? p.icon + " " : "");
export const labelWidth = (p) => vlen(labelOf(p));

export const blank = (width) => " ".repeat(Math.max(0, width));

// `lines` cut or padded with blank lines to `height`.
export function block(lines, width, height) {
  const out = lines.slice(0, height);
  while (out.length < height) out.push(blank(width));
  return out;
}

// `text` that fits `width` columns, padded to exactly `width` by `align` (left, center, right).
export function pad(text, width, align = "left") {
  const room = Math.max(0, width - vlen(text));
  if (align === "right") return blank(room) + text;
  if (align === "center") {
    const left = Math.floor(room / 2);
    return blank(left) + text + blank(room - left);
  }
  return text + blank(room);
}

// Halfway between the surface and the terminal background: the empty part of a bar or graph.
export const trackRgb = (surface) => [0, 1, 2].map((i) => Math.floor((surface[i] + TERM_RGB[i]) / 2));

export const TEXT_HEX = "#b6bac8";
