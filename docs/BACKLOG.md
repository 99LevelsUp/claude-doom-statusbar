# Backlog

One list of every open proposal and idea, so nothing gets lost between ideation documents. Details live in
the linked documents; this file only tracks **what is open, in what order, and where it is described**.

Update it when an item ships (move it to *Done*, with the version), when a new idea is written up, or
when the owner decides against something (move it to *Won't do*, with the reason).

Status: `next` = agreed, do soon · `open` = agreed direction, not scheduled · `idea` = not decided ·
`blocked` = waiting on something outside the project.

Last reviewed: 13.11.2026 (0.15.0).

## Render daemon, glyph renderer, minimap
Source: [ideation/2026-11-09-render-daemon-and-minimap.md](ideation/2026-11-09-render-daemon-and-minimap.md)

Owner's order: daemon first, renderer second, minimap and WC3 after. The daemon (D-1) and the renderer (D-3, D-4, D-8) are done, see *Done*; next are the minimap and WC3.

| ID | Item | Status |
|---|---|---|
| D-2 | Hook events into the daemon without a spawn per tool call (HTTP hooks, if Claude Code supports them and fails safe) | idea |
| D-5 | WC3 minimap: layered metrics (terrain, fog, units per agent, pings), map larger than the view, event-driven camera. Which metric goes to which layer is open | idea |
| D-6 | WC3 console elements beyond the minimap: portrait with races (original art), info panel, inventory, command card, resource bar, day/night clock | idea |
| D-7 | Frame reel with a deadline, read by a write-once client (Part 6 idea 1). The deadline header shipped with D-1 (`slots=1`); the multi-slot reel is still open | open |
| D-9 | Per-repo ledger behind the map, "changed since Claude read it" layer, provenance, allied sessions (Part 6 idea 3). Data model for D-5 | idea |
| D-10 | Animation cadence per element: telemetry on data arrival, effects as fast as the display allows (~10 ms), DOOM mugshot fixed at ~1 s; pose-to-pose sampling where the display is 1 Hz (Part 6 idea 4). For D-6 portrait | idea |
| D-11 | Crash-only daemon with a version-named pipe as singleton and upgrade path (Part 6 idea 5). Absorbed by D-1: one pipe per installation, version mismatch restarts the daemon | done with D-1 |
| D-12 | Cell-space compositor with two resolvers: lookup table for map and chrome, error search for portrait (Part 6 idea 6). Shape of D-3 | idea |
| D-13 | XP from resolved work, kept per repo (Part 6 idea 7). For D-6 / G-8 | idea |
| D-14 | A new session shows `doombar: offline` for about 3 s before its first frame, even with the daemon running (live test 2026-11-11): the first statusLine call writes the payload and finds no frame. (With no daemon running, `SessionStart` now waits up to 10 s for the payload and starts the daemon then; before, the first frame waited for the first tool call or Stop) | idea |
| D-16 | `install --local` over a global install registers every hook twice: it writes the full hook set into `settings.local.json`, and Claude Code merges hooks across scopes (found on the Raspberry Pi, 2026-11-13). Wanted: a dev checkout overrides only the statusLine and env of a global production install, with no second hook set. Option: skip hook entries the user scope already has, or note that hooks stay global. Whether Claude Code dedupes identical exec-form entries is unverified | open |
| D-17 | Line art in the renderer (owner, 2026-11-13).<br>• Box drawing (U+2500–257F): horizontal and vertical lines, corners, T-junctions and crossings in light, heavy and double weights, rounded corners `╭╮╯╰`, dashed lines, and the diagonals `╱ ╲ ╳`.<br>• Symbols for Legacy Computing (U+1FB00–1FBFF): one-eighth lines and diagonal line segments at more angles.<br>• Line glyphs from the Symbols for Legacy Computing Supplement where terminals draw them.<br>Use: frames and dividers for game chrome (WC3 console, minimap edges) and line drawing in the glyph raster. Which glyphs a terminal draws is checked with the test card (D-8) and limited by the glyph level, as for the mugshot. Belongs in `kit/` after the restructure | idea |

## Housekeeping: temp-file leaks and wasted hook work
Source: [ideation/2026-10-31-temp-file-leaks-and-hook-cost.md](ideation/2026-10-31-temp-file-leaks-and-hook-cost.md)

| ID | Item | Status |
|---|---|---|
| L-D | No git / tasklist probes in headless sessions (verify `CLAUDE_CODE_ENTRYPOINT` or probe only after first render) | open |
| L-A | Own directory `%TEMP%/claude-game-bar/<session>/`, sweep lists only that; first sweep removes old-style files. On Linux and macOS the bar already uses a private runtime directory (D-15); L-A narrows it per session | open, with R-1 |
| L-H | Give the savings file a bar-specific prefix (the sweep now owns the generic `savings_` prefix in the temp dir) and narrow `.tmp` cleanup to bar-owned names under a custom `MUGSHOT_STATE`; both disappear with L-A | open, with L-A |
| L-I | An async Stop hook still running at session end can recreate a journal line or git marker after SessionEnd cleanup; the 1-hour sweep collects them. Revisit with L-A | idea |
| L-J | Add a `windows-latest` job to the Test workflow; Windows runs only locally today | idea |

## Rename to `claude-game-bar` and restructure (1.0.0)
Source: [ideation/2026-10-31-shared-game-layout-engine.md](ideation/2026-10-31-shared-game-layout-engine.md), section *Rename*; structure audit and phasing: [ideation/2026-11-13-repo-structure-audit.md](ideation/2026-11-13-repo-structure-audit.md)

Owner, 2026-11-13: rename on GitHub and npm together with 1.0.0; the bar becomes a platform with one general rendering part and game parts (DOOM, Minecraft, Warcraft III next).

| ID | Item | Status |
|---|---|---|
| R-0 | Agree the rename and the refactor with the contributor | done (2026-11-13) |
| R-5 | Test runner that runs every file and summarises (audit step 1) | next |
| R-6 | Move files into `platform/` · `metrics/` · `kit/` · `games/<game>/`, entry paths kept; split `statusline.js`, `render.js`, `hook.js`, `fold.js` (audit steps 2–3) | next |
| R-2 | Neutral reaction state `{expr, hp, god, dead}` instead of DOOM sprite names between engine and layouts (audit step 4) | next |
| R-7 | Render context instead of module-level `VALUES` / face options (audit step 5) | next |
| R-8 | Game registry `games/index.js` replaces `THEMES`; presets and assets under their game (audit step 6) | next |
| R-1 | Rename package, bin (old bin as alias), repo, env vars `DOOMBAR_*` → `GAMEBAR_*` (with fallback), theme file, file prefixes, client name; DOOM-specific code keeps `doom` (audit step 7) | next |
| R-4 | `install` migrates settings in place (paths, env names, theme file) | next |
| R-3 | npm: set up trusted publishing for the new package, last `claude-doom-statusbar` release with a notice, `npm deprecate` (audit step 8) | next |

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
| G-10 | Assets on demand: a DOOM user does not need WC3 models and a WC3 user does not need mugshots, and the WC3 bar will let the user pick which heads to show. Assets may live in the repo, but the bar downloads the ones the settings need and removes the ones they no longer need (owner, 2026-11-11). Own brainstorm; dropping the `.ans` faces (D-3 plan, R13) already shrinks the DOOM set | idea |
| G-9 | Decide who owns conversation order: game skeleton pulling universal lines, or universal lines dealt into gaps | idea |

## Performance: bash spawns, shared statusbar
Source: [ideation/2026-10-14-bash-spawn-and-shared-statusbar.md](ideation/2026-10-14-bash-spawn-and-shared-statusbar.md)

| ID | Item | Status |
|---|---|---|
| P-1 | Find out what is expensive in a render and what really needs the 1 s refresh (refresh stays at 1 s) | open |
| P-2 | One shared producer for account- and machine-wide data (limits, CPU/RAM, clock); renders only read | done with D-1 (the daemon renders every session) |
| P-3 | Shared rate limits: treat a window past its `resets_at` as reset; scope the file per Claude account, not per OS user | idea |
| P-6 | Every hook is a new `node` process, and on the owner's PC starting one is slow: a bare `node -e 0` took 1–4.4 s idle and up to 50 s with every core busy (2026-11-11; a hook costs about the same, so the cost is the process start, likely per-process security scanning). Hooks are async, so Claude Code does not wait, but each one still costs a process start. D-2 (events without a spawn) would remove it | idea |
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
| S-5 | The fine bars draw with octants (`SPARK_OCTANT` in `src/render.js`) whatever the terminal; in the Windows console host they show as boxes. Let the glyph level of the D-3 plan cap them too | idea |
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
| End-of-session cleanup, 1-hour sweep for unrendered sessions, every per-session file next to its checkpoint, no orphaned `.tmp` (L-B, L-C, L-E, L-F, L-G) | 0.14.0 |
| Snapshot tests of the DOOM presets and the Minecraft hotbar, Linux test workflow on every push (G-1) | 0.14.0 |
| Hooks leave a starved daemon alone while the machine is busy (P-5: under 150 s of full load the old hooks claimed two restarts, spending a PowerShell identity check and a new node each; now none) | 0.14.0 |
| Render daemon per installation with a builtins-only bash client, deadline frames greyed OFFLINE when stale, hook supervision (D-1, absorbs D-11 and P-2; Windows with Git Bash) | 0.14.0 |
| Render daemon and bash client on Linux and macOS with bash 5 (D-15): `exec bash` from dash, socket singleton with stale-socket takeover, `/proc` identity check, all files in a private 0700 runtime directory, `install --local`, e2e on Linux CI, live on the Raspberry Pi 5 since 2026-11-13 (about 4 ms per tick). Findings: [ideation/2026-11-11-render-daemon-on-linux.md](ideation/2026-11-11-render-daemon-on-linux.md), plan: [plans/2026-11-11-2301-feat-linux-render-daemon-plan.md](plans/2026-11-11-2301-feat-linux-render-daemon-plan.md) | done in 0.15.0 |
| Built-in bitmap → glyph renderer for the mugshot: smooth sampling, chafa-style shape shortlist, glyph step per image capped by the terminal type, disk cache for the one-shot status line (D-3; [plan](plans/2026-11-11-1150-feat-builtin-glyph-renderer-plan.md)) | 0.14.0 |
| Glyph truth on the real terminal: `test-card` command, fallback ladder half → quadrant → sextant → wedge → octant, OKLab render-back score in `scripts/compare-faces.mjs` (D-8). Owner's check 11.11.2026: Windows Terminal draws every step, so it gets octants; the console host could not be started on the owner's PC and gets half blocks. On the Raspberry Pi 5 (LXTerminal, VTE 0.80.1) every step looked clean too. Noto Color Emoji was installed there for the emoji first, but fontconfig reported no installed font covering U+1FB00 (sextant), U+1FB3C (wedge) or U+1CD00 (octant), only the U+2580 block elements; so VTE most likely draws them itself (not confirmed against VTE's source). VTE gets wedges; octants for VTE 0.80+ would need that confirmed | 0.14.0 |
| chafa dropped (D-4). Owner's verdict 11.11.2026 from the side-by-side faces: the built-in conversion is better than chafa at the same step and than the set the bar used before. The one-shot cost is lower too: 62.8 vs 81.0 ms on ubuntu-latest, 98.2 vs 130.1 ms on macos-latest (median of 21). On a Raspberry Pi 5 the one-shot with the face from the disk cache costs 255–261 ms against 251 ms for the pre-rendered faces; the first conversion adds about 250 ms once per version | 0.14.0 |

## Won't do

| Item | Reason |
|---|---|
| Event-driven-only HUD, no refresh timer | The 1 s refresh is fixed (owner's decision); events supplement it |
| Raising or removing `refreshInterval` to fix Windows bash pile-up | Same; fix the cause instead (P-1, P-2) |
