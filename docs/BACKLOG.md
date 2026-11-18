# Backlog

The backlog moved to [GitHub Issues](https://github.com/99LevelsUp/claude-game-bar/issues) on 18.11.2026. Open a new proposal or idea there.

Labels: the area (`daemon`, `render`, `skins`, `chat`, `wc3`, `install`, `housekeeping`,
`performance`, `mugshot`, `legacy`), `bug` or `enhancement`, and the state when it is not plain open
work: `idea` (not decided), `blocked` (waiting on something outside the project), `needs-decision`
(waiting on the owner). A pull request that finishes an issue closes it with `Fixes #<number>`.

## Old backlog IDs

Plans, ideation documents and the changelog cite the old IDs. This table says where each one went.

| ID | Now |
|---|---|
| D-2 | [#27](https://github.com/99LevelsUp/claude-game-bar/issues/27) |
| D-5 | [#28](https://github.com/99LevelsUp/claude-game-bar/issues/28) |
| D-6 | [#29](https://github.com/99LevelsUp/claude-game-bar/issues/29) |
| D-7 | [#30](https://github.com/99LevelsUp/claude-game-bar/issues/30) |
| D-9 | [#31](https://github.com/99LevelsUp/claude-game-bar/issues/31) |
| D-10 | [#32](https://github.com/99LevelsUp/claude-game-bar/issues/32) |
| D-11 | done with D-1 |
| D-12 | [#33](https://github.com/99LevelsUp/claude-game-bar/issues/33) |
| D-13 | [#34](https://github.com/99LevelsUp/claude-game-bar/issues/34) |
| D-14 | [#35](https://github.com/99LevelsUp/claude-game-bar/issues/35) |
| D-16 | done in 2.0.0 |
| D-17 | [#36](https://github.com/99LevelsUp/claude-game-bar/issues/36) |
| D-18 | [#37](https://github.com/99LevelsUp/claude-game-bar/issues/37) |
| D-19 | [#38](https://github.com/99LevelsUp/claude-game-bar/issues/38) |
| L-D | [#39](https://github.com/99LevelsUp/claude-game-bar/issues/39) |
| L-A | [#40](https://github.com/99LevelsUp/claude-game-bar/issues/40) |
| L-H | [#41](https://github.com/99LevelsUp/claude-game-bar/issues/41) |
| L-I | [#42](https://github.com/99LevelsUp/claude-game-bar/issues/42) |
| L-J | [#43](https://github.com/99LevelsUp/claude-game-bar/issues/43) |
| R-9 | [#44](https://github.com/99LevelsUp/claude-game-bar/issues/44) |
| R-10 | [#45](https://github.com/99LevelsUp/claude-game-bar/issues/45) |
| G-2 | done with R-8 (PR #10) |
| G-3 | done in 2.0.0 |
| G-4 | done in 2.0.0 |
| G-5 | done in 2.0.0 |
| G-6 | [#46](https://github.com/99LevelsUp/claude-game-bar/issues/46) |
| G-7 | done in 2.0.0 |
| G-8 | [#47](https://github.com/99LevelsUp/claude-game-bar/issues/47) |
| G-10 | done in 2.0.0 |
| G-9 | [#48](https://github.com/99LevelsUp/claude-game-bar/issues/48) |
| G-11 | [#49](https://github.com/99LevelsUp/claude-game-bar/issues/49) |
| P-1 | [#50](https://github.com/99LevelsUp/claude-game-bar/issues/50) |
| P-2 | done with D-1 (the daemon renders every session) |
| P-3 | [#51](https://github.com/99LevelsUp/claude-game-bar/issues/51) |
| P-6 | [#52](https://github.com/99LevelsUp/claude-game-bar/issues/52) |
| P-4 | [#53](https://github.com/99LevelsUp/claude-game-bar/issues/53) |
| H-A | [#54](https://github.com/99LevelsUp/claude-game-bar/issues/54) |
| H-B | [#55](https://github.com/99LevelsUp/claude-game-bar/issues/55) |
| H-C | [#56](https://github.com/99LevelsUp/claude-game-bar/issues/56) |
| F-1 | [#57](https://github.com/99LevelsUp/claude-game-bar/issues/57) |
| F-2 | [#58](https://github.com/99LevelsUp/claude-game-bar/issues/58) |
| F-3 | [#59](https://github.com/99LevelsUp/claude-game-bar/issues/59) |
| F-4 | [#60](https://github.com/99LevelsUp/claude-game-bar/issues/60) |
| S-1 | [#61](https://github.com/99LevelsUp/claude-game-bar/issues/61) |
| S-2 | [#62](https://github.com/99LevelsUp/claude-game-bar/issues/62) |
| S-3 | done in 2.0.0 |
| S-5 | [#64](https://github.com/99LevelsUp/claude-game-bar/issues/64) |
| S-4 | [#63](https://github.com/99LevelsUp/claude-game-bar/issues/63) |
| S-6 | done in 2.0.0 |
| S-7 | [#65](https://github.com/99LevelsUp/claude-game-bar/issues/65) |
| S-8 | done in 2.0.0 |

The IDs before these (D-1, D-3, D-4, D-8, D-15, R-0 to R-8, L-B, L-C, L-E to L-G, G-1, P-5, H-D) are in *Done*.

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
| Rename to `claude-game-bar` and restructure (R-0 to R-8): the npm trusted publisher for `claude-game-bar`, the last `claude-doom-statusbar` release 0.16.0 with a move row, and every old version deprecated with the move message (R-3); the contributor agreed (R-0); the test runner that runs every file (R-5); `src/` split into `platform/`, `metrics/`, `kit/` and `games/<game>/` with stable entry paths (R-6); a game-neutral reaction between the metrics and the games (R-2); a render context per session (R-7); the game registry, with presets and images under their game (R-8); package, command (`claude-game-bar` only), repository, `GAMEBAR_*` settings with `DOOMBAR_*` fallbacks, theme file, file prefixes and client renamed (R-1); `install` takes over an old installation in place and removes the old global package (R-4). Plan: [plans/2026-11-13-1359-refactor-claude-game-bar-1-0-plan.md](plans/2026-11-13-1359-refactor-claude-game-bar-1-0-plan.md) | 1.0.0 |
| chafa dropped (D-4). Owner's verdict 11.11.2026 from the side-by-side faces: the built-in conversion is better than chafa at the same step and than the set the bar used before. The one-shot cost is lower too: 62.8 vs 81.0 ms on ubuntu-latest, 98.2 vs 130.1 ms on macos-latest (median of 21). On a Raspberry Pi 5 the one-shot with the face from the disk cache costs 255–261 ms against 251 ms for the pre-rendered faces; the first conversion adds about 250 ms once per version | 0.14.0 |
| Games as skins: a skin is a tree of shared elements described as data, scripts, asset packages on demand, height-aware smaller skins (G-3, G-4, G-5, G-7, G-10); hooks of a second installation step aside (D-16); missing preset warning (S-6); a stale comment (S-3); per-session savings settings (S-8) | 2.0.0 |

## Won't do

| Item | Reason |
|---|---|
| Event-driven-only HUD, no refresh timer | The 1 s refresh is fixed (owner's decision); events supplement it |
| Raising or removing `refreshInterval` to fix Windows bash pile-up | Same; fix the cause instead (P-1, P-2) |
