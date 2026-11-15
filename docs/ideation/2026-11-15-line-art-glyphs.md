---
date: 2026-11-15
topic: line-art glyphs in the renderer
status: investigated, not planned
backlog: D-17
---

# Line-art glyphs in the renderer: feasibility and scope

The owner asked (2026-11-15) to take every suitable glyph from
[Wikipedia: Box-drawing characters](https://en.wikipedia.org/wiki/Box-drawing_characters) into the
renderer. This refines D-17 (2026-11-13). This document records whether it is possible and what it
touches. Nothing is implemented yet.

**Short answer: possible.** The work has three separate uses and one new capability axis. Most of
it is new code in `kit/`. The mugshot conversion changes only if measurement shows a gain.

## 1. What the page offers

| Set | Range | Line glyphs | Support (per the page) |
|---|---|---|---|
| Box Drawing | U+2500–257F, 128 chars | all of them: light, heavy and double lines; corners, tees and crosses in every weight mix; 2-, 3- and 4-dash lines; rounded arcs `╭╮╯╰`; diagonals `╱╲╳`; half-line stubs `╴╵╶╷╸╹╺╻` and light/heavy stubs `╼╽╾╿` | many fonts cover only the WGL4 / CP437 subset (light, double and light/double mixes) |
| Block Elements | U+2580–259F, 32 chars | lines only `▔` (upper one-eighth) and `▕` (right one-eighth); the rest are fills, already used by the raster | universal |
| Symbols for Legacy Computing | U+1FB00–1FBFF | one-eighth lines at each position, corner one-eighth combinations, and light diagonal box segments (half-cell diagonals between edge midpoints); exact code points to be taken from the Unicode chart U1FB00.pdf when planning | "few fonts"; terminals with built-in drawing (Windows Terminal, kitty, Ghostty, VTE) draw parts of it |
| Legacy Computing Supplement | U+1CC00–1CEBF (Unicode 16) | further box-drawing pieces next to the octants; code points from U1CC00.pdf | very few fonts or terminals |
| Platform sets on the page | CP437, HP Roman-8, DEC Special Graphics, BBC Micro, Amstrad CPC, MSX, TRS-80, PETSCII, Teletext | no glyphs of their own: their line glyphs map onto the Box Drawing block | historical reference only |

The page also says box drawing works well only with monospaced fonts, and that without font support
the glyphs show as boxes or question marks.

The fetch read the page's charts word for word only up to the TRS-80 table. The Legacy Computing
charts on the page have no labels for the kind of line. Planning has to take the code points from the
Unicode PDFs.

## 2. What the code does today

- **The image raster** (`src/kit/raster/glyphs.js`, `glyph-render.js`) knows only filled shapes. They
  form a ladder of steps (`half` → `quadrant` → `sextant` → `wedge` → `octant`), each glyph a
  polygon set rasterised to an 8×8 mask. A cell is matched by Hamming distance to a two-colour split,
  then scored by colour error. No line glyph is a candidate.
- **The glyph level** (`glyph-level.js`) picks one step from the terminal's identity
  (`GAMEBAR_GLYPHS`, `TMUX`, `TERM_PROGRAM`, `TERM`, `VTE_VERSION`, `WT_SESSION`). The client and the
  daemon forward these variables per session (`gamebar-client.sh`, `daemon.js`).
- **Chrome already uses box drawing, hard-coded and unchecked:**
  - the DOOM boxes layout draws `│` separators (`src/games/doom/layout.js`);
  - the Minecraft hotbar draws heavy lines `┏ ━ ┳ ┓ ┃ ┗ ┻ ┛` (`src/games/minecraft/layout.js`).

  No glyph level applies to them.
- **The test card** (`claude-game-bar test-card`, `bin/cli.js` and `testCardLines` in `glyphs.js`)
  shows each step's glyphs, the mugshot drawn at each step, and the step this terminal gets.
- **The face cache** (`src/games/doom/face.js`) is keyed by the package version and the converter
  sources, so a changed glyph table never reads old faces.

## 3. Three uses, each its own piece of work

### A. Lines for chrome: frames, dividers, minimap edges (the main use)

- **What:** a line-drawing primitive in `kit/`, e.g. `kit/lines.js`. A layout draws segments into a
  cell grid. Each cell keeps a weight per direction (up, right, down, left: none, light, heavy or
  double) and a style (square or rounded, solid or dashed). A lookup table resolves the cell to its
  glyph. The U+2500 block is exactly that table, so junctions and crossings come out right on their
  own. This is the "lookup table for map and chrome" resolver of D-12.
- **Fallback when a weight or style is missing:**
  - heavy, then light;
  - double, then light;
  - rounded, then square;
  - dashed, then solid;
  - then ASCII `-|+`, as the page describes for DEC terminals.
- **Users:**
  - the WC3 console and minimap (D-5, D-6, G-8);
  - the shared HUD kit (G-4);
  - the DOOM boxes and Minecraft hotbar, which would draw through the primitive instead of
    hard-coded characters and so gain the fallback.

### B. Lines in the image raster (the mugshot and future portraits)

- **What:** add line glyphs as candidates in the mask search, with polygons for strokes, arcs as
  polylines, and diagonals.
- **Not sure to help.** Line glyphs win only on cells with one-pixel features, such as outlines or
  brows. The pixel-art faces may look noisier, as the shortlist note in `glyph-render.js` already
  warns. D-4 set the bar: the OKLab render-back score in `scripts/compare-faces.mjs` plus the owner's
  side-by-side verdict.
- **The 8×8 mask is too coarse for the stroke geometry:**
  - a light stroke is about 1/8 of the cell width but only about 1/16 of its height, because cells
    are about twice as tall as wide;
  - a centred one-sub-pixel line falls between sub-pixel centres on an even grid.

  Options:
  - a finer grid, e.g. 16×16, which costs about 4× per cell. That matters for the one-shot path
    (about 63 ms today on ubuntu-latest); the daemon caches its faces.
  - Or treat strokes as two sub-pixels wide and accept the error.
- **Stroke weight depends on the terminal.** Terminals that draw box glyphs themselves use their own
  stroke weight; others take it from the font. The render-back score has to model that or accept it
  as noise.
- **Opt-in until measured:** a face preset names lines in its `glyphs` setting. If the default
  conversion changes, the face snapshots and the golden renders change too, and the owner approves
  them, as in D-4.

### C. Thin meters and rails

- **What:** the one-eighth lines (`▔ ▕` and the U+1FB70 range) can draw thin rails and ticks for
  bars.
- **Related:** S-5, where the fine bars use octants whatever the terminal. Both want the same
  per-terminal check.

## 4. A new capability axis: which lines a terminal draws

The fill ladder does not nest with lines. A font-only terminal such as the Windows console host
draws the CP437 lines but no sextants. The Minecraft hotbar's heavy lines already assume more than
CP437. Lines therefore need a level of their own, next to the glyph step:

| Line level | Glyphs |
|---|---|
| `ascii` | `- \| +` |
| `cp437` | light, double and light/double mixes (WGL4) |
| `box` | the whole U+2500–257F block: heavy, dashed, arcs, diagonals, stubs |
| `legacy` | `box` plus the U+1FB00 lines: one-eighth lines, diagonal segments |
| `supplement` | `legacy` plus the U+1CC00 lines |

- **Picked like the glyph step,** from the terminal's identity, with an override such as
  `GAMEBAR_LINES`. Terminals with built-in box drawing get `box` or more. Unknown terminals get
  `cp437`.
- **A new variable is plumbing work:**
  - forward it per session in `gamebar-client.sh` and `daemon.js` (`FORWARDED_ENV`);
  - document it with its `DOOMBAR_` fallback rule, through `env.js`, like every setting.
- **Ambiguous width:** box-drawing characters have East Asian Width "Ambiguous". Under a CJK locale
  some terminals draw them two cells wide, which would break layouts. The test card should show it.

## 5. What it touches

| Area | Files | Change |
|---|---|---|
| Glyph tables | `src/kit/raster/glyphs.js` | line glyph classes (polygons for strokes, arcs, diagonals); line-level tables |
| Raster | `src/kit/raster/glyph-render.js` | (B only) candidates, maybe a finer grid |
| Levels | `src/kit/raster/glyph-level.js` | line level per terminal, `GAMEBAR_LINES` override |
| New primitive | `src/kit/lines.js` (new) | direction-weight canvas, glyph resolver, fallback chain |
| Layouts | `src/games/doom/layout.js`, `src/games/minecraft/layout.js` | (optional) draw through the primitive |
| Test card | `bin/cli.js` (`test-card`), `testCardLines` | a section per line level with every glyph; a joined sample (box with tees, crosses, arcs, dashes) to check that strokes meet and each glyph is one cell wide; a ruler for the ambiguous-width case; with B, the mugshot with and without lines side by side; the "this terminal gets" summary names the line level too |
| Env forwarding | `src/gamebar-client.sh`, `src/daemon.js`, `src/platform/env.js` | the new variable, both spellings |
| Measurement | `scripts/compare-faces.mjs` | (B) score faces with line glyphs |
| Face cache | `src/games/doom/face.js` | none; it rekeys itself on converter changes |
| Tests | `test/kit/…`, `test/install/test-card.test.mjs`, `test/games/…` | resolver table (every direction/weight combination maps to the right code point), fallback chain, level choice per terminal, test-card output; snapshots unchanged unless the owner approves a visual change |
| Docs | README (glyphs and test card), CHANGELOG, CONTRIBUTING (how a game draws frames) | |

## 6. Open questions for the owner

1. **Order of A, B and C.** The recommendation is A first, since it unblocks WC3 and has no quality
   risk. Then C. B stays an experiment behind a measurement.
2. **Lines in the mugshot at all,** and if so whether a finer grid and its one-shot cost are worth it.
3. **"Every suitable glyph":** the Supplement (U+1CC00) is drawn by almost nothing today. Keep it
   behind the top line level, or leave it out until terminals catch up?
4. **The existing hotbar and DOOM separators:** move them onto the primitive, which brings the
   fallback and may change bytes, or leave them as they are?
