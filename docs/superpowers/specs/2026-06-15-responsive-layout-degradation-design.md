# Responsive layout degradation — design

**Date:** 2026-06-15
**Status:** Approved (design), pending implementation plan
**Topic:** Make the HUD shrink to fit the terminal, then drop to a smaller preset when it can't shrink any further.

## Problem

The status bar renders at a fixed width regardless of terminal size. Resizing the
terminal does nothing visible: the only responsive mechanism is the bar-cell loop
in `buildBar` (`render.js`), which contracts bars 14 → 4 cells. For the `full`
preset that loop is already pinned at the minimum (`cells = 4`) because the layout
width is dominated by text labels, not bars — so `full` is effectively a fixed
~162-column block that overflows any narrower terminal and just wraps.

Two missing capabilities:
1. **Text never shrinks.** Only bars contract; text metrics keep their full
   (icon + up-to-24-char) width, which dominates the layout.
2. **No layout fallback.** When even the minimum layout exceeds the terminal,
   nothing drops boxes or switches to a simpler preset.

The three shipped presets (`minimal` / `default` / `full`) are *style/content*
profiles chosen once via `DOOMBAR_PRESET` — they were never auto-switched by width.

## Goal

When the terminal narrows: first shrink metrics (bars **and** text together) and
the boxes with them; when the layout hits its minimum and still doesn't fit,
switch to the next smaller preset (`full → standard → minimal`). When the terminal
widens again, recover up to the user's chosen preset. All stateless — every refresh
re-reads `COLUMNS` and recomputes from scratch.

## Width signal (context)

Claude Code sets the `COLUMNS` environment variable to the current terminal width
before running a `statusLine` command (v2.1.153+). The statusline JSON on stdin
does **not** carry terminal width. Terminal resize does not itself re-trigger the
command, but this project already runs with `refreshInterval: 1`, so `COLUMNS` is
re-read about once per second. `statusline.js` already reads
`process.env.COLUMNS || "100"` — that stays the width source.

## Decisions (locked)

- **Ceiling + bidirectional, stateless.** The preset in `DOOMBAR_PRESET` is the
  upper bound. Narrowing degrades downward; widening recovers up to the ceiling.
  No persisted state — each render re-evaluates from `COLUMNS`.
- **Fallback chain declared per-preset.** Each preset's `[bar]` carries an optional
  `fallback = "<name>"`. Decision lives in data, so custom presets degrade too.
- **Scaling approach A — single lockstep scale.** One scale drives bars (14 → 4
  cells) and text cap (24 → 10 columns) together. Pick the largest scale that fits;
  if even the minimum doesn't fit, fall back to a smaller preset.
- **Text floor = icon + 10 columns.** Bars keep their existing 14 → 4 range.
- **Hard rename `default.toml → standard.toml`, no back-compat alias.** Pre-1.0
  package; a stale `"default"` in a config is the user's to fix.

## Architecture

Responsibilities split along the IO boundary:

- **`render.js`** stays pure (no filesystem). It gains `planLayout(cfg, target)`
  and threads a `textCap` through width measurement and rendering.
- **`statusline.js`** owns preset resolution (it already does file IO): it follows
  the `fallback` chain and picks which preset to hand to `buildBar`.

### Component 1 — `planLayout(cfg, target)` (render.js, pure)

Replaces the inline `cells` loop at `render.js:329`.

Returns `{ cells, textCap, width, fits }`:

- Iterate `cells` from 14 down to 4. For each, derive the coupled text cap:
  `textCap = round(10 + (cells - 4) / (14 - 4) * (24 - 10))`
  (cells 14 → cap 24; cells 4 → cap 10; monotonic in between).
- Compute `balancedWidth(cfg, cells, textCap)` (existing `balancedWidth`/`boxWidth`
  extended to take `textCap`).
- Return the **largest** step whose `width ≤ target`, with `fits = true`.
- If no step fits (even cells 4 / cap 10), return that minimum step with
  `fits = false` and its width.

`buildBar(cfg, target, spriteFor, tick)` calls `planLayout` to obtain
`cells` + `textCap`, then renders as today using those two values.

### Component 2 — metric width with `textCap` (render.js, pure)

`metricFixedWidth(entry, textCap)` gains the cap parameter; `boxWidth` passes it
through:

- **bar / ammo:** `icon + cells + suffix` — unchanged, driven by `cells`.
- **text / number:** `icon + min(vlen(value), textCap)` — **only when the value is
  marquee-safe** (contains no ANSI/OSC escape, tested by `!/\x1b/.test(value)`).
- **scroll / list:** item label/text capped at `textCap` (plus mark/icon), same
  marquee-safe rule.
- **marquee-unsafe values** (coloured text or hyperlinks: `loc.cwd`, `git.branch`,
  `pr.state`, `git.work`, `loc.churn`): **hard floor = full display width**, never
  capped. These boxes shrink less and are left intact at render time (slicing an
  escape sequence by column would corrupt it).

Rendering needs no new per-site logic: marquee budgets already derive from the box
width `w`, and `w` now reflects `textCap`, so marquee triggers automatically on a
narrow layout. Only `textCap` has to be threaded into `metricFixedWidth` / `boxWidth`
and into the budgets passed to `marquee`.

### Component 3 — preset resolution (statusline.js, IO)

- Load the chosen preset from `DOOMBAR_PRESET`.
- Build the chain by following `[bar].fallback`: a name resolves to
  `<dir of chosen preset>/<name>.toml`. Guard against cycles (a `seen` set) and a
  missing/unreadable fallback file (the chain simply ends there).
- **Selection:** walk the chain from the chosen preset (the ceiling) downward; pick
  the first preset with `planLayout(cfg, COLUMNS).fits === true`. If none fit, use
  the last (smallest) preset in the chain.
- Hand the selected preset's parsed config to `buildBar`.

Because selection reads `COLUMNS` fresh each refresh, widening the window re-selects
a larger preset up to the ceiling — bidirectional with no stored state.

To keep selection testable without the filesystem, factor it as a pure helper that
takes a `loadByName(name) -> cfg | null` loader; `statusline.js` injects an
fs-backed loader, tests inject a map.

### Preset files

- Rename `presets/default.toml` → `presets/standard.toml`.
- `full.toml` `[bar]`: add `fallback = "standard"`.
- `standard.toml` `[bar]`: add `fallback = "minimal"`.
- `minimal.toml`: no `fallback` (chain terminus).
- The marquee `max_width = 22` caps on `full`'s AGENTS/TASKS boxes stay.

### `render.js` preview CLI

`main()` renders the single preset it is given (degradation within that preset via
`planLayout`). Preset switching is a statusline concern and is not exercised by the
preview CLI. The optional `tick` argv for marquee previews stays.

## Edge cases

- **No `COLUMNS`** (older Claude Code): falls back to `"100"` as today; degradation
  still works against that fixed width.
- **`minimal` chosen as ceiling:** chain has one entry; nothing to degrade to —
  renders `minimal` at whatever scale fits (possibly overflowing if the terminal is
  absurdly narrow, which is acceptable).
- **All-link box narrower than its hard floor:** the box keeps its hard-floor width;
  the layout may exceed `COLUMNS` at the minimum step, which triggers fallback —
  correct behaviour.
- **Custom preset without `fallback`:** behaves like `minimal` (terminus); it
  shrinks but never switches.

## Testing

Plain `.test.mjs` files in the existing no-framework style.

- **`planLayout` (new `test/layout.test.mjs`):**
  - wide target → `cells=14, textCap=24, fits=true`
  - mid target → an intermediate `cells`/`textCap`, `fits=true`
  - sub-minimum target → `cells=4, textCap=10, fits=false`
  - monotonicity: width does not increase as target decreases; `textCap` tracks
    `cells` per the formula.
- **Preset selection (pure helper, injected loader — no FS):**
  - chain `full → standard → minimal` with a given `COLUMNS` selects the expected
    preset; wide → ceiling, narrow → `minimal`, sub-minimal → `minimal` (last).
  - statelessness: same inputs with different `COLUMNS` yield different presets.
  - cycle guard and missing-fallback terminus.
- **Marquee-safety across scale (extend `render-scroll.test.mjs`):**
  - equal-row-width invariant holds at every scale step;
  - plain text marquees at a narrow `textCap`; a value containing `\x1b` (a
    hyperlink) is not sliced and does not break (no orphaned escape; box holds its
    hard floor).
- **Rename:** `standard.toml` loads; `full.fallback` resolves to `standard`,
  `standard.fallback` to `minimal`.

## Out of scope

- Per-box greedy packing (approach C) and two-phase bars-then-text (approach B).
- Dropping individual boxes within a preset by priority (the fallback unit is the
  whole preset).
- A back-compat alias for the old `default` preset name.
- Changing how box `min_width` / `max_width` clamps work (they still apply on top
  of the scaled widths).
