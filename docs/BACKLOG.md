# Backlog

One list of every open proposal and idea, so nothing gets lost between ideation documents. Details live in
the linked documents; this file only tracks **what is open, in what order, and where it is described**.

Update it when an item ships (move it to *Done*, with the version), when a new idea is written up, or
when the owner decides against something (move it to *Won't do*, with the reason).

Status: `next` = agreed, do soon · `open` = agreed direction, not scheduled · `idea` = not decided ·
`blocked` = waiting on something outside the project.

Last reviewed: 31.10.2026 (0.13.1).

## Housekeeping: temp-file leaks and wasted hook work
Source: [ideation/2026-10-31-temp-file-leaks-and-hook-cost.md](ideation/2026-10-31-temp-file-leaks-and-hook-cost.md)

| ID | Item | Status |
|---|---|---|
| L-B | `SessionEnd` hook deletes the session's files (decide what `--resume` needs first) | next |
| L-C | Sessions that never rendered: delete after ~1 h instead of 7 days | next |
| L-E | Unlink the `.tmp` when an atomic rename fails (checkpoint, ratelimits) | next |
| L-F | Probe markers **and `savings_*`** follow the state location (`MUGSHOT_STATE`), so tests stop writing into the real `%TEMP%` | next |
| L-G | Sweep knows every file the bar writes (`savings_*`; shared files listed in `SHARED_STATE`) | next |
| L-D | No git / tasklist probes in headless sessions (verify `CLAUDE_CODE_ENTRYPOINT` or probe only after first render) | open |
| L-A | Own directory `%TEMP%/claude-game-bar/<session>/`, sweep lists only that; first sweep removes old-style files | open, with R-1 |

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
| G-1 | Snapshot tests pinning today's Minecraft and DOOM output at several widths (before R-1 and the refactor) | next |
| G-2 | Layout registry instead of `if (layout === …)` in `statusline.js` | open |
| G-3 | User-level preset overlay `~/.claude/<bar>/<theme>.toml` so slot choices survive npm updates | open |
| G-4 | Extract the shared HUD kit: cell fit (escape-safe), gauge row (merge `rIcons` + `glyphCells`), meter bar, grid, selection, portrait | open |
| G-5 | Hotbar uses the shared width planner, `[bar].fallback` and `text_overflow` | open |
| G-6 | Chat as data: script in TOML, declarative conditions, generic facts, cast from data | open |
| G-7 | Chat packs: universal metric lines keyed, a game pack overrides by key and adds atmosphere lines; chat refers to sockets (`{hearts}`), not metrics | open |
| G-8 | Warcraft III layout on top of the kit | open |
| G-9 | Decide who owns conversation order: game skeleton pulling universal lines, or universal lines dealt into gaps | idea |

## Performance: bash spawns, shared statusbar
Source: [ideation/2026-10-14-bash-spawn-and-shared-statusbar.md](ideation/2026-10-14-bash-spawn-and-shared-statusbar.md)

| ID | Item | Status |
|---|---|---|
| P-1 | Find out what is expensive in a render and what really needs the 1 s refresh (refresh stays at 1 s) | open |
| P-2 | One shared producer for account- and machine-wide data (limits, CPU/RAM, clock); renders only read | open |
| P-3 | Shared rate limits: treat a window past its `resets_at` as reset; scope the file per Claude account, not per OS user | idea |

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

## Won't do

| Item | Reason |
|---|---|
| Event-driven-only HUD, no refresh timer | The 1 s refresh is fixed (owner's decision); events supplement it |
| Raising or removing `refreshInterval` to fix Windows bash pile-up | Same; fix the cause instead (P-1, P-2) |
