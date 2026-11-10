# Backlog

One list of every open proposal and idea, so nothing gets lost between ideation documents. Details live in
the linked documents; this file only tracks **what is open, in what order, and where it is described**.

Update it when an item ships (move it to *Done*, with the version), when a new idea is written up, or
when the owner decides against something (move it to *Won't do*, with the reason).

Status: `next` = agreed, do soon · `open` = agreed direction, not scheduled · `idea` = not decided ·
`blocked` = waiting on something outside the project.

Last reviewed: 31.10.2026 (0.13.1).

## Render daemon, glyph renderer, minimap
Source: [ideation/2026-11-09-render-daemon-and-minimap.md](ideation/2026-11-09-render-daemon-and-minimap.md)

Owner's order: daemon first, renderer second, minimap and WC3 after. `ce-ideate` done (Part 6 of the source doc); next step: `ce-brainstorm` on a chosen idea.

| ID | Item | Status |
|---|---|---|
| D-1 | One render daemon for all sessions; statusLine becomes a bash thin client using builtins only (payload in, frame out, no fork); daemon down → static offline frame, nothing spawned. Absorbs P-2 | next |
| D-2 | Hook events into the daemon without a spawn per tool call (HTTP hooks, if Claude Code supports them and fails safe) | idea |
| D-3 | Built-in bitmap → glyph renderer on the mugshot glyph set (`block+half+quad+sextant+wedge+legacy`), half-block mode as a setting | next |
| D-4 | Compare the built-in renderer with chafa on the mugshot; drop chafa if close enough | idea |
| D-5 | WC3 minimap: layered metrics (terrain, fog, units per agent, pings), map larger than the view, event-driven camera. Which metric goes to which layer is open | idea |
| D-6 | WC3 console elements beyond the minimap: portrait with races (original art), info panel, inventory, command card, resource bar, day/night clock | idea |
| D-7 | Frame reel with a deadline, read by a write-once client (Part 6 idea 1). The client contract for D-1; replaces the broken `-nt` liveness test | idea |
| D-8 | Glyph truth on the real terminal: test card + fallback ladder, render-back error score vs chafa (Part 6 idea 2). Gate for D-3 and D-4 | idea |
| D-9 | Per-repo ledger behind the map, "changed since Claude read it" layer, provenance, allied sessions (Part 6 idea 3). Data model for D-5 | idea |
| D-10 | Animation cadence per element: telemetry on data arrival, effects as fast as the display allows (~10 ms), DOOM mugshot fixed at ~1 s; pose-to-pose sampling where the display is 1 Hz (Part 6 idea 4). For D-6 portrait | idea |
| D-11 | Crash-only daemon with a version-named pipe as singleton and upgrade path (Part 6 idea 5). Lifecycle for D-1 | idea |
| D-12 | Cell-space compositor with two resolvers: lookup table for map and chrome, error search for portrait (Part 6 idea 6). Shape of D-3 | idea |
| D-13 | XP from resolved work, kept per repo (Part 6 idea 7). For D-6 / G-8 | idea |

## Housekeeping: temp-file leaks and wasted hook work
Source: [ideation/2026-10-31-temp-file-leaks-and-hook-cost.md](ideation/2026-10-31-temp-file-leaks-and-hook-cost.md)

| ID | Item | Status |
|---|---|---|
| L-D | No git / tasklist probes in headless sessions (verify `CLAUDE_CODE_ENTRYPOINT` or probe only after first render) | open |
| L-A | Own directory `%TEMP%/claude-game-bar/<session>/`, sweep lists only that; first sweep removes old-style files | open, with R-1 |
| L-H | Give the savings file a bar-specific prefix (the sweep now owns the generic `savings_` prefix in the temp dir) and narrow `.tmp` cleanup to bar-owned names under a custom `MUGSHOT_STATE`; both disappear with L-A | open, with L-A |
| L-I | An async Stop hook still running at session end can recreate a journal line or git marker after SessionEnd cleanup; the 1-hour sweep collects them. Revisit with L-A | idea |
| L-J | Add a `windows-latest` job to the Test workflow; Windows runs only locally today | idea |

## Rename to `claude-game-bar`
Source: [ideation/2026-10-31-shared-game-layout-engine.md](ideation/2026-10-31-shared-game-layout-engine.md), section *Rename*

| ID | Item | Status |
|---|---|---|
| R-0 | Agree the rename and the refactor with the contributor | next |
| R-1 | Rename package, bin (old bin as alias), repo, env vars `DOOMBAR_*` → `GAMEBAR_*` (with fallback), theme file, temp prefix; DOOM-specific code keeps `doom` | open |
| R-2 | Neutral reaction state `{expr, hp, god, dead}` instead of DOOM sprite names between engine and layouts | open |
| R-3 | npm: set up trusted publishing for the new package, last `claude-doom-statusbar` release with a notice, `npm deprecate` | open |
| R-4 | `install` migrates settings in place (paths, env names, theme file) | open |

## Shared game layout engine
Source: [ideation/2026-10-31-shared-game-layout-engine.md](ideation/2026-10-31-shared-game-layout-engine.md)

| ID | Item | Status |
|---|---|---|
| G-2 | Layout registry instead of `if (layout === …)` in `statusline.js` | open |
| G-3 | User-level preset overlay `~/.claude/<bar>/<theme>.toml` so slot choices survive npm updates | open |
| G-4 | Extract the shared HUD kit: cell fit (escape-safe), gauge row (merge `rIcons` + `glyphCells`), meter bar, grid, selection, portrait | open |
| G-5 | Hotbar uses the shared width planner, `[bar].fallback` and `text_overflow` | open |
| G-6 | Chat as data: script in TOML, declarative conditions, generic facts, cast from data | open |
| G-7 | Chat packs: universal metric lines keyed, a game pack overrides by key and adds atmosphere lines; chat refers to sockets (`{hearts}`), not metrics | open |
| G-8 | Warcraft III layout on top of the kit (minimap: see D-5, after D-1 and D-3) | open |
| G-9 | Decide who owns conversation order: game skeleton pulling universal lines, or universal lines dealt into gaps | idea |

## Performance: bash spawns, shared statusbar
Source: [ideation/2026-10-14-bash-spawn-and-shared-statusbar.md](ideation/2026-10-14-bash-spawn-and-shared-statusbar.md)

| ID | Item | Status |
|---|---|---|
| P-1 | Find out what is expensive in a render and what really needs the 1 s refresh (refresh stays at 1 s) | open |
| P-2 | One shared producer for account- and machine-wide data (limits, CPU/RAM, clock); renders only read | open, folds into D-1 |
| P-3 | Shared rate limits: treat a window past its `resets_at` as reset; scope the file per Claude account, not per OS user | idea |
| P-4 | Detached `node hook.js --reap` processes sometimes never exit and pile up (2026-11-10: 10 alive, oldest ~1 h, ~33 MB each, no children, parents gone; a reaper started by hand exits in 0.9 s). Suspected contributor to an out-of-memory crash the same day. Find where they block; the one-shot `maybeReap` path still starts one per interval regardless (the daemon now waits for its previous reaper to exit) | open |

## Mugshot health estimator
Source: [ideation/2026-07-11-cap-ratio-accumulator-fix.md](ideation/2026-07-11-cap-ratio-accumulator-fix.md)

| ID | Item | Status |
|---|---|---|
| H-A | Paired instantaneous deltas with EWMA / median as the core `k` estimator | open |
| H-B | Decay / TTL on the accumulator | open |
| H-C | Fix the write race (atomic write, or freeze `k` once converged) | open |

## Features from the original ideation
Source: [ideation/2026-06-06-doom-statusbar-ideation.md](ideation/2026-06-06-doom-statusbar-ideation.md)
(the *Status* lines in that document are from June and not maintained; this table is current)

| ID | Item | Status |
|---|---|---|
| F-1 | Live "advising / reviewing now" indicator | blocked: needs a server-tool hook, a payload flag or mid-turn transcript flush from Claude Code |
| F-2 | Session memory: local telemetry and an intermission screen at `Stop` | idea |
| F-3 | Optimal session window (when to restart, 30–70 % context) | idea |
| F-4 | Sound effects on hook events (opt-in, original sounds) | idea |

## Small fixes from the 0.13.0 review

| ID | Item | Status |
|---|---|---|
| S-1 | Chat jumps when a condition flips (loop length depends on the filtered list) | open (folds into G-6) |
| S-2 | Hearts and hunger overlap below ~30 columns | open (folds into G-5) |
| S-3 | Duplicate, outdated comment above `EFFORT_COLOR` in `hotbar.js` | open |
| S-4 | AGENTS box mislabels and miscounts subagents. Observed 2026-11-10: two running `general-purpose` agents ("Simplify review: test value", "Simplify review: comments") both showed as `iew: comments 3m`, while Claude Code's own list showed three running agents. Leads: `SubagentStart` takes the description from the first pending `Agent` launch of the same `agent_type` (FIFO in `src/fold.js`), so parallel launches of one type can get swapped or duplicated labels; an agent that stopped while its own background work still runs gets `SubagentStop`, so the bar drops it while Claude Code still lists it. Verify against the journal before fixing | open |

## Done

| Item | Version |
|---|---|
| Face-first HUD (Doomguy reacts to hooks) | early releases |
| Geiger counter activity (`act.geiger`) | ≤ 0.11 |
| TASKS box with the task list (`act.tasklist`) | ≤ 0.11 |
| Advisor model shown, god-mode flash after a consult | ≤ 0.11 |
| Cap-ratio floor `k ≥ 1` (H-D) | ≤ 0.11 |
| Theme switch + Minecraft hotbar theme | 0.12.0–0.13.0 |
| Rate limits shared across sessions (first shared piece of P-2) | 0.13.1 |
| End-of-session cleanup, 1-hour sweep for unrendered sessions, every per-session file next to its checkpoint, no orphaned `.tmp` (L-B, L-C, L-E, L-F, L-G) | unreleased |
| Snapshot tests of the DOOM presets and the Minecraft hotbar, Linux test workflow on every push (G-1) | unreleased |

## Won't do

| Item | Reason |
|---|---|
| Event-driven-only HUD, no refresh timer | The 1 s refresh is fixed (owner's decision); events supplement it |
| Raising or removing `refreshInterval` to fix Windows bash pile-up | Same; fix the cause instead (P-1, P-2) |
