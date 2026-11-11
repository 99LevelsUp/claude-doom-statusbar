---
title: Built-in Glyph Renderer - Plan
type: feat
date: 2026-11-11
topic: builtin-glyph-renderer
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Built-in Glyph Renderer - Plan

## Goal Capsule

- **Objective:** by default the bar draws its images (today the DOOM mugshot, later the WC3 head and minimap) without starting any external process, at a quality the owner judges by eye to match chafa's. The optional chafa setting of R12 is the only exception.
- **Means:** a built-in pixel-to-glyph conversion inside the bar, with a glyph set per image, capped by what the terminal can draw.
- **Product authority:** the owner (Petr Skypala). This plan covers only the conversion and its quality gate for the DOOM mugshot. The minimap resolver, the WC3 portrait hook-up and on-demand asset download are not active scope.
- **Open blockers:** none.

---

## Product Contract

### Summary

A built-in converter turns an image into terminal glyphs by searching, for every cell, the glyph and colour pair with the smallest error, the way chafa does. Each image gets its own glyph set, and the terminal type caps it. A test card and an error score measured against chafa inform the owner, who decides by eye whether chafa can leave the DOOM bar.

### Problem Frame

The DOOM mugshot is drawn by chafa, an external program. The render daemon has to start it as a process, and on the owner's PC starting any process costs 1 to 4 seconds idle and up to 50 seconds under load (measured 2026-11-11, `lab/daemon-spike/RESULTS.md`). Without chafa the bar falls back to 546 pre-rendered `.ans` faces at fixed heights 4 to 16.

The WC3 bar will need the same step for every animated frame of a 3D-rendered head (lab prototype, `docs/ideation/2026-11-09-render-daemon-and-minimap.md` Part 5). Spawning chafa per frame costs about 35 ms, ten times the render itself. Without an in-process conversion there is no way to show those heads.

A second problem shows on weak terminals. Today every user gets chafa's full glyph set, sextants and octants included. The owner once saw the bar in the legacy Windows console host (cmd outside Windows Terminal), where it looked broken. A status line cannot ask the terminal what it can draw.

### Key Decisions

- **This plan owns the conversion for the DOOM mugshot, with the test card and score as its gate.** (session-settled: user-directed — chosen over the test card and score alone, and over building the minimap cell grid (D-12) in the same plan: one delivery with clear value, the daemon stops starting chafa.) Governs R1–R5, R10–R13.
- **Per-cell search, chafa-style, including wedge glyphs.** (session-settled: user-directed — chosen over "two colours first, then a pattern table" and over "half blocks first, richer sets later": the only option with a real chance of replacing chafa on the mugshot.) Governs R2.
- **The glyph level follows the terminal type, read from the environment.** (session-settled: user-directed — chosen over one set for everyone and over a choice made once at install time: a terminal cannot be queried from the status line, and an install-time answer is wrong when Claude Code later runs in another terminal.) Governs R7, R8.
- **The owner decides by eye; the score informs.** (session-settled: user-directed — chosen over the eye alone and over an automatic threshold: the score measures ideal glyph masks, not how a font draws them.) Governs R10, R11.
- **Each image has its own glyph set, and the terminal level caps it.** Owner's requirement: the WC3 head wants the richest set including wedges, the minimap a simpler one. Governs R3, R4.
- **The built-in conversion becomes the default at once, before the D-4 verdict.** (session-settled: user-approved — proposed with the trade-off that users who have chafa installed will see the new conversion; the owner confirmed.) Governs R5, R12.
- **The pre-rendered `.ans` faces go.** (session-settled: user-approved — the conversion draws any height, so the fixed-height fallback has no remaining job.) Governs R13.
- **Every platform, not only the Windows daemon.** (session-settled: user-approved — the one-shot renderer on Linux and macOS stops starting chafa too.) Governs R5.
- **If the built-in conversion is good enough, chafa leaves entirely.** Carried from the owner's decision in the ideation doc: "better still, a built-in renderer that is good enough to be the full one." Governs R12.

### Requirements

**Conversion**

- R1. The bar converts an RGBA image to a grid of terminal cells (glyph, foreground, background) inside its own process, at any requested height in rows, without starting a process.
- R2. For every cell the conversion picks the glyph and colour pair with the smallest error among the glyphs the image may use.
- R3. Every image the bar draws is converted with its own glyph set, named by the element that draws it.
- R4. No image ever uses a glyph class above the terminal's level (R6), whatever its own set allows.
- R5. The DOOM mugshot uses the built-in conversion by default on every platform, at its current cadence of about one frame per second.

**Terminal glyph level**

- R6. The terminal level is one step of a ladder of glyph classes, from half blocks only up to the richest classes the test card (R9) shows drawn correctly on the owner's Windows Terminal.
- R7. The default level follows the terminal type read from the session's environment: Windows Terminal and known modern terminals get the richest level that passed the test card; an unknown terminal or the Windows console host gets half blocks.
- R8. A setting overrides the level. One daemon serving sessions in different terminals draws each session at that session's own level.
- R9. A command prints the test card, every glyph class labelled with its ladder step, in any terminal window, so a user can judge by eye which level to set.

**Quality gate and chafa**

- R10. An error score renders a glyph output back to pixels from the glyph masks and compares it with the source image. It scores the built-in conversion and chafa on the 42 DOOM face sprites at heights 4 to 16, both limited to the same glyph set, and it measures the error differently from the per-cell error the search of R2 minimises, for example on a slightly blurred render-back.
- R11. The owner sees the built-in and chafa faces side by side on their own terminal and gives the D-4 verdict; the scores from R10 sit beside the pictures as advisory evidence, because the built-in search optimises an error close to the one being measured.
- R12. Until the verdict, chafa draws the mugshot only when a setting asks for it. A positive verdict removes chafa from the bar; a negative one keeps it as that optional setting.
- R13. The pre-rendered `.ans` faces are removed once the built-in conversion is the default.

### Acceptance Examples

- AE1. **Covers R3, R4, R7.** **Given** a session in the Windows console host, **when** an image whose own set allows wedges and octants is drawn, **then** it is drawn with half blocks only.
- AE2. **Covers R7, R8.** **Given** one daemon serving a session in Windows Terminal and another in the console host, **when** both draw the mugshot, **then** the first uses the test-card level and the second half blocks.
- AE3. **Covers R8.** **Given** Windows Terminal with a font that lacks octants, **when** the user sets the level to sextants, **then** no octant appears in any image of that user's sessions.
- AE4. **Covers R5, R12.** **Given** chafa is installed and the setting does not ask for it, **when** the mugshot is drawn, **then** no chafa process starts.

### Success Criteria

- The D-4 verdict is reached from the side-by-side faces and the R10 scores, and recorded in `docs/BACKLOG.md`.
- With the bar running and the optional chafa setting of R12 off, no process starts to draw a face, at any height (checked on the owner's PC).
- Claude Code runs as fast as without the bar (owner's hard limit, `docs/ideation/2026-11-09-render-daemon-and-minimap.md`). Where the render daemon runs (Windows with Git Bash), the conversion runs inside it at below-normal priority and adds no measurable cost. Where it does not (Linux, macOS), the one-shot renderer's face conversion costs no more per tick than the chafa process it replaces, measured at the richest terminal level.

<!-- ce-section: work-relationships -->
### How This Work Fits Together

This plan covers the built-in conversion and its quality gate, used by the DOOM mugshot. The breakdown below is the current understanding, not a committed roadmap.

- WC3 portrait hook-up: **depends on** this plan; the 3D renderer in `lab/wc3-portraits/render/` produces RGBA frames that go through the same conversion with the richest per-image set (R3).
- Cell-space compositor and lookup resolver for the minimap (D-12): **depends on** the cell grid from R1 and **shares** the terminal level (R6); still to decide whether it adds a second resolver beside the search.
- Animation cadence per element (D-10): **can proceed independently of** this plan.
- On-demand asset download and removal by settings: **can proceed independently of** this plan; removing the `.ans` faces (R13) shrinks what the DOOM bar ships.

### Scope Boundaries

- The minimap, its lookup resolver and layer priority (D-12).
- Wiring the WC3 3D renderer into the daemon, and the WC3 layout itself (G-8).
- Faster-than-one-second animation (D-10) and the frame reel (D-7).
- On-demand download and removal of assets by settings (new backlog item).
- Asking the terminal for its capabilities: the status line has no channel to it.

### Dependencies / Assumptions

- A PNG decoder exists in the lab prototype (`lab/wc3-portraits/render/png-decode.js`, built-in `zlib`, 8-bit, no interlace) and can be reused for the face sprites in `assets/images/mugshot/alpha/`.
- Terminal type is a guess from environment variables such as `WT_SESSION` and `TERM_PROGRAM`. A terminal reached over SSH, or Windows Terminal with an old font, can get the wrong default; R8 is the remedy.
- The bash client forwards a fixed list of variables today (`src/doombar-client.sh`), without the terminal-identifying ones; R8 needs them per session.

### Outstanding Questions

**Deferred to Planning**

- Where wedges sit in the ladder relative to sextants and octants follows from the test card result, not from a decision now.
- Which terminals count as "known modern" beyond Windows Terminal, and the name and form of the override setting.
- The colour space and error measure of the score (the ideation suggests OKLab).

### Sources / Research

- `docs/ideation/2026-11-09-render-daemon-and-minimap.md`: Part 2 (renderer), Part 5 (3D prototype and the 35 ms chafa cost), Part 6 ideas 2 and 6.
- `src/face.js`: chafa call with the set `block+half+quad+sextant+wedge+legacy`, `.ans` fallback clamped to heights 4–16, no-spawn mode with an asynchronous chafa warm-up in the daemon.
- `lab/daemon-spike/RESULTS.md`: process start cost and starvation measurements, 2026-11-11.
- `docs/BACKLOG.md`: D-3, D-4, D-8, D-12.

## Deferred / Open Questions

These are review items left for the author. They do not block implementation.

### From 2026-11-11 review

- **No in-process route if the built-in conversion loses the chafa comparison** — Goal Capsule (Objective) and R12 (chafa until and after the D-4 verdict) (P2, adversarial, confidence 75)

  If the owner's verdict goes against the built-in conversion, the only way left to reach chafa's quality is starting chafa as a process, which the animated WC3 heads cannot afford. chafa also exists as a WebAssembly build that runs inside the process (`chafa-wasm` on npm, 0.3.3, LGPL-3.0). Decide after a negative verdict whether it becomes the fallback, weighing the LGPL licence beside this MIT package, its maturity and its start-up cost in the one-shot renderer.
