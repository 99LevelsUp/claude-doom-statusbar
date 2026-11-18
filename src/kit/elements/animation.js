// Animation visuals: frames from image assets drawn through the glyph raster.
//
//   animation     2D frames: a selection script picks a frame of the frames folder by name each
//                 render; without a frame from the script (the script is missing, disabled or not
//                 run, or names a path rather than a file of the folder) the default frame is
//                 drawn, and without that a blank
//   animation-3d  a 3D model; until there is a renderer for models it draws its default visual
//
// The frame is drawn at the glyph step the image asks for, never above what the session's terminal
// draws. Asset references are turned into file paths by the render context's resolveAsset; without
// it no asset can be found and the default visual is a blank.
//
// Every frame of a 2D animation is drawn on one canvas, the size of the folder's largest frame
// (frameCanvas), so frames of different sizes keep one scale and one place and the animation never
// jumps. With `width = 0` the animation is as wide as that canvas drawn at its `rows`: no column of
// padding beside the frame. At more rows than that width allows, the frame is drawn at the most rows
// that fit and centred in the rest.

import path from "node:path";
import { TERM_RGB } from "../ansi.js";
import { rgbOf, bgsgrBox } from "../colors.js";
import { STEPS, stepIndex } from "../raster/glyphs.js";
import { rasterize, rasterLine, frameCanvas, imageSize } from "../raster/asset-raster.js";
import { faceSize } from "../raster/glyph-render.js";
import { VALUE_TYPES } from "../../metrics/catalogue.js";
import { define, param } from "./schema.js";
import { block, fixedWidth } from "./paint.js";

const ANY_VALUE = VALUE_TYPES.filter((t) => t !== "conversation");

const sizeParams = () => ({
  width: param("integer", 0, "Columns the animation takes, the frame centred in them; 0 sizes it to its largest frame drawn at `rows`", { min: 0 }),
  rows: param("integer", 4, "Rows the animation asks for and is sized for; frames are drawn at the rows it is given, as many as its width allows", { min: 1 }),
  glyphs: param("text", "octant", "The richest glyph step the frames are drawn with; the terminal can only lower it", { allowed: STEPS }),
  background: param("color", "#000000", "Background the frames' transparent areas show", { keywords: ["term-bg"] }),
  default_frame: param("asset", "", "The image drawn when no frame comes from the script"),
});

function lowerStep(own, terminal) {
  if (stepIndex(terminal) < 0) return own;
  return stepIndex(own) <= stepIndex(terminal) ? own : terminal;
}

const fileOf = (ref, ctx) => (ref && typeof ctx.resolveAsset === "function" ? ctx.resolveAsset(ref) : null);

// A frame name a script returns is a plain file name in the frames folder: no folder part, no
// separator of any system, not "." or "..". Anything else would lead out of the folder.
const plainName = (name) => name !== "" && name !== "." && name !== ".." && !/[\\/]/.test(name) && path.basename(name) === name;

// The canvas every frame is drawn on, in pixels: the largest frame of the `frames` folder (a 2D
// animation's), else the default frame's size; null when neither can be found.
function canvasOf(p, ctx, frames = null) {
  const dir = frames ? fileOf(frames, ctx) : null;
  const fromFrames = dir ? frameCanvas(dir) : null;
  if (fromFrames) return fromFrames;
  const file = fileOf(p.default_frame, ctx);
  return file ? imageSize(file) : null;
}

// The most rows, up to `height`, at which the canvas is drawn no wider than `width` columns.
function rowsWithin(canvas, width, height) {
  for (let r = height; r > 1; r--) if (faceSize(canvas.width, canvas.height, r).cols <= width) return r;
  return 1;
}

// The image at `file` drawn as the element's lines, or null when it cannot be drawn.
function drawImage(file, p, width, height, ctx, surface, canvas) {
  if (!file) return null;
  const bg = p.background === "term-bg" ? "term-bg" : rgbOf(p.background);
  const drawn = canvas ? rowsWithin(canvas, width, height) : height;
  const rows = rasterize(file, drawn, { step: lowerStep(p.glyphs, ctx.step), background: rgbOf(p.background), canvas });
  if (!rows) return null;
  const top = Math.floor((height - rows.length) / 2);
  const restore = bgsgrBox(surface);
  return Array.from({ length: height }, (_, r) => rasterLine(rows[r - top] || [], width, bg) + restore);
}

// The default visual: the default frame, else a blank that keeps the element's place.
const drawDefault = (p, width, height, ctx, surface, canvas) =>
  drawImage(fileOf(p.default_frame, ctx), p, width, height, ctx, surface, canvas) ?? block([], width, height);

// A width of 0: the canvas drawn at the animation's rows, or two columns a row when there is no
// canvas to measure (the asset is not there yet).
function sizedWidth(p, canvas) {
  if (p.width > 0) return fixedWidth(p.width);
  return fixedWidth(canvas ? faceSize(canvas.width, canvas.height, p.rows).cols : p.rows * 2);
}

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
  widths: (p, value, ctx = {}) => sizedWidth(p, canvasOf(p, ctx, p.frames)),
  rows: (p) => p.rows,
  draw({ params: p, width, height = p.rows, ctx = {}, script = {}, surface = TERM_RGB }) {
    const name = script.frame ? String(script.frame) : "";
    const dir = plainName(name) ? fileOf(p.frames, ctx) : null;
    const file = dir ? path.join(dir, path.extname(name) ? name : `${name}.png`) : null;
    const canvas = canvasOf(p, ctx, p.frames);
    return drawImage(file, p, width, height, ctx, surface, canvas) ?? drawDefault(p, width, height, ctx, surface, canvas);
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
  widths: (p, value, ctx = {}) => sizedWidth(p, canvasOf(p, ctx)),
  rows: (p) => p.rows,
  draw({ params: p, width, height = p.rows, ctx = {}, surface = TERM_RGB }) {
    return drawDefault(p, width, height, ctx, surface, canvasOf(p, ctx));
  },
});
