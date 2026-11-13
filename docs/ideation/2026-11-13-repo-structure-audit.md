# Repository structure audit before `claude-game-bar` 1.0.0

**Date:** 2026-11-13, at 0.15.0 (`f0f6c13`)
**Trigger:** the owner's decision of 2026-11-13:
- The project is renamed to `claude-game-bar` on GitHub and npm, together with version 1.0.0. The contributor has agreed to the rename (R-0).
- The bar becomes a general platform. It collects data from Claude Code and shows it through a bar.
- It has one general rendering part and game-specific parts: DOOM, Minecraft, and Warcraft III next.

**Builds on:** [2026-10-31-shared-game-layout-engine.md](2026-10-31-shared-game-layout-engine.md), which covers the rename inventory, the three-layer proposal and the HUD kit. That document was written at 0.13.0, before the render daemon, the bash client, the frame contract and the glyph renderer existed. This audit maps today's tree onto it.

## 1. What each file does today

| File | Lines | What it holds | Layers mixed in it |
|---|---:|---|---|
| `bin/cli.js` | 420 | CLI: install / uninstall (settings, bash detection, client command, daemon stop), theme, test-card | CLI + installer + platform |
| `src/hook.js` | 673 | event recorder (journal), git / MSYS snapshots, MSYS shell reaper, daemon supervision (claims, identity, restart), state sweep, session end | six jobs, one file |
| `src/fold.js` | 309 | runtime directory and file paths, socket / pipe, process identity, `writeAtomic`, **and** the event reducer (`foldEvent`, `foldActivity`) | platform + engine state |
| `src/statusline.js` | 854 | metric engine (`buildValues`, `activityValues`, `sysValues`, savings, rate limits, disk tasks, advisor), DOOM sprite mapping (`spriteFor`), layout dispatch (`if layout === "hotbar"`), preset loading, one-shot entry, reaper trigger | engine + DOOM + dispatch + entry |
| `src/render.js` | 749 | kit primitives (`vlen`, `marquee`, bars, icons, spark, equalizer, colour), the width planner and fallback (`planLayout`, `resolvePreset`), **and** the DOOM box layout (`buildBar`, complexity 94); default sprite `STFST…`; module-level `VALUES` | kit + DOOM |
| `src/face.js` | 120 | DOOM mugshot: sprite → PNG → glyphs, disk cache; module-level options | DOOM portrait |
| `src/glyphs.js`, `glyph-level.js`, `glyph-render.js`, `png.js` | 438 | generic bitmap → terminal glyph raster, glyph step per terminal | kit (clean, no DOOM names) |
| `src/hotbar.js` | 234 | Minecraft layout; its own `fit()`, gauge cells, selection; reads the reaction back out of DOOM sprite names (`spriteExpr`) | Minecraft + duplicated kit |
| `src/chat.js` | 256 | Minecraft chat script, cast, facts | Minecraft |
| `src/theme.js` | 49 | hard-coded `THEMES` table, theme file | registry |
| `src/daemon.js` | 278 | render daemon | platform |
| `src/frame.js` | 171 | frame contract between daemon and client | platform |
| `src/doombar-client.sh` | 177 | bash client | platform |
| `src/emoji-font.js` | 93 | Linux emoji font installer | installer |
| `src/ansi.js` | 17 | SGR helpers | kit |
| `presets/*.toml` | 4 files | DOOM `full` / `standard` / `minimal` and `minecraft`, flat | per game, but flat |
| `assets/images/mugshot/` | 84 files | DOOM sprites | DOOM, but top level |
| `tools/fix-msys.cmd` | 75 | Windows Git Bash repair (`rebaseall`) | Windows support |
| `scripts/*.mjs` | 4 | measurements, face comparison | dev tools |
| `test/` | 41 files | one flat directory; `npm test` is one `&&` chain | — |
| `docs/` | 6 dirs | `ideation`, `plans`, `brainstorms`, plus legacy `superpowers/`, `port/` | — |

## 2. Findings

- **S1. No layer has its own place.** The three layers of the 10-31 proposal (engine, kit, games) are spread across `statusline.js`, `render.js`, `hotbar.js` and `fold.js`. Adding a game today means:
  - editing `statusline.js` (dispatch),
  - `theme.js` (the table),
  - `presets/` (a flat file),
  - and a new top-level module.
- **S2. The reaction channel speaks DOOM.** `spriteFor()` in `statusline.js` returns `STFOUCH2`, `STFGOD0`, `STFDEAD0`. `hotbar.js spriteExpr()` parses the reaction back out of those names. `render.js` defaults to `STFST…`. A Warcraft III portrait would have to speak DOOM sprite names. A neutral state `{ expr, hp, god, dead }` is needed, and only the DOOM portrait should map it to `STF*`.
- **S3. Render state lives in module variables.** `render.js` holds `let VALUES` with `setValues()`, and `face.js` holds `_opts` with `setFaceOptions()`. This was harmless for a one-shot process. The daemon renders many sessions in one process, so correctness depends on call order ("no other session's render may come between", `statusline.js` comment). An explicit render context passed to the layout removes the hazard.
- **S4. `hook.js` and `fold.js` each do too much.** `hook.js` records events, supervises the daemon, reaps shells, sweeps state and ends sessions. `fold.js` mixes paths, sockets and process identity with the reducer. The daemon work added most of this, and it is the code that kills processes, so it should be easy to read in isolation.
- **S5. Duplicated kit in the Minecraft layout.** This is known from 10-31 (G-4, G-5):
  - `hotbar.js fit()` clips by code point and can break SGR and OSC-8;
  - `glyphCells` duplicates `rIcons`;
  - the hotbar bypasses the width planner and `[bar].fallback`.
  The move does not fix this; it makes it visible: `kit/` versus `games/minecraft/`.
- **S6. Naming has grown since 10-31.**
  - **36 `DOOMBAR_*` environment variables**, up from 17, plus `MUGSHOT_STATE`.
  - **File prefixes:** `mugshot_*` (journal, checkpoint, payload, frame, daemon, claim, CPU, rate limits) and `doombar_faces_*` (face cache).
  - **The client is named `doombar-client.sh`.**
  - The sweep and uninstall recognise the bar's files by these prefixes, so a rename must keep recognising the old ones.
- **S7. Entry points are public wiring.** Installed settings name the files directly:
  - Claude Code settings name `src/hook.js` (hooks, exec form) and `src/statusline.js` or `src/doombar-client.sh` (statusLine);
  - the daemon identity check expects `src/daemon.js`;
  - the installer recognises its own entries by the path suffixes `src/hook.js` and `src/statusline.js`.
  Moving these files breaks every live installation until `install` runs again: the Pi, this repo's `settings.local.json`, and npm users.
- **S8. `npm test` stops at the first failing file.** It is one long `&&` chain, so the files after a failure never run (the Pi hit this on 13.11). A runner that runs every file and prints a summary is cheap and also gives one place for "run this one alone" (`daemon-e2e`).
- **S9. Docs.**
  - `superpowers/` and `port/` are leftovers of earlier tooling.
  - README is DOOM-first (title, intro), and its theme section explains Minecraft as an add-on.
  - `RELEASING.md` duplicated the release recipe and went stale with the protected-master flow; fixed in PR #3.
- **S10. Housekeeping.** Remote branches `feat/glyph-renderer` and `feat/linux-render-daemon` are merged and can go. The contributor has no open branch or PR (checked 13.11), so now is a good moment for a tree-wide move.

## 3. Target structure

The rule: **entry points keep their paths** (S7), and everything behind them moves into the layer it belongs to.

```
bin/cli.js                    claude-game-bar CLI (old bin name kept as an alias)
src/
  hook.js                     ENTRY (stable path): parses the event, calls platform/*
  statusline.js               ENTRY (stable path): one-shot render = render.js + stdout
  daemon.js                   ENTRY (stable path): the render daemon
  gamebar-client.sh           ENTRY: bash client (doombar-client.sh stays as a one-line shim)
  render.js                   renderSession(data, env, now) -> lines: metrics -> game -> layout
  platform/                   Claude Code and the OS; no game knowledge
    runtime.js                runtime dir, paths, writeAtomic, rootHash, socket address
    journal.js                event journal and reducer (foldEvent, foldActivity, foldBatch)
    supervise.js              daemon health, claims, identity, restart (from hook.js)
    sweep.js                  stale state, session end (from hook.js)
    reap.js                   Windows shell reaper (from hook.js and statusline.js)
    snapshots.js              git / MSYS snapshots (from hook.js)
    frame.js                  frame contract
  install/                    installer parts used by bin/cli.js
    settings.js               read / merge / write Claude Code settings, entry detection
    shell.js                  bash detection, client command
    emoji-font.js
  metrics/                    Claude data -> VALUES, game-neutral
    index.js                  collect({ data, env, now }) -> { values, reaction }
    session.js                model, context, cost, project, git (buildValues), advisor
    activity.js               tools, subagents, tasks (activityValues, disk tasks)
    system.js                 CPU, RAM, clock
    savings.js                lean-ctx, LLMLingua
    ratelimits.js             sharing, headroom, rate health
    reaction.js               neutral { expr, hp, god, dead } (from spriteFor)
  kit/                        primitives every game uses
    ansi.js
    text.js                   vlen, escape-safe fit, marquee, links
    meters.js                 bar, ammo, gauge (rIcons), spark, equalizer, colour stops
    planner.js                planLayout, resolvePreset, fallback chain
    raster/                   glyphs, glyph-level, glyph-render, png
  games/
    index.js                  registry: name -> { about, layout, presets }; replaces theme.js THEMES
    doom/
      layout.js               the box layout (buildBar's DOOM part)
      portrait.js             face.js + reaction -> STF sprite
      presets/                full, standard, minimal
      assets/mugshot/
    minecraft/
      layout.js               hotbar.js
      chat.js
      presets/                minecraft
test/                         split by layer (platform/, metrics/, kit/, games/); one runner
scripts/                      dev tools, plus run-tests.mjs
tools/fix-msys.cmd            unchanged
docs/                         ideation/, plans/, brainstorms/; superpowers/ and port/ go to docs/archive/
```

Warcraft III then adds `games/warcraft3/` (layout, presets, its own chrome) and one registry line. It reuses `kit/` and the neutral reaction.

## 4. What becomes public API at 1.0.0

After 1.0.0, a change to any of these needs a major version:
- the CLI commands and flags;
- the `GAMEBAR_*` environment variables;
- the preset TOML schema;
- the theme names;
- the entry paths that installed settings point at (`src/hook.js`, `src/statusline.js`, `src/daemon.js`, the client).

Internal and free to change:
- the frame contract (daemon and client ship together);
- the file names in the runtime directory;
- everything under `platform/`, `metrics/`, `kit/` and `games/`.

## 5. Migration hazards

| Hazard | Guard |
|---|---|
| Moving the entry files breaks every live installation | Entry paths stay (section 3); the old client name stays as a shim for 1.x |
| The installer stops recognising old entries and registers the hooks twice | Keep detecting the old path suffixes and the old package path |
| Old `mugshot_*` / `doombar_faces_*` files are never swept or uninstalled | Sweep and uninstall recognise old and new prefixes for 1.x |
| `DOOMBAR_*` set in users' settings stop working | One `env()` helper reads `GAMEBAR_x`, then `DOOMBAR_x`; `install` rewrites the names in settings |
| `~/.claude/doombar-theme.json` is ignored | Read it when the new file is missing; `theme` writes the new one |
| A pull of master turns the live bar offline mid-change (Pi, this repo) | Work in a worktree; each merged step keeps the entry paths and stays green on the snapshot tests |
| The local directory rename changes the auto-memory slug, `settings.local.json` paths and `rootHash` | Rename on GitHub only (it redirects the old URL). The local directory is a separate, explicit step |
| npm trusted publishing is configured per package | The first `claude-game-bar` publish needs the owner on npmjs.com (see decisions) |
| History lost in moves | `git mv` in commits of their own, separate from edits |

## 6. Phasing (each step one pull request, output-neutral where stated)

1. **Test runner.** `scripts/run-tests.mjs` runs every file, prints a summary and keeps `daemon-e2e` separate. Output-neutral.
2. **Move files** into the target tree with `git mv`, entry paths kept, imports fixed. Output-neutral (snapshots).
3. **Split the big files.**
   - `statusline.js` goes to `metrics/*` and `render.js`.
   - `fold.js` goes to `platform/runtime.js` and `platform/journal.js`.
   - `hook.js` goes to `platform/supervise.js`, `sweep.js`, `reap.js` and `snapshots.js`.
   - `render.js` goes to `kit/*` and `games/doom/layout.js`.
   Output-neutral.
4. **Neutral reaction state.** The DOOM portrait maps it to `STF*`, the hotbar reads `expr` directly, and the kit loses its sprite default. Output-neutral.
5. **Render context.** The module-level `VALUES` and face options are replaced by a context passed in. Output-neutral.
6. **Game registry.** `games/index.js` replaces `THEMES`, presets and assets move under their game, and the layout comes from the registry instead of `if`.
7. **Rename.**
   - Package name, bin alias, `GAMEBAR_*` with fallback, theme file, file prefixes (old ones recognised), client name.
   - README and CLAUDE.md made game-neutral.
   - The GitHub repository renamed.
8. **Release 1.0.0** as `claude-game-bar`. Then one last `claude-doom-statusbar` release with a notice and `npm deprecate`.

Not in 1.0.0: merging the hotbar into the shared planner (G-4, G-5), chat as data (G-6, G-7), the user preset overlay (G-3), and Warcraft III (G-8, D-5). These come in 1.x, on top of the new tree.

## 7. Decisions (owner, 2026-11-13)

| # | Question | Decision |
|---|---|---|
| 1 | What 1.0.0 contains | Steps 1–8: structure, neutral reaction, render context, registry, rename. No new game, no behaviour change |
| 2 | How long the `DOOMBAR_*`, old prefix, old theme file and old client fallbacks last | **A few 1.x releases**, not all of 1.x. The release that removes them says so in the changelog. Removing a fallback breaks old settings, so that release names it as a breaking change, even though it is a minor version |
| 3 | Local directory `claude-doom-statusbar` | **Renamed with 1.0.0**, at the end of step 7. It needs: the explicit re-wiring of this repo's `settings.local.json`, a move of the auto-memory directory, and the Pi's clone renamed with its global settings re-wired. The Pi's settings change only with the owner's OK |
| 4 | First publish of `claude-game-bar` on npm | The owner sets up the package on npmjs.com (trusted publisher, possibly one manual publish); CI publishes after that |
| 5 | The old package | A final 0.16.0 that prints "renamed to claude-game-bar", then `npm deprecate` |
