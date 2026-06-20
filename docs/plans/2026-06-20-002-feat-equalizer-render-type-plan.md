---
title: "feat: Add equalizer render type"
type: feat
status: active
date: 2026-06-20
origin: docs/superpowers/specs/2026-06-20-equalizer-render-design.md
depth: lightweight
---

# feat: Add equalizer render type

## Summary

Add a generic `equalizer` render type to the status bar: a single-row VU-meter of
side-by-side vertical block columns (one per channel) with **per-column threshold
colouring**. Its first consumer is a new `sys.cores` metric (per-core CPU
utilisation). The renderer is generic over any array of `0..1` values; `sys.cores`
is just the first array fed to it.

## Problem Frame

The bar maps metrics to visuals generically. `spark` already draws an array as
side-by-side block columns, but colours the whole run one colour and means "one
metric over time" (the geiger). There is no visual for "N related channels at
once, each coloured by its own value" — which is what a CPU-core meter needs. The
gap is per-column colouring, not the column drawing itself.

See `origin` for the full design rationale.

---

## Key Technical Decisions

- **New render type, not a spark flag.** The only behavioural difference from
  `spark` is per-column threshold colouring, but it changes both the colour model
  and the width math (1 char/channel vs spark's octant 2-samples/char). A distinct
  type keeps each renderer simple. (see origin)
- **Reuse the shared height helper.** Column heights use the same `0..1` → block
  glyph mapping as `rSpark` (the `h()` helper in `src/render.js`), so heights never
  drift at the `.5` boundary that `src/ansi.js:13` warns about.
- **Reuse `threshold()` for per-column colour.** Each column's colour comes from
  the existing `threshold(pct)` applied to that column's own value — no new colour
  logic.
- **Densify by averaging on overflow.** When channels > available columns,
  `bucket = ceil(N / cols)`, each column = average of its bucket. For 8–16 channels
  in a normal box this is the user-requested "average of two".
- **Extend `cpuPercent()`, don't duplicate it.** The delta+state-cache mechanism
  (`mugshot_cpu.json`) already exists; `sys.cores` keeps per-core totals/idle in the
  same cache and returns an array instead of an aggregate. Cold start returns `null`
  exactly like today's `sys.cpu`.
- **Expose `sys.cores` in the `full` preset's SYS box** so the feature is reachable
  out of the box. (U3 — flag at review if undesired.)

---

## Implementation Units

### U1. `rEqualizer` renderer and integration sites

**Goal:** Draw an array of `0..1` values as a one-row, per-column-coloured block meter, wired into all sites a render type touches.

**Requirements:** Renderer + per-column colouring + overflow densify (origin §1, §2).

**Dependencies:** none.

**Files:**
- `src/render.js` — add `rEqualizer(values, cells, boxRgb)`; dispatch in `renderValue` (~line 200, beside `if (render === "spark")`); `barMeta` (~215) returns `[lw, 0, "equalizer"]`; `metricFixedWidth` (~255) returns `lw + min(values.length, cells-cap)` for `equalizer`.
- `test/render-equalizer.test.mjs` — new test (mirror `test/preset-bands.test.mjs` style: plain Node script, `ok()` assertions, `process.exit`).

**Approach:**
- Input array of `0..1`; output one row of `▁▂▃▄▅▆▇█`, one glyph per channel, using the same height helper as `rSpark`.
- Per column, wrap the glyph in the SGR colour from `threshold(value*100)`.
- Overflow: when `values.length > cells`, bucket by `ceil(N/cells)` and average each bucket before mapping to glyphs.
- Fixed-width (no marquee), so the multi-segment coloured string is fine for box-width math as long as `vlen()` counts visible width correctly.

**Patterns to follow:** `rSpark` (height mapping, single-row block output), `rBar` (how `threshold()` colour is applied and wrapped in SGR), `barMeta`/`metricFixedWidth` spark branches.

**Test scenarios:**
- Happy path: `[0, .5, 1]` → 3 glyphs, heights low/mid/full (assert exact glyphs via the height helper's mapping).
- Per-column colour: an array mixing sub-threshold and over-threshold values yields different SGR codes per column; the high column carries the "red" code, the low one the "green" code.
- Boundary: a `.5` value maps to the same glyph as `rSpark` for the same input (guards the `ansi.js:13` drift).
- Overflow densify: 16 values into 8 cells → 8 glyphs, each the average of its pair; 17 values into 8 cells → still ≤8 glyphs (bucket `ceil(17/8)=3`), no overflow past `cells`.
- Empty array → empty string (no crash).
- `vlen()` of a rendered multi-column coloured row == channel count (visible width ignores SGR).

**Verification:** New test passes; existing render/layout tests still pass (no regression in spark or bar width math).

### U2. `sys.cores` data source

**Goal:** Produce a per-core CPU utilisation array from the existing CPU delta cache.

**Requirements:** Data source + cold-start behaviour (origin §3).

**Dependencies:** none (independent of U1; U1 is the consumer but they don't share code).

**Files:**
- `src/statusline.js` — extend `cpuPercent()` / `sysValues()` so per-core `total`/`idle` are kept in `mugshot_cpu.json` and a `sys.cores` array (`1 - idleDelta/totalDelta` per core) is emitted; preserve the existing aggregate `sys.cpu`.
- `test/statusline-cores.test.mjs` — new test (mirror existing `statusline-*.test.mjs` style).

**Approach:**
- On each refresh, snapshot per-core `{total, idle}` to the cache alongside (or replacing) the aggregate.
- Compute per-core deltas vs the previous snapshot; value = `max(0, min(1, 1 - di/dt))` when `dt > 0`.
- Cold start (`!prev`) → return `null` / omit `sys.cores`, identical to `sys.cpu` today, so the metric simply doesn't render on the first refresh.

**Patterns to follow:** `cpuPercent()` and `ramPercent()` in `src/statusline.js` (cache read/write, `pyround`, null-on-cold-start).

**Test scenarios:**
- Two synthetic snapshots (prev + current) with known per-core idle/total deltas → `sys.cores` array of the right length with expected `0..1` values.
- Cold start (no prior cache) → `sys.cores` absent / `null`; no throw.
- Aggregate `sys.cpu` still produced and unchanged by the per-core addition.
- A core with zero `dt` between snapshots is handled (no NaN/Infinity; falls back consistently with the aggregate's `dt > 0` guard).

**Verification:** New test passes; existing `statusline-*.test.mjs` tests still pass.

### U3. Wire `sys.cores` into the `full` preset

**Goal:** Make the equalizer reachable in a shipped preset.

**Requirements:** Configuration (origin §4).

**Dependencies:** U1, U2.

**Files:**
- `presets/full.toml` — add `{ id = "sys.cores", render = "equalizer", icon = "🔥", color = "threshold" }` to the SYS box.

**Approach:** Add one metric line to the existing SYS box. No new box.

**Patterns to follow:** existing SYS box entries in `presets/full.toml`.

**Test scenarios:** `Test expectation: none — config-only change.` Covered transitively by U1/U2 tests and the existing layout/preset-bands suite.

**Verification:** Full preset renders the SYS box with a coloured equalizer when `sys.cores` is present; `npm test` green.

---

## Risks & Dependencies

- **Preset width regression (low).** Adding `sys.cores` to the SYS box widens it,
  which feeds `planLayout` width math and could shift preset fallback bands.
  `test/preset-bands.test.mjs` and `test/layout.test.mjs` guard this — run them after
  U3 and adjust the preset only if a band is skipped. If width proves sensitive,
  fall back to not shipping it in `full` (U3 is the only reversible unit).
- **Multi-segment ANSI width.** Per-column colouring emits N SGR runs in one string;
  if `vlen()` miscounts, box width is wrong. U1's `vlen` test pins this.

## Verification (whole feature)

- `npm test` green (new `render-equalizer` and `statusline-cores` tests + no
  regressions in render, layout, preset-bands, statusline suites).
- Manual: a preset carrying `sys.cores` shows a one-row, per-column-coloured meter
  in the SYS box on a machine with multiple cores.
