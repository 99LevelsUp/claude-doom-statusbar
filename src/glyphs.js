// Glyph table for the built-in image-to-glyph conversion.
//
// Every glyph is described by the polygons it fills inside a unit cell (x right, y down, 0..1),
// so the same shapes give the 8x8 masks the conversion searches and, at any finer resolution, the
// render-back used to score a converted image. Glyph classes form a ladder of steps; each step
// includes every step below it, so a terminal that draws one step draws all lower ones too:
//
//   half      the four half blocks
//   quadrant  quadrant blocks (2x2)
//   sextant   Symbols for Legacy Computing sextants (2x3)
//   wedge     smooth-mosaic diagonals and centre triangles (U+1FB3C..U+1FB6F)
//   octant    Unicode 16 octants (2x4) and the eighth blocks four octant patterns reuse
//
// Space and the full block are allowed at every step. Six octant patterns would reuse
// characters from U+1CEA0..U+1CEAB or U+1FBE6/7, which few terminals or fonts draw; they are
// left out, and the search covers those cells with other glyphs. U+1FB9A/B are left out of the
// wedges because Windows Terminal's built-in glyphs stop at U+1FB94.

export const STEPS = Object.freeze(["half", "quadrant", "sextant", "wedge", "octant"]);
export const GRID = 8; // sub-pixels per cell side in a mask

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// A 2-column grid layout with `rows` equal rows; bit = row * 2 + column.
function gridPolys(bits, rows) {
  const polys = [];
  for (let i = 0; i < rows * 2; i++) {
    if (!(bits & (1 << i))) continue;
    const r = Math.floor(i / 2), c = i % 2;
    polys.push(rect(c / 2, r / rows, (c + 1) / 2, (r + 1) / rows));
  }
  return polys;
}

const HALF = [[0x2580, 0b0011], [0x2584, 0b1100], [0x258c, 0b0101], [0x2590, 0b1010]];
const QUADRANT = [
  [0x2596, 0b0100], [0x2597, 0b1000], [0x2598, 0b0001], [0x2599, 0b1101], [0x259a, 0b1001],
  [0x259b, 0b0111], [0x259c, 0b1011], [0x259d, 0b0010], [0x259e, 0b0110], [0x259f, 0b1110],
];

// Sextant code points follow the 6-bit pattern, skipping the two patterns that are half blocks.
const sextantCodePoint = (bits) => 0x1fb00 + bits - 1 - (bits > 21 ? 1 : 0) - (bits > 42 ? 1 : 0);

// Octant patterns encoded by other characters. Those mapped to null are left out of the search.
const OCTANT_REUSED = new Map([
  [0x00, null], [0x01, null], [0x02, null], [0x03, 0x1fb82], [0x05, 0x2598], [0x0a, 0x259d],
  [0x0f, 0x2580], [0x14, null], [0x28, null], [0x3f, 0x1fb85], [0x40, null], [0x50, 0x2596],
  [0x55, 0x258c], [0x5a, 0x259e], [0x5f, 0x259b], [0x80, null], [0xa0, 0x2597], [0xa5, 0x259a],
  [0xaa, 0x2590], [0xaf, 0x259c], [0xc0, 0x2582], [0xf0, 0x2584], [0xf5, 0x2599], [0xfa, 0x259f],
  [0xfc, 0x2586], [0xff, 0x2588],
]);
// Patterns 0x00 and 0xff are space and the full block; null here means "no glyph of its own".
const OCTANT_EIGHTH_BLOCKS = [0x03, 0x3f, 0xc0, 0xfc];

const TRI = {
  upper: [[0, 0], [1, 0], [0.5, 0.5]], right: [[1, 0], [1, 1], [0.5, 0.5]],
  lower: [[0, 1], [1, 1], [0.5, 0.5]], left: [[0, 0], [0, 1], [0.5, 0.5]],
};
const T = 1 / 3, TT = 2 / 3;
// Smooth mosaics: each glyph fills the side of a line between cell points that holds its named
// corner. Vertices sit on x in {0, 1/2, 1} and y in {0, 1/3, 2/3, 1}.
const WEDGES = [
  [0x1fb3c, [[[0.5, 1], [0, 1], [0, TT]]]],
  [0x1fb3d, [[[1, 1], [0, 1], [0, TT]]]],
  [0x1fb3e, [[[0.5, 1], [0, 1], [0, T]]]],
  [0x1fb3f, [[[1, 1], [0, 1], [0, T]]]],
  [0x1fb40, [[[0, 0], [0.5, 1], [0, 1]]]],
  [0x1fb41, [[[0.5, 0], [1, 0], [1, 1], [0, 1], [0, T]]]],
  [0x1fb42, [[[1, 0], [1, 1], [0, 1], [0, T]]]],
  [0x1fb43, [[[0.5, 0], [1, 0], [1, 1], [0, 1], [0, TT]]]],
  [0x1fb44, [[[1, 0], [1, 1], [0, 1], [0, TT]]]],
  [0x1fb45, [[[0.5, 0], [1, 0], [1, 1], [0, 1]]]],
  [0x1fb46, [[[1, T], [1, 1], [0, 1], [0, TT]]]],
  [0x1fb47, [[[1, TT], [1, 1], [0.5, 1]]]],
  [0x1fb48, [[[1, TT], [1, 1], [0, 1]]]],
  [0x1fb49, [[[1, T], [1, 1], [0.5, 1]]]],
  [0x1fb4a, [[[1, T], [1, 1], [0, 1]]]],
  [0x1fb4b, [[[1, 0], [1, 1], [0.5, 1]]]],
  [0x1fb4c, [[[0, 0], [0.5, 0], [1, T], [1, 1], [0, 1]]]],
  [0x1fb4d, [[[0, 0], [1, T], [1, 1], [0, 1]]]],
  [0x1fb4e, [[[0, 0], [0.5, 0], [1, TT], [1, 1], [0, 1]]]],
  [0x1fb4f, [[[0, 0], [1, TT], [1, 1], [0, 1]]]],
  [0x1fb50, [[[0, 0], [0.5, 0], [1, 1], [0, 1]]]],
  [0x1fb51, [[[1, TT], [1, 1], [0, 1], [0, T]]]],
  [0x1fb52, [[[0, 0], [1, 0], [1, 1], [0.5, 1], [0, TT]]]],
  [0x1fb53, [[[0, 0], [1, 0], [1, 1], [0, TT]]]],
  [0x1fb54, [[[0, 0], [1, 0], [1, 1], [0.5, 1], [0, T]]]],
  [0x1fb55, [[[0, 0], [1, 0], [1, 1], [0, T]]]],
  [0x1fb56, [[[0, 0], [1, 0], [1, 1], [0.5, 1]]]],
  [0x1fb57, [[[0, 0], [0.5, 0], [0, T]]]],
  [0x1fb58, [[[0, 0], [1, 0], [0, T]]]],
  [0x1fb59, [[[0, 0], [0.5, 0], [0, TT]]]],
  [0x1fb5a, [[[0, 0], [1, 0], [0, TT]]]],
  [0x1fb5b, [[[0, 0], [0.5, 0], [0, 1]]]],
  [0x1fb5c, [[[0, 0], [1, 0], [1, T], [0, TT]]]],
  [0x1fb5d, [[[0, 0], [1, 0], [1, TT], [0.5, 1], [0, 1]]]],
  [0x1fb5e, [[[0, 0], [1, 0], [1, TT], [0, 1]]]],
  [0x1fb5f, [[[0, 0], [1, 0], [1, T], [0.5, 1], [0, 1]]]],
  [0x1fb60, [[[0, 0], [1, 0], [1, T], [0, 1]]]],
  [0x1fb61, [[[0, 0], [1, 0], [0.5, 1], [0, 1]]]],
  [0x1fb62, [[[0.5, 0], [1, 0], [1, T]]]],
  [0x1fb63, [[[0, 0], [1, 0], [1, T]]]],
  [0x1fb64, [[[0.5, 0], [1, 0], [1, TT]]]],
  [0x1fb65, [[[0, 0], [1, 0], [1, TT]]]],
  [0x1fb66, [[[0.5, 0], [1, 0], [1, 1]]]],
  [0x1fb67, [[[0, 0], [1, 0], [1, TT], [0, T]]]],
  [0x1fb68, [TRI.upper, TRI.right, TRI.lower]],
  [0x1fb69, [TRI.left, TRI.lower, TRI.right]],
  [0x1fb6a, [TRI.upper, TRI.left, TRI.lower]],
  [0x1fb6b, [TRI.left, TRI.upper, TRI.right]],
  [0x1fb6c, [TRI.left]],
  [0x1fb6d, [TRI.upper]],
  [0x1fb6e, [TRI.right]],
  [0x1fb6f, [TRI.lower]],
];

function insidePoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Whether a point of the unit cell (0..1 each way) lies inside the glyph's shape.
export function covers(glyph, x, y) {
  return glyph.polys.some((p) => insidePoly(p, x, y));
}

// The glyph's shape on an n x n grid of sub-pixels, sampled at sub-pixel centres: 1 = foreground.
export function rasterize(glyph, n) {
  const m = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) m[y * n + x] = covers(glyph, (x + 0.5) / n, (y + 0.5) / n) ? 1 : 0;
  }
  return m;
}

function make(cp, polys, step) {
  const glyph = { ch: String.fromCodePoint(cp), cp, polys, step };
  glyph.mask = rasterize(glyph, GRID);
  return Object.freeze(glyph);
}

const SPACE = make(0x20, [], "half");
const FULL = make(0x2588, [rect(0, 0, 1, 1)], "half");

function buildClasses() {
  const half = HALF.map(([cp, bits]) => make(cp, gridPolys(bits, 2), "half"));
  const quadrant = QUADRANT.map(([cp, bits]) => make(cp, gridPolys(bits, 2), "quadrant"));
  const sextant = [];
  for (let bits = 1; bits < 63; bits++) {
    if (bits === 21 || bits === 42) continue; // the left and right half blocks
    sextant.push(make(sextantCodePoint(bits), gridPolys(bits, 3), "sextant"));
  }
  const wedge = WEDGES.map(([cp, polys]) => make(cp, polys, "wedge"));
  const octant = [];
  let index = 0;
  for (let bits = 0; bits < 256; bits++) {
    if (OCTANT_REUSED.has(bits)) continue;
    octant.push(make(0x1cd00 + index++, gridPolys(bits, 4), "octant"));
  }
  for (const bits of OCTANT_EIGHTH_BLOCKS) octant.push(make(OCTANT_REUSED.get(bits), gridPolys(bits, 4), "octant"));
  return { half, quadrant, sextant, wedge, octant };
}

// The tables are built on first use, so a process that only reads cached faces never pays for them.
let _classes = null;
const classes = () => (_classes ||= Object.freeze(buildClasses()));

// Shapes of the octant patterns the search leaves out; chafa may still print them, and scoring its
// output needs their shape.
const LEFT_OUT_OCTANTS = [[0x01, 0x1cea8], [0x02, 0x1ceab], [0x40, 0x1cea3], [0x80, 0x1cea0], [0x14, 0x1fbe6], [0x28, 0x1fbe7]];

// Any glyph this table knows by its character, the left-out octant characters included; null for
// a character it does not know.
let _byChar = null;
export function glyphByChar(ch) {
  if (!_byChar) {
    const leftOut = LEFT_OUT_OCTANTS.map(([bits, cp]) => make(cp, gridPolys(bits, 4), "octant"));
    _byChar = new Map([SPACE, FULL, ...Object.values(classes()).flat(), ...leftOut].map((g) => [g.ch, g]));
  }
  return _byChar.get(ch) || null;
}

export const stepIndex = (step) => STEPS.indexOf(step);

// The glyphs a step adds over the one below it, in table order (for the test card).
export function classGlyphs(step) {
  if (!classes()[step]) throw new Error(`unknown glyph step: ${step}`);
  return classes()[step];
}

const maskKey = (m) => m.join("");

// Every glyph usable at `step`: space, the full block and all classes up to the step, each 8x8
// mask once (the first glyph in ladder order keeps it).
const _forStep = new Map();
export function glyphsFor(step) {
  if (_forStep.has(step)) return _forStep.get(step);
  const top = stepIndex(step);
  if (top < 0) throw new Error(`unknown glyph step: ${step}`);
  const byMask = new Map();
  for (const g of [SPACE, FULL, ...STEPS.slice(0, top + 1).flatMap((s) => classes()[s])]) {
    const k = maskKey(g.mask);
    if (!byMask.has(k)) byMask.set(k, g);
  }
  const list = Object.freeze([...byMask.values()]);
  _forStep.set(step, list);
  return list;
}

// The test card: for each step, a label and the glyphs it adds, drawn in one colour on another so
// a glyph the terminal or font cannot draw stands out as a box, a question mark or a gap. The
// steps a terminal draws correctly, read from the top, are the steps it can be given.
const CARD_FG = [255, 176, 0];
const CARD_BG = [24, 32, 72];
export function testCardLines({ perRow = 26 } = {}) {
  const paint = `\x1b[38;2;${CARD_FG.join(";")}m\x1b[48;2;${CARD_BG.join(";")}m`;
  const lines = [];
  STEPS.forEach((step, i) => {
    const glyphs = classes()[step];
    lines.push(`${i + 1}. ${step} (${glyphs.length} glyphs)`);
    for (let k = 0; k < glyphs.length; k += perRow) {
      const row = glyphs.slice(k, k + perRow).map((g) => g.ch).join(" ");
      lines.push(`   ${paint} ${row} \x1b[0m`);
    }
  });
  return lines;
}
