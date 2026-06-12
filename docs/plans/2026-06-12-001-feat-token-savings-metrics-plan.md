---
title: "feat: Token-savings metrics in the HUD"
type: feat
status: completed
date: 2026-06-12
origin: docs/brainstorms/2026-06-12-token-savings-metrics-requirements.md
---

# feat: Token-savings metrics in the HUD

## Summary

Add a native value-source to `src/statusline.js` that defensively reads token-savings
numbers two tools already persist to disk — lean-ctx (`~/.lean-ctx/mcp-live.json`) and
LLMLingua (`~/.llmlingua-stats.json`) — and renders them as two per-tool rows
(🪶 lean-ctx, 📜 llmlingua) in a new `SAVE` box. Session-scoped, read-only, no plugin
patching. Rows degrade to absent (never crash, never `0`) when a tool is missing.

---

## Problem Frame

The HUD maps session metrics to DOOM elements but shows nothing about the savings the
user's context-optimization tools produce. The two tools that matter already write
savings to plain JSON on disk, so no injection into plugin code is needed — the HUD
reads the files the same defensive way it already reads the hook state file and advisor
transcript (`readState`, `advisorInfo`). "Surviving plugin updates" reduces to tolerating
schema/path drift in those files: a renamed key or moved file must make the row vanish,
not break the HUD (it is the developer's live, self-installed statusbar).

---

## Requirements

Traceability: R-IDs below map to the origin requirements doc (see `origin`).

### Data and reading

- R1. Savings are session-scoped — read the live-session number, not lifetime
  (origin R1).
- R2. Per-tool rows, no aggregation — lean-ctx and LLMLingua are distinct rows
  (origin R2).
- R3. Defensive reads are a hard requirement — missing file, missing key, or malformed
  JSON degrades to "metric absent" and never throws (origin R3).
- R4. Hide when zero/absent by **omitting the value key entirely** — never emit `0` or
  `""`; a zeroed key would render a misleading `🪶 0` row (origin R4).
- R5. No binary spawn — read the small JSON files only; never call `lean-ctx gain --json`
  (origin R5).
- R6. Tolerate both LLMLingua schemas — prefer nested `session.tokens_saved` (smart-read);
  when only the flat lifetime shape (`llmlingua_logged.py`) is present, treat as absent
  for the session view (origin R6).
- R7. Sources are a small in-code list (`{key, path, extract}`) so adding a source later
  is one entry — not a pluggable adapter framework (origin R7).
- R8. Neither tool installed is the common case (npm audience) and must be invisible:
  no keys emitted → `available()` drops the rows → the `SAVE` box collapses entirely
  (origin R8).

### Presentation

- R9. The icon is the label (no text), matching every existing metric in `presets/*.toml`.
- R10. Both icons measure `vlen = 2` and render as 2 terminal columns so the two rows
  align by construction — 🪶 (U+1FAB6), 📜 (U+1F4DC). Any future savings icon must be a
  width-2 emoji-presentation code point in `0x1F300–0x1FAFF`, or `vlen()` must first be
  taught VS16/per-code-point width.

---

## Key Technical Decisions

- **Export the value-source and make the two paths env-overridable.** Add
  `statsValues()` as an exported sibling of `activityValues`, and resolve each file via an
  env-first helper (`process.env.DOOMBAR_LEANCTX || <homedir default>`), mirroring
  `statePath()`/`MUGSHOT_STATE` (`src/statusline.js:188`). Rationale: lets the tests
  exercise every defensive branch by pointing at temp fixtures via direct import, with no
  subprocess — the lightest path given the repo's plain-script test harness.
- **One defensive reader per file, modeled on `readState`.** Single `try/catch` around
  `readFileSync` + `JSON.parse` returning `{}` on any failure (`src/statusline.js:194`).
  Covers ENOENT and malformed JSON in one shape; satisfies R3.
- **Omit-on-absent/zero, not zeroed keys.** `statsValues()` assigns `v["save.leanctx"]`
  only when a positive `tokens_saved` was extracted; otherwise the key is never set.
  Relies on `render.js` `available()` (`entry.id in VALUES`) to drop the row (R4/R8).
- **Number formatting via a new module-private `k()` helper.** No shared formatter
  exists; the abbreviation precedent is `model.window` (`src/statusline.js:135`, uppercase
  `K`/`M`, `Math.floor`). Use lowercase `k`/`M` here to match the brainstorm preview the
  user approved (`8.3k`); this is the one intentional divergence from `model.window`. Place
  `k()` near `clip()` (`src/statusline.js:46`).
- **Value is a preformatted composite string rendered as `text`.** `statsValues()` emits
  e.g. `v["save.leanctx"] = "8.3k 63%"` (saved + secondary figure); the preset supplies the
  icon and uses `render = "text"` with default color — no threshold coloring (the figure is
  not a single percentage).
- **`SAVE` box placement.** New box titled `SAVE`. In `presets/default.toml`, insert it
  immediately after `USAGE` (order becomes `USAGE → SAVE → mugshot → GIT`); note
  `default.toml` has no `PROJECT` box, so "between USAGE and PROJECT" resolves to "right
  after USAGE". In `presets/full.toml`, insert literally between `USAGE` and `PROJECT`.

---

## Implementation Units

### U1. Savings value-source in `src/statusline.js`

- **Goal:** Read both stats files defensively and emit `save.leanctx` / `save.lingua`
  value keys, omitting each when absent or zero.
- **Requirements:** R1, R2, R3, R4, R5, R6, R7.
- **Dependencies:** none.
- **Files:** `src/statusline.js`; test `test/statusline-savings.test.mjs` (U3).
- **Approach:**
  - Add env-first path helpers: `leanCtxPath()` → `process.env.DOOMBAR_LEANCTX ||
    path.join(os.homedir(), ".lean-ctx", "mcp-live.json")`; `llmlinguaPath()` →
    `process.env.DOOMBAR_LLMLINGUA || path.join(os.homedir(), ".llmlingua-stats.json")`.
    (`os` is already imported; `os.homedir()` is new to this file.)
  - Add `k(n)` formatter near `clip()`: `>= 1e6 → "<x.x>M"`, `>= 1e3 → "<x.x>k"`, else the
    integer. Lowercase, one decimal for abbreviated values.
  - A small source list drives extraction (R7): one entry per tool with `{key, path,
    extract}`. `extract` returns `{saved, pct}` or null.
    - lean-ctx: `saved = tokens_saved`, `pct = compression_rate` (a 0–100 percentage —
      verified against historical lean-ctx data, e.g. 8263/13163 ≈ 63%; render directly
      with `%`).
    - LLMLingua: prefer `session.tokens_saved` with its session figure; if only the flat
      lifetime shape is present, return null (absent for session view, R6). Secondary
      figure: `last_saved_pct` when present, else derive from `last_ratio`, else omit the
      percent — keep the row shape `"<saved> <pct>%"` when a percent exists, `"<saved>"`
      otherwise.
  - `statsValues()` iterates the list, reads+parses each path in its own `try/catch`
    (returns `{}` on failure), and assigns `v[key] = "<k(saved)> <pct>%"` only when
    `saved > 0`. Export the function.
  - Wire into `main()` merge at `src/statusline.js:290`:
    `const values = { ...buildValues(data), ...activityValues(st, now), ...sysValues(cwd), ...statsValues() };`
- **Patterns to follow:** `readState()` (`src/statusline.js:194`) for the defensive read;
  `statePath()` (`:188`) for env-first paths; `model.window` (`:135`) for abbreviation;
  `sysValues`/`activityValues` (`:216`, `:237`) for the value-source shape.
- **Test scenarios** (implemented in U3):
  - lean-ctx file valid with `tokens_saved: 8263, compression_rate: 63` → `save.leanctx`
    is `"8.3k 63%"`.
  - LLMLingua nested (smart-read) `session.tokens_saved` positive → `save.lingua` emitted
    from the session figure. Covers R6.
  - LLMLingua flat-only (`tokens_saved_total`, no `session`) → `save.lingua` omitted.
    Covers R6.
  - Missing file (path points nowhere) → key omitted, no throw. Covers R3, R4.
  - Malformed JSON (truncated/garbage) → key omitted, no throw. Covers R3.
  - `tokens_saved: 0` → key omitted (not `"0k 0%"`). Covers R4.
  - Present file but `tokens_saved` key missing → omitted. Covers R3.
  - `k()` formatting: `8263 → "8.3k"`, `512 → "512"`, `1_200_000 → "1.2M"`, `0 → "0"`.
  - Env overrides (`DOOMBAR_LEANCTX`, `DOOMBAR_LLMLINGUA`) are honored so fixtures load.
- **Verification:** Importing `statsValues` and pointing the env vars at temp fixtures
  produces the expected keys; pointing them at nonexistent paths yields `{}` with no throw.

### U2. `SAVE` preset box and preview sample data

- **Goal:** Render the two savings rows in a new `SAVE` box, and make them visible in the
  `render.js` preview CLI.
- **Requirements:** R8, R9, R10.
- **Dependencies:** U1 (value keys must exist).
- **Files:** `presets/default.toml`, `presets/full.toml`, `src/render.js` (SAMPLE).
- **Approach:**
  - New box with two metrics:
    `{ id = "save.leanctx", render = "text", icon = "🪶" }` and
    `{ id = "save.lingua", render = "text", icon = "📜" }`.
  - `presets/default.toml`: insert the box right after the `USAGE` segment (→ `USAGE`,
    `SAVE`, mugshot, `GIT`).
  - `presets/full.toml`: insert the box between `USAGE` and `PROJECT`.
  - Add `"save.leanctx": "8.3k 63%"` and `"save.lingua": "1.2k 1.3x"` to `SAMPLE`
    (`src/render.js:30`) so `node src/render.js` previews the box. Note: this pulls the
    `SAVE` box into the existing width-uniformity assertion in
    `test/render-scroll.test.mjs` (it renders `full.toml` with `...SAMPLE` and asserts all
    rows are equal width) — expect that test to now exercise `SAVE`; it should still pass.
- **Patterns to follow:** existing box/metric TOML blocks in `presets/full.toml`;
  `SAMPLE` entries in `src/render.js`.
- **Test scenarios** (implemented in U3):
  - With both keys in VALUES, the `SAVE` box renders both rows; the numbers begin at the
    same column (icons are width 2). Covers R9, R10.
  - With neither key present (`setValues({})` shape), `buildBar` omits the `SAVE` box
    entirely. Covers R8.
  - Width guard: `vlen("🪶") === 2` and `vlen("📜") === 2`. Covers R10.
- **Verification:** `node src/render.js presets/default.toml` shows the `SAVE` box after
  `USAGE`; removing the sample keys collapses the box.

### U3. Tests for the value-source and box collapse

- **Goal:** Cover every defensive branch and the box-collapse behavior.
- **Requirements:** R1–R10 (verification).
- **Dependencies:** U1 (code under test); U2 (preset box + SAMPLE keys for the render assertions).
- **Files:** `test/statusline-savings.test.mjs` (new); `package.json` (test script).
- **Approach:**
  - Follow the repo harness: `#!/usr/bin/env node`, hand-rolled `ok(c, m)`, exit non-zero
    on any failure. Import `statsValues` from `../src/statusline.js`, and `vlen`,
    `setValues`, `buildBar` from `../src/render.js`.
  - Write temp fixture JSON via `mkdtempSync(os.tmpdir())`, set `DOOMBAR_LEANCTX` /
    `DOOMBAR_LLMLINGUA` to point at them, assert on `statsValues()` output, and clean up in
    a `finally` (`rmSync(..., { recursive: true, force: true })`) — mirroring
    `test/smoke.test.mjs`.
  - Box-collapse: seed the OTHER metric keys (e.g. spread `SAMPLE`) but omit `save.*`,
    then `buildBar(cfg, target)` and assert the `SAVE` header is absent while `USAGE`/`GIT`
    still render. Do **not** use `setValues({})` — that collapses every box, so the test
    would pass even if `SAVE` were never wired into the preset (non-discriminating). The
    empty-VALUES collapse mechanism itself is exercised in `test/render-scroll.test.mjs`.
  - **Append the new file to the `test` script's `&&` chain in `package.json` (line 18)** —
    tests are not auto-discovered; an unappended file silently never runs (and would slip
    past `preversion`/`prepublishOnly`).
- **Patterns to follow:** `test/statusline-tasks.test.mjs` (pure-function assertions),
  `test/smoke.test.mjs` (temp files + env), `test/render-scroll.test.mjs` (empty-VALUES
  collapse).
- **Execution note:** Write the defensive-read scenarios test-first — the omit-on-failure
  contract (R3/R4) is the load-bearing behavior and is easiest to pin before wiring.
- **Test scenarios:** the full lists under U1 and U2.
- **Verification:** `npm test` runs the new file as part of the chain and it passes.

---

## Scope Boundaries

### Deferred for later

- Lifetime cumulative savings (LLMLingua has it cleanly; lean-ctx lifetime is unreliable).
- Exact per-Claude-session attribution. `mcp-live.json` is a single global file keyed by
  lean-ctx's own `started_at`, not the Claude `session_id`; the session approximation is
  accepted (origin R1 / session-correlation decision).

### Deferred to follow-up work

- v2 crawl4ai / defuddle savings via a user-owned logger-wrapper (raw HTML → markdown
  delta; the tools persist nothing today). The source list in U1 reserves the slot —
  adding the row later is one `{key, path, extract}` entry plus one preset line. Cleanest
  logger home is extending `smart-read.py`.

### Outside this product's identity

- A registry / plugin system for arbitrary third-party savings sources (speculative
  carrying cost — two real native sources, not ten hypothetical ones).
- markitdown as a savings source — binary→markdown has no token baseline to "save"
  against; it enables rather than compresses.

---

## Risks & Dependencies

- **Schema/path drift** is the expected failure mode, not an exception: R3/R4 make any
  renamed key or moved file collapse the row silently. No version pin on either tool.
- **LLMLingua is usually absent** — not in the live loop and currently broken on this
  machine (`OSError 1455`). The `📜` row will be hidden most of the time by design (R8);
  do not treat its absence in manual testing as a defect.
- **Test-script append is load-bearing** — forgetting the `package.json` chain edit means
  the test never runs and the gap is invisible.

---

## Open Questions

- LLMLingua secondary figure: the live nested session schema carries `last_ratio` (e.g.
  `1.3`) but **no** `last_saved_pct` and no original-token count, so a percent is not
  derivable from the session block. Default to rendering the ratio (`1.3x`) for the session
  path; use `last_saved_pct` only if a future writer provides it. Low-risk display choice;
  does not block. (lean-ctx's `%` is unaffected — its `compression_rate` is a direct
  percentage, confirmed above.)
