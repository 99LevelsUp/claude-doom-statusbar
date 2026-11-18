# claude-game-bar

A status bar for the Claude Code CLI that draws the session as a game HUD (DOOM, Minecraft).

## Language

All written artifacts in this project must be in **English only**: code, comments, documentation, commit messages, ideation docs, README.

Spoken communication with the user is in Czech.

## Project Overview

A platform plus game data. The platform reads the Claude Code session (usage, rate limits, model, project, agents, tasks, system), turns it into raw metric values and a game-neutral reaction, and draws a skin through a render daemon and a bash client. A skin is a TOML tree of shared elements (containers and metric visuals); a game is only a folder of data: a manifest, skins, and assets published as its own npm package. Nothing in the platform knows about a particular game; games are reached only through the registry.

Layers under `src/`:
- entry files with stable paths: `hook.js`, `statusline.js`, `daemon.js`, `gamebar-client.sh` (and the shim `doombar-client.sh`), plus `render-core.js` (the shared render), `render.js` (`renderSession`, the render with skin scripts), `skin-select.js` (which skin a session draws), `skin-assets.js`, `theme.js` and `package-root.js`;
- `platform/`: runtime directory and file names, settings from the environment (`GAMEBAR_*` with `DOOMBAR_*` fallbacks), journal, daemon supervision, sweep, reaper, git and MSYS snapshots, the frame file, the asset store (`assets.js`) and the script worker (`scripts/`);
- `metrics/`: the metric catalogue, raw metric values and the game-neutral reaction;
- `kit/`: drawing primitives, the elements (`elements/`), the skin loader, fit, draw and script pass (`skin/`), the chat's metrics library, colours and the glyph raster;
- `install/`: settings, the statusLine command, daemons, the old package, the emoji font;
- `games/`: the registry (`games/index.js`) and one data folder per game (`game.toml` and `skins/*.toml`):
  - `doom/`: skins `doom-full`, `doom-standard`, `doom-minimal`, and the low `doom-compact` and `doom-line`;
  - `minecraft/`: skins `minecraft` and the low `minecraft-compact`.

Game assets (images, scripts, conversation libraries) live in `packages/<game>/`, the source of the npm package `@claude-game-bar/<game>`, pinned by version and integrity in the game's manifest.

`bin/cli.js` is the `claude-game-bar` command. `CONTRIBUTING.md` describes how to add a game, the skin format and the skin script interface.

The DOOM game's mapping: usage headroom is the mugshot's health, the 5h and 7d rate limits and the context window are bars, and the reaction is the face. The Minecraft game's mapping: the 5h rate limit is the hearts, context is hunger, the 7d rate limit is the XP bar, and the rest is a 9-slot hotbar.

The bar started as a DOOM HUD; `docs/ideation/2026-06-06-doom-statusbar-ideation.md` is that original ideation.

## Auto-learned Rules

<!-- claude-evolve:managed-start -->

<!-- claude-evolve:rule id=r_mqta7jwe_wfeg score=5.2 created=2026-06-25 source=observation complexity=simple -->
- When investigating an unknown JSON schema for a live tool (statusLine, hooks, etc.), grep the codebase first to find all current field references, then fetch the official docs URL, then read any cached tool-result files — in that order — before writing any diagnostic helper script.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqta7jxz_b7vx score=5.1 created=2026-06-25 source=observation complexity=simple -->
- After writing any script that touches settings.json (statusLine, hooks), immediately verify with a node -e inline script that reads settings.json and confirms the critical field is still intact and unchanged.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqtcaklb_ii66 score=5.4 created=2026-06-25 source=observation complexity=simple -->
- When committing a feature that replaces a calculation model, include the new test file in the same atomic commit alongside the changed source files
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqtcmu5g_jkjq score=5 created=2026-06-25 source=observation complexity=simple -->
- When cutting a new minor/patch release, commit CHANGELOG.md first as a separate commit, then run `npm version` — never bundle changelog edits into the version bump commit
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqtcmu5m_3cac score=5 created=2026-06-25 source=observation complexity=simple -->
- After `npm version` push and CI publish, verify the deployed version both via `gh run watch` (CI outcome) and `npm view <pkg> version` (registry truth) in the same command chain
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqtcmu5u_puei score=5 created=2026-06-25 source=observation complexity=simple -->
- When updating a persistent memory file about a model or algorithm (e.g. health model), also update the MEMORY.md index entry in the same session so the index stays in sync
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqtcmu62_as6s score=5 created=2026-06-25 source=anti_pattern complexity=simple -->
- Do not Read the same file twice in the same turn without an intervening mutation — deduplicate reads before editing
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mw96591p_zul3 score=5.9 created=2026-11-09 source=observation complexity=simple -->
- After writing a new ideation doc, register it in docs/BACKLOG.md with a section that links to the source doc, and cross-reference related existing backlog items (e.g. G-8 -> D-5) in the same session, then commit both files together.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mwbrxmgz_nu1v score=5.1 created=2026-11-11 source=observation complexity=simple -->
- When diagnosing a hung process, first list the relevant processes (PID, parent, start time, CPU), then dump their stacks with py-spy and read the library source at the frames that block, before writing any analysis.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mwbrxmio_yz5v score=5.1 created=2026-11-11 source=observation complexity=simple -->
- After an investigation that finds an open (unfixed) problem, record it in every vault location that tracks that area: a dated analysis draft, RESTORE.md, and STATE.md with an updated 'updated:' date. Mark the problem as 'neopraveno'.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:managed-end -->
