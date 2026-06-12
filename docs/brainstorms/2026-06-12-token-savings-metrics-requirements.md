# Token-Savings Metrics — Requirements

**Date:** 2026-06-12
**Status:** Ready for planning
**Scope:** Standard

## Outcome

The DOOM HUD shows how many tokens the user's context-optimization tools are
saving, as a live, per-tool readout. v1 reads savings that two tools already
persist to disk; no plugin code is patched.

## Problem / Context

The user runs several token-saving tools (lean-ctx, LLMLingua/smart-read, plus
web→markdown and document converters). The HUD currently maps session metrics to
DOOM elements (context→HP, rate limits→ammo, etc.) but shows nothing about the
savings these tools produce.

The original framing assumed the savings data was unavailable and that an
"injection into the plugins that survives updates" would be required. **That
premise does not hold:** the two tools that matter already write savings to plain
JSON on disk. The HUD reads them the same defensive way it already reads the hook
state file and advisor transcript (`readState`, `advisorInfo` in
`src/statusline.js`). No plugin source is patched, so "surviving plugin updates"
is not about avoiding patches — it is about tolerating **schema/path drift** in
the files we read.

## What we're building

A new native value-source in `src/statusline.js` (sibling to `buildValues`,
`activityValues`, `sysValues`) that reads savings stats files defensively and
emits per-tool value keys. The preset (`presets/*.toml`) renders them as two
separate rows.

This is **not** a wrapper script. The reference design in the vault
(`claude-hud + lean-ctx wrapper.md`) wraps a third-party closed HUD; this project
owns its statusline, so the reader is integrated natively — cleaner than a wrapper.

## Requirements

### Data sources (v1 — native readable savings)

| Tool | File | Keys used (session-scoped) |
|------|------|----------------------------|
| lean-ctx | `~/.lean-ctx/mcp-live.json` | `tokens_saved`, `compression_rate` |
| LLMLingua | `~/.llmlingua-stats.json` | `session.tokens_saved`, `session.last_ratio` |

Example rendered output (icon *is* the label — no text, matching every existing
metric in `presets/*.toml`):

```
🪶 8.3k 63%
📜 1.2k 75%
```

**Icons (chosen):** lean-ctx → 🪶 (U+1FAB6, feather = "lean", lightweight);
llmlingua → 📜 (U+1F4DC, scroll = prose, which is what LLMLingua compresses).
Identity-based: the icon says *which* tool, the number says *how much*.
Collision-free against the 26 icons already in use
(🧠🕔📅🌿⇅💰🤖💭🚀📋⏩🎨🧙💾🎮📁📝⇧📟👹🎯💢🔥💿🕙🕓).

**Width alignment (verified).** The renderer measures display width via `vlen()`
in `src/render.js`, which assigns width 2 to code points in `0x1F300–0x1FAFF`
(plus a few extras) and width 1 otherwise. For rows to align, the icon's *real*
terminal width must equal what `vlen()` computes. Both chosen icons are
default-**emoji-presentation** astral chars: 🪶 and 📜 each measure `vlen = 2` and
render as 2 columns, matching the existing 🧠 (U+1F9E0). Because both savings rows
carry a width-2 label, their numbers start in the same column and the box pads to a
common width automatically — **no manual spacing, no `vlen()` change**.

Rejected for this renderer: 🗣 (U+1F5E3) is default-**text**-presentation — bare it
often renders as width 1 while `vlen()` says 2 (row shifts left by one), and the
VS16 form 🗣️ makes `vlen()` overcount to 3 (`U+FE0F` is tallied as a separate
width-1 char). Any future icon added here must likewise be a width-2
emoji-presentation code point in `0x1F300–0x1FAFF`, or `vlen()` must first be taught
to handle VS16 and per-code-point width.

### Behavioral requirements

- **R1 — Session-scoped.** Show savings for the current run, not lifetime.
  lean-ctx's clean number is the live-session one in `mcp-live.json`; its lifetime
  data is scattered and unreliable (`context_ledger.json` showed 0, `stats.json` is
  shell-command tokens not savings). Lifetime is deferred (see Scope).
- **R2 — Per-tool rows, no aggregation.** Two distinct rows keyed by source, not
  one summed number.
- **R3 — Defensive reads are a hard requirement, not polish.** This is the
  developer's *live* statusbar (self-installed hook). Missing file, missing key, or
  malformed JSON must degrade to "metric absent" and never throw. Match the existing
  swallow-everything pattern (`readState`, `advisorInfo`, `cpuPercent`).
- **R4 — Hide when zero/absent (omit the key, never zero it).** A row with no run /
  zero savings is not rendered. The reader must **omit the value key entirely** when
  the file is missing *or* savings are 0 — it must NOT emit `0` or `""`. The renderer
  drops absent keys before render via `available()` (`entry.id in VALUES`); a key set
  to `0` would instead render a misleading `🪶 0` row. LLMLingua will be absent most
  of the time (see Assumptions), so this is the normal case, not an edge case.
- **R8 — Neither tool installed is the common case, and must be invisible.** This
  plugin is published to npm; most installers have neither lean-ctx nor LLMLingua, so
  neither file exists. Verified behavior: defensive read (R3) yields no keys → both
  metrics are filtered by `available()` → rows do not render. If the two savings rows
  live in their **own box**, `buildBar` collapses that box entirely (it only pushes
  segments where `mets.length > 0`); if they are appended to an existing box (e.g.
  USAGE), only those rows vanish. Either way: no crash, no `?`, no empty row, no blank
  placeholder — identical to how `advisor.model` or out-of-repo git metrics already
  disappear. Cost when absent is two failed file stats per ~1 s refresh: negligible.
- **R5 — No binary spawn.** Read the small JSON files only. Do **not** call
  `lean-ctx gain --json` (≈55 MB binary spawn → lag at the 1 s refresh interval).
- **R6 — Tolerate two LLMLingua schemas.** `~/.llmlingua-stats.json` has two known
  writers with different shapes: `smart-read.py` writes nested
  `{session:{...}, lifetime:{...}}`; `llmlingua_logged.py` writes flat
  `{runs, tokens_saved_total, last_ratio, ...}` (lifetime only, no session split).
  Prefer `session.tokens_saved` when present; otherwise treat as absent for the
  session view (do not show lifetime as if it were session).
- **R7 — Configurable source table.** Sources are a small in-code list
  (`{label, file, extract fn}`), so adding a row later is one entry — mirrors how
  `act.subagents` renders a list. This is **not** a pluggable adapter framework.

### Session-correlation (accepted approximation)

`~/.lean-ctx/mcp-live.json` is a single global file keyed by lean-ctx's own
`started_at`, **not** by the Claude `session_id` the HUD receives on stdin.
LLMLingua's session key is derived from the same `started_at`. When multiple Claude
sessions run in parallel, the displayed "session savings" may not correspond exactly
to this HUD's window. **Decision: accept the approximation** — read the file directly
and treat it as "what lean-ctx is currently saving." Exact per-session attribution
(filtering `~/.lean-ctx/events.jsonl`) is deferred.

## Scope boundaries

### In scope (v1)

- Native savings value-source reading the two files above.
- Two per-tool rows, session-scoped, defensive, hidden when empty.
- Configurable source list with room for future entries.
- Preset slots in `presets/default.toml` (and the other presets as appropriate).

### Deferred for later

- **Lifetime cumulative savings.** Harder: LLMLingua has it cleanly
  (`lifetime.tokens_saved_total`) but lean-ctx lifetime is unreliable. A separate step.
- **crawl4ai / defuddle savings (v2).** These genuinely save tokens
  (raw HTML → clean markdown, often the larger reduction) but **neither reports sizes
  nor writes any stats file** — verified against CLI and vault notes. The savings are
  obtainable **only** via a thin logger-wrapper around the invocation (the same
  pattern as the existing `~/.claude/llmlingua_logged.py`): the wrapper counts input
  and output tokens and writes the delta to a stats file the HUD then reads. Because
  the wrapper wraps invocation rather than patching tool source, it survives tool
  updates by construction. The cleanest home is extending `smart-read.py` (which is
  already in the pipeline and already logs the LLMLingua-stage delta, but currently
  misses the fetch/convert-stage reduction) or a shared logger the user owns.
  **Decision: spec the logger and reserve a source-table slot now; build it as
  follow-up work, not in v1.**

### Outside this product's identity

- **A registry / plugin system for arbitrary third-party savings sources.** There
  are two real native sources and two more reachable via a user-owned logger — not
  ten hypothetical ones. The configurable source list (R7) covers real growth; a
  framework would be speculative carrying cost.
- **markitdown as a "savings" source.** markitdown converts binary documents
  (`.docx/.pdf/.xlsx`) to markdown. The original is a binary Claude cannot read at
  all, so there is no token baseline to "save" against — markitdown *enables* rather
  than *compresses*. Reporting "tokens saved" for it would be dishonest. Out of scope
  on principle, not just effort.

## Dependencies / Assumptions

- **A1.** lean-ctx keeps writing `~/.lean-ctx/mcp-live.json` with at least
  `tokens_saved` / `compression_rate`. If a future version renames keys or moves the
  file, R3/R4 make the row disappear silently rather than break the HUD — and that is
  the intended "survives updates" behavior.
- **A2.** LLMLingua data is usually absent. LLMLingua is not in the live prompt loop
  (only runs when `smart-read.py` / the logger is explicitly invoked) and is currently
  broken on this machine (`OSError 1455` — pagefile too small to load the model). The
  `ling` row will therefore be hidden most of the time; that is expected, not a defect.
- **A3.** Refresh interval is ~1 s; all reads must stay cheap (small-file JSON parse,
  no spawn) — see R5.

## Prior art

- `d:/vault/Reference/AI CLI tools/Dev UX/claude-hud + lean-ctx wrapper.md`
  (2026-06-04) — a working savings readout for the *other* HUD (claude-hud) via a
  wrapper. Source of the exact file paths, JSON keys, `k()` number formatting,
  hide-when-zero rule, the two-LLMLingua-schema fact, and the no-binary-spawn /
  budget-gauge-not-on-disk gotchas. We reuse the data logic, drop the wrapper mechanism.

## Open questions

- **Q1.** Placement and DOOM framing of the savings rows. Two coupled decisions for
  planning against `presets/*.toml`:
  - **Own box vs. appended to USAGE.** A dedicated box (e.g. a "BONUS" /
    intermission-style block) collapses cleanly to nothing when both tools are absent
    (R8) and reads as a distinct concept; appending to USAGE keeps the HUD shorter but
    mixes savings with context/limits. Own box is the likely better fit given R8.
  - **Which presets include it.** Since the npm audience usually has neither tool
    (R8), consider whether the rows belong in `default.toml` at all, or only in
    `full.toml` / a dedicated preset — for most installers the default would simply
    never show them.
- **Q2.** v2 logger home — extend `smart-read.py` to also record the fetch/convert
  stage, or a separate shared logger? (Resolve when v2 is picked up.)

## Handoff

Suggested next step: `/ce-plan` for the v1 native value-source — concrete changes to
`src/statusline.js` (the savings value-source + defensive readers), `presets/*.toml`
(the two rows), and tests under `test/` (defensive-read cases: missing file,
malformed JSON, both LLMLingua schemas, hide-when-zero).
