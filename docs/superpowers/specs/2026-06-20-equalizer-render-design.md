# Equalizer render type — design

**Date:** 2026-06-20
**Status:** Approved (design), pending implementation plan

## Summary

Add a new generic `equalizer` render type: a single-row VU-meter that draws a
series of side-by-side vertical block columns, one per channel, with
**per-column threshold colouring**. Its first consumer is `sys.cores`
(per-core CPU utilisation), but the renderer takes any array of `0..1` values.

## Motivation

The status bar already maps metrics to visuals generically (`bar`, `ammo`,
`spark`, `number`, `text`, `list`, `scroll`). The `spark` type already draws an
array of values as side-by-side block characters in one row — that is variant
"A" (one metric over time), used by `act.geiger`.

The equalizer is variant "B": **N related metrics shown at once**, each column a
different channel, height = its current value. Data shape is identical to
`spark` (array of `0..1`); the only behavioural difference that justifies a new
render type is **per-column colouring by threshold**, so the colour tells you
which channel is in the red.

## Components

### 1. Renderer — `rEqualizer(values, cells, boxRgb)` (src/render.js)

- Input: array of `0..1` values; `cells` = columns available in the box.
- Output: one row of block characters `▁▂▃▄▅▆▇█` (8 height levels), one char per
  channel, matching the existing `spark` "block" height mapping (reuse the
  shared height helper so heights never drift by one — see `ansi.js:13`).
- **Per-column colouring:** each column gets its colour from the existing
  `threshold(pct)` logic applied to that column's own value (green → yellow →
  red). This is the one thing `rSpark` does not do (`rSpark` colours the whole
  run with a single `boxRgb`).

### 2. Overflow — densify by averaging

When `channels > cells`:

- `bucket = ceil(N / cells)`, each rendered column = the **average** of the
  values in its bucket.
- For 8–16 channels in a normal-width box this is the average of pairs (the
  user's "average of two"); it only densifies further on a narrow terminal,
  and never overflows the box.

### 3. Data source — `sys.cores` (src/statusline.js)

The delta + state-cache mechanism **already exists**: `cpuPercent()`
(statusline.js:242) sums all cores into one `total`/`idle`, persists a snapshot
to `mugshot_cpu.json`, and computes the delta against the previous snapshot.

`sys.cores` extends this: keep **per-core** `total`/`idle` in the cache instead
of (or alongside) the aggregate, and return an array — one
`1 - idleDelta/totalDelta` per core — instead of averaging them.

- **Cold start:** identical to today's `sys.cpu` — first refresh has no prior
  snapshot, so the value is `null` and the metric simply does not render. No
  special-casing needed.
- The existing aggregate `sys.cpu` keeps working unchanged.

### 4. Configuration (preset TOML)

```toml
{ id = "sys.cores", render = "equalizer", icon = "🔥", color = "threshold" }
```

The renderer is generic; `sys.cores` is just the first array we feed it. Not
added to any shipped preset by default unless decided during planning.

## Integration sites (a new render type touches all of these)

1. **Dispatch** — `renderValue`, src/render.js ~200 (next to
   `if (render === "spark")`): `if (render === "equalizer") return label + rEqualizer(...)`.
2. **`barMeta`** — src/render.js:215: return `[lw, 0, "equalizer"]` (like spark —
   no suffix width).
3. **`metricFixedWidth`** — src/render.js:255: spark uses `floor((len+1)/2)`
   (octant packs 2 samples per char). Equalizer is **1 channel per char**, so
   fixed width = `lw + min(values.length, cells-cap)`. Resolve the exact cap
   interaction during planning.
4. **ANSI width:** per-column colouring emits N SGR segments in one metric
   string. `vlen()`/`capLen` are already ANSI-aware (spark relies on this) and
   the equalizer is fixed-width (no marquee), so this is reuse, not new work —
   but a test must confirm `vlen()` of a multi-segment coloured row equals the
   channel count.

## Testing

New unit tests (same style as `preset-bands` / render-scroll tests):

- `rEqualizer`: column count, height mapping (incl. the `.5` boundary that
  `ansi.js:13` warns about), per-column threshold colours, densify-by-average on
  overflow.
- `vlen()` of a multi-segment coloured equalizer row == channel count.
- `sys.cores` returns an array of the right length (one per core) and `null` on
  cold start.

## Non-goals (YAGNI)

- Column gaps / channel grouping.
- Scroll/marquee for overflow (we densify instead).
- Configurable per-channel labels.
