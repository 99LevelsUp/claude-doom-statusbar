// Animation visuals: frames from image assets drawn through the glyph raster.
//
//   animation     2D frames: a selection script picks a frame of the frames folder by name each
//                 render; without a frame from the script (the script is missing, disabled or not
//                 run) the default frame is drawn, and without that a blank
//   animation-3d  a 3D model; until there is a renderer for models it draws its default visual
//
// The frame is drawn at the glyph step the image asks for, never above what the session's terminal
// draws. Asset references are turned into file paths by the render context's resolveAsset; without
// it no asset can be found and the default visual is a blank.

import path from "node:path";
import { TERM_RGB } from "../ansi.js";
import { rgbOf, bgsgrBox } from "../colors.js";
import { STEPS, stepIndex } from "../raster/glyphs.js";
import { rasterize, rasterLine } from "../raster/asset-raster.js";
import { VALUE_TYPES } from "../../metrics/catalogue.js";
import { define, param } from "./schema.js";
import { block } from "./paint.js";

// An animation shows any value its script can read, but not a whole conversation.
const ANY_VALUE = VALUE_TYPES.filter((t) => t !== "conversation");

const sizeParams = () => ({
  width: param("integer", 9, "Columns the animation takes; the frame is centred in them", { min: 1 }),
  rows: param("integer", 4, "Rows the animation asks for; frames are drawn at the rows it is given", { min: 1 }),
  glyphs: param("text", "octant", "The richest glyph step the frames are drawn with; the terminal can only lower it", { allowed: STEPS }),
  background: param("color", "#000000", "Background the frames' transparent areas show", { keywords: ["term-bg"] }),
  default_frame: param("asset", "", "The image drawn when no frame comes from the script"),
});

// The richer of the image's step and the terminal's is never used.
function stepFor(own, terminal) {
  if (stepIndex(terminal) < 0) return own;
  return stepIndex(own) <= stepIndex(terminal) ? own : terminal;
}

const fileOf = (ref, ctx) => (ref && typeof ctx.resolveAsset === "function" ? ctx.resolveAsset(ref) : null);

// The image at `file` drawn as the element's lines, or null when it cannot be drawn.
function drawImage(file, p, width, height, ctx, surface) {
  if (!file) return null;
  const bg = p.background === "term-bg" ? "term-bg" : rgbOf(p.background);
  const rows = rasterize(file, height, { step: stepFor(p.glyphs, ctx.step), background: bg === "term-bg" ? [0, 0, 0] : bg });
  if (!rows) return null;
  const restore = bgsgrBox(surface);
  return Array.from({ length: height }, (_, r) => rasterLine(rows[r] || [], width, bg) + restore);
}

// The default visual: the default frame, else a blank that keeps the element's place.
const drawDefault = (p, width, height, ctx, surface) =>
  drawImage(fileOf(p.default_frame, ctx), p, width, height, ctx, surface) ?? block([], width, height);

const widths = (p) => ({ min: p.width, natural: p.width });

export const animation = define({
  name: "animation",
  title: "2D animation",
  description: "Image frames from an asset folder, the frame picked each render by a selection script",
  accepts: ANY_VALUE,
  params: {
    frames: param("asset", "", "The folder of frame images"),
    script: param("asset", "", "The selection script that picks a frame by name"),
    ...sizeParams(),
  },
  widths,
  rows: (p) => p.rows,
  draw({ params: p, width, height = p.rows, ctx = {}, script = {}, surface = TERM_RGB }) {
    const dir = script.frame ? fileOf(p.frames, ctx) : null;
    const name = dir ? String(script.frame) : "";
    const file = dir ? path.join(dir, path.extname(name) ? name : `${name}.png`) : null;
    return drawImage(file, p, width, height, ctx, surface) ?? drawDefault(p, width, height, ctx, surface);
  },
});

export const animation3d = define({
  name: "animation-3d",
  title: "3D animation",
  description: "A 3D model; draws its default frame until the platform has a renderer for models",
  accepts: ANY_VALUE,
  params: {
    model: param("asset", "", "The 3D model"),
    script: param("asset", "", "The selection script that picks the model's pose"),
    ...sizeParams(),
  },
  widths,
  rows: (p) => p.rows,
  draw({ params: p, width, height = p.rows, ctx = {}, surface = TERM_RGB }) {
    return drawDefault(p, width, height, ctx, surface);
  },
});
