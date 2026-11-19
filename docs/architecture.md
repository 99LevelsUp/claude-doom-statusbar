# Architecture

How claude-game-bar turns a Claude Code session into a game HUD. This is the map for contributors;
the user-facing behaviour is in the [README](../README.md), the skin format, the script interface
and the release steps are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## The idea in one paragraph

The bar has one general part, the **platform**, and **games** that are only data. The platform reads
the session, turns it into metric values and a game-neutral reaction, and draws a **skin**: a tree of
shared elements described in TOML. A game brings a manifest, its skins and an npm package of assets
(images, scripts, conversation libraries). Nothing in the platform names a game; it finds games
through the registry, and `test/games/general-part.test.mjs` fails when a game's name appears in
`src/` outside `src/games/` or in `bin/`.

```mermaid
flowchart LR
  CC[Claude Code] -- session JSON every 1 s --> client[bash client<br/>src/gamebar-client.sh]
  CC -- lifecycle events --> hook[hooks<br/>src/hook.js]
  client -- payload --> daemon[render daemon<br/>src/daemon.js]
  daemon -- frame --> client
  hook -- journal, git snapshot --> state[(runtime directory)]
  state --> daemon
  hook -- start / restart --> daemon
  daemon --> render[render<br/>src/render.js]
  render --> metrics[metrics and reaction<br/>src/metrics/]
  render --> skin[skin: load, fit, scripts, draw<br/>src/kit/skin/]
  skin --> elements[elements<br/>src/kit/elements/]
  skin --> scripts[script worker<br/>src/platform/scripts/]
  skin --> assets[asset store<br/>src/platform/assets.js]
  games[games: manifests and skins<br/>src/games/] --> skin
  packages[asset packages<br/>@claude-game-bar/&lt;game&gt;] --> assets
```

## Repository layout

```
bin/cli.js            the claude-game-bar command: install, uninstall, skin, test-card
src/                  the platform, and the game data that ships with it
  statusline.js       the one-shot statusLine command (no daemon, no scripts)
  gamebar-client.sh   the bash client the statusLine runs where bash 5 or Git Bash exists
  daemon.js           the render daemon, one per installation
  hook.js             the hook entry: event journal, git snapshot, daemon supervision, sweeps
  render-core.js      the render the one-shot command and the daemon share
  render.js           renderSession: the render with the skin's scripts, for the daemon
  skin-select.js      which skin a session draws
  skin-assets.js      the assets a skin needs, for install and `skin <name>`
  theme.js            the older theme choice, kept for setups from before skins
  package-root.js     the package root every path and the install hash come from
  platform/           runtime directory, env settings, journal, frame file, daemon supervision,
                      sweep, reaper, git and MSYS snapshots, the asset store, the script worker
  metrics/            the metric catalogue, metric values, the game-neutral reaction
  kit/                drawing: elements, skin loader/fit/draw/script pass, chat library,
                      colours, the glyph raster
  install/            settings, the statusLine command, daemons, the old package, the emoji font
  games/              the registry (index.js) and one data folder per game:
    <game>/game.toml  the manifest
    <game>/skins/     the game's bundled skins
packages/<game>/      the npm package @claude-game-bar/<game>: images, scripts, conversations
                      (not part of the main package; see packages/README.md)
test/                 one runner (scripts/run-tests.mjs) for every *.test.mjs; e2e on its own
scripts/              development tools: the test runner, face comparison, cost measurements
tools/                user-facing helpers shipped with the package (fix-msys.cmd)
docs/                 this file, plans, ideation, the old backlog's ID map
```

## One tick

Claude Code runs the `statusLine` command about once a second and pipes the session JSON into it.

1. **The client** (`src/gamebar-client.sh`) uses bash builtins only and starts no process. It
   writes the session's payload for the daemon and prints the frame the daemon last rendered for
   this session, greyed with `OFFLINE` when the frame is past its deadline.
2. **The daemon** (`src/daemon.js`) renders every active session of its installation, renews each
   frame's deadline about twice a second, runs at below-normal priority and exits after
   `GAMEBAR_DAEMON_IDLE_MS` with no active session, or when its own source files change; in that
   case, while a session still uses the bar, it starts its successor from the new source itself.
3. **The render** (`src/render-core.js`, with scripts through `src/render.js`):
   1. picks the session's skin (`src/skin-select.js`): the session's `GAMEBAR_SKIN`, the saved
      choice, the older theme, or the default game's default skin;
   2. builds the metric values (`src/metrics/`) from the payload, the hook's journal and git
      snapshot, and system metrics from Node built-ins, with the rate limits pooled across the
      sessions of one Claude account (`src/metrics/ratelimits.js`, the account from
      `src/platform/account.js`); and the game-neutral **reaction**
      (`src/metrics/reaction.js`): what just happened, how long ago, how hurt the player is;
   3. loads the skin (`src/kit/skin/load.js`), skipping and reporting any part that does not hold;
   4. fits it (`src/kit/skin/fit.js`) to the terminal's width and to a third of its rows: elements
      shrink to their minimums, then drop by priority, then the skin gives way to its `smaller`
      skin;
   5. runs the scripts (`src/kit/skin/scripts.js`) of the elements that stay, all of a session's in
      one batch;
   6. draws (`src/kit/skin/draw.js`) each element by its descriptor at the width the fit gave it,
      and adds the warning line under the bar when something needs the user's attention.

Where no suitable bash exists (macOS with its own bash 3.2, Windows without Git Bash) the
`statusLine` is the **one-shot** renderer `node src/statusline.js`: the same render without the
daemon and without scripts, so an animation shows its default frame and a chat plays only the
platform's conversations.

### The client per platform

- **Windows with Git Bash**: the installer writes
  `GAMEBAR_ROOT_HASH=<install hash>; f="<package>/src/gamebar-client.sh"; if [ -r "$f" ]; then . "$f"; else echo 'gamebar: offline'; fi`,
  which sources the client into the bash Claude Code already starts for each tick. The daemon is a
  single instance through the named pipe `\\.\pipe\gamebar-<install hash>`.
- **Linux and macOS with bash 5**: Claude Code runs the statusLine through `/bin/sh` (dash on
  Debian), so the installer writes
  `b='<bash>'; f='<package>/src/gamebar-client.sh'; if [ -r "$f" ] && [ -x "$b" ]; then unset BASH_ENV; exec "$b" --norc --noprofile "$f" <install hash>; else echo 'gamebar: offline'; fi`.
  A tick costs about as much as starting bash: 3 ms on a GitHub Actions Linux runner, against 40 ms
  there for the one-shot renderer (about 250 ms on a Raspberry Pi 5). The daemon is a single
  instance through the socket file `gamebar_daemon_<install hash>.sock` in the runtime directory; a
  socket left by a daemon that was killed is taken over by the next one.
- The one-shot command keeps working where the client is used, so sessions opened before an upgrade
  keep their bar until Claude Code restarts them. Upgrading the package in place updates the client
  without touching `settings.json`.

The runtime directory, the daemon's heartbeat and the per-session files are described in the
README under [Where the files live](../README.md#where-the-files-live) and
[Troubleshooting the daemon](../README.md#troubleshooting-the-daemon).

## Hooks

`src/hook.js` is an append-only event recorder, wired to Claude Code's lifecycle hooks (all in exec
form). It appends each event to the session's journal, and the render folds the journal into the
session state (`src/platform/journal.js`): the last expression with its decay, tool-run intervals
for the activity geiger, the running subagents, the tasks, the error count. Neither side waits for
the other. The hook also:

- takes the git snapshot, so the render path never starts a child process;
- supervises the daemon: starts a missing one, replaces one that stayed hung or outdated past the
  grace period, at most once per throttle window, and leaves a daemon alone while the machine is
  too busy to tell starved from hung (`src/platform/supervise.js`);
- deletes a session's files at `SessionEnd`, and at `SessionStart` sweeps what sessions that ended
  without it left behind (`src/platform/sweep.js`);
- on Windows, reaps hung Git Bash statusLine wrappers (`src/platform/reap.js`; see the README's
  Windows section for why).

When two installations are wired (a global install and a checkout with `install --local`), the
hooks of the installation that does not draw the session step aside, so each event is counted once.

## Skins and elements

A skin is one TOML file: a tree of elements, each a table with a `kind`.

- **Containers** lay children out: `row`, `column`, and the frames `box` (title, background) and
  `grid` (lines between cells, one cell selectable). They decide what happens when they have nothing
  to show (`when_empty`) and how spare width is shared (`grow`).
- **Metric elements** bind one metric from the catalogue (`src/metrics/catalogue.js`) and draw it
  with a visual: `text`, `number`, `progress`, `sparkline`, `equalizer`, `icon`, `icon-row`,
  `scroll-list`, `chat`, `animation` and `animation-3d` (a placeholder until there is a model
  renderer).

Each kind is a descriptor in `src/kit/elements/` that lists its parameters (meaning, type, default,
allowed values) and says how wide it can be drawn. The loader checks a skin against these
descriptors; the fit and the draw call them. A new kind of element, such as a minimap, is platform
work there, and every game can use it.

Bundled skins live in `src/games/<game>/skins/`; a user's own skins in
`~/.claude/claude-game-bar/skins/<name>/`. A skin may use the assets of any game. Its `smaller`
names the skin to fall back to when it does not fit, which makes the chains
`doom-full` → `doom-standard` → `doom-minimal` → `doom-compact` → `doom-line` and
`minecraft` → `minecraft-compact`.

## Scripts

Any element can name a script that changes how it looks each render (the mugshot's frame, the
hotbar's selected slot); a `chat` can name conversation libraries. Scripts run only in the daemon,
in one worker thread (`src/platform/scripts/`) with a 64 MB heap: each call has 20 ms, a render pass
has 200 ms for all sessions, a script that throws is off until its file changes and one that runs
late is off for a growing cooldown. A script never changes an element's size. Scripts are trusted
code from the user's skin folders and the installed game packages; the context keeps timers,
`require` and `eval` out of reach but is not a security boundary. The interface is in
CONTRIBUTING.md, *Skin scripts*.

## Game assets

A skin names an asset as `<game>:<path>`. The asset store (`src/platform/assets.js`) resolves it:

1. in a checkout of the repository, from `packages/<game>/`;
2. otherwise from `~/.claude/claude-game-bar/assets/<game>@<version>/`, the one version of
   `@claude-game-bar/<game>` that the game's manifest pins by version and integrity.

A missing pinned package is installed in the background (`npm install --ignore-scripts` with
constant arguments, under a lock, checked against the pinned integrity before it is used); until
then the element draws its default and the warning line names the package. `install` removes
packages no skin used for 30 days. The packages are published from `master` by
`.github/workflows/publish-assets.yml`.

## Glyphs

Images are converted to block glyphs inside the bar (`src/kit/raster/`): a PNG decoder, a
shape-matching renderer and a cache (in memory, and on disk for the one-shot command). The glyph
step (half, quadrant, sextant, wedge, octant) comes from the terminal's identity
(`src/kit/raster/glyph-level.js`), capped per image by the element's `glyphs` parameter.
`claude-game-bar test-card` shows which steps a terminal really draws.

## Where the design came from

- `docs/plans/`: the plans of the larger changes, newest last; each starts with its status.
  `2026-11-16-1247-feat-game-as-skin-plan.md` is the one behind this architecture.
- `docs/ideation/`: the explorations behind them; `2026-06-06-doom-statusbar-ideation.md` is the
  original idea of the bar.
- Open proposals and bugs: [GitHub Issues](https://github.com/99LevelsUp/claude-game-bar/issues).
  `docs/BACKLOG.md` maps the IDs of the old backlog (D-18, G-5, …) to issues.
