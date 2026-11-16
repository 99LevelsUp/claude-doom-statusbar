# Contributing to claude-game-bar

The repository is [99LevelsUp/claude-game-bar](https://github.com/99LevelsUp/claude-game-bar), and
the npm package and its command are both `claude-game-bar`. Settings from the environment are named
`GAMEBAR_*`; the code reads them through `src/platform/env.js`, which falls back to the `DOOMBAR_*`
names of releases before 1.0.0.

## Changes go through a pull request

`master` is protected: it cannot be force-pushed or deleted, and it takes changes only through a
pull request whose `test` and `e2e` checks (the `Test` workflow on Linux) have passed. No review
approval is required. This holds for everyone, including the repository owner.

1. Branch from an up-to-date `master`: `git switch master && git pull && git switch -c <type>/<topic>`
   (`feat/`, `fix/`, `docs/`, `chore/`, `release/`).
2. Commit as often as you like and push the branch: `git push -u origin <branch>`.
3. Open a pull request: `gh pr create --fill` (or `--draft` while it is in progress; the checks
   run on every push either way).
4. When `test` and `e2e` are green, merge with a merge commit: `gh pr merge --merge --delete-branch`.
   Merge commits keep the branch's commit hashes, which commit messages and PR descriptions
   refer to.
5. Update your local `master`: `git switch master && git pull`.

Run the tests locally before pushing: `npm test`, and `npm run test:e2e` on its own (it starts
real daemons and must not run alongside anything else).

## Adding a game

A game is data, scripts and assets. It brings no layout code: the bar is a tree of the platform's
shared elements (containers and metric visuals, `src/kit/elements/`), and a game's skins compose
that tree in TOML. A game that needs only the elements the platform has changes nothing outside its
two folders. A new kind of element, such as a minimap, is ordinary platform work in
`src/kit/elements/`.

```
src/games/<game>/
  game.toml          the manifest
  skins/*.toml       the game's bundled skins
games/<game>/assets/ the npm package @claude-game-bar/<game>: images, scripts, conversation
  package.json       libraries, in subfolders by kind
```

The registry, `src/games/index.js`, finds the game folders itself (sorted by name, the order
`skin next` cycles through). The rest of the code reaches a game only through it;
`test/games/general-part.test.mjs` fails when a game's name appears anywhere else in `src/` or
`bin/`.

The manifest, `game.toml` (the comment at the top of `src/games/index.js` lists every key):

- `name`, `description`: the game's name, which `skin <name>` also accepts, and the blurb in the
  skin list.
- `default`: true for the one game drawn when nothing is chosen. `default_skin`: the skin drawn
  when the game itself is chosen.
- `[legacy]`: what a release before skins saved. `aliases` are older theme names that still choose
  the game; `reads_presets` says whether the file name of `GAMEBAR_PRESET` picks the size;
  `presets` maps a preset file name (without `.toml`) to the skin of that size.
- `[assets]`: `package` (`@claude-game-bar/<game>`), `version` and `integrity`, the one version of
  the assets package the bar installs. `0.0.0` and an empty integrity pin nothing: the assets then
  come only from a checkout's `games/<game>/assets/`. See [Asset packages](#asset-packages).

`test/games/fixture-game/` is a working example of a game that is a folder and nothing else;
`test/games/registry.test.mjs` registers and draws it.

### Skins

A skin is one TOML file. The loader's header comment (`src/kit/skin/load.js`) is the reference;
in short:

- top level: `version` (1), `name` (the file name without `.toml` when absent), `games` (the games
  whose assets it uses), `root` (the id of the element the bar starts from) and `smaller` (the skin
  to switch to when this one does not fit even with elements dropped);
- one `[element.<id>]` table per element, with its `kind` and the settings every element shares:
  `metric` (a catalogue id from `src/metrics/catalogue.js`), `priority` (a whole number, lowest
  dropped first when the bar is too narrow; no priority or `"keep"` is never dropped on its own),
  `script`, `when_absent` (`"hide"`, `"empty"` or `"full"`: what a metric element does while the
  session does not report its metric), `children` (a container's) and `frame` (`{ kind = "box" |
  "grid", ... }` around a container);
- the rest of the table is the kind's own parameters, described by its descriptor in
  `src/kit/elements/` (name, meaning, type, default and allowed values of each).

Kinds: the containers `row` and `column`, the frames `box` and `grid`, and the visuals `text`,
`number`, `progress`, `sparkline`, `equalizer`, `icon`, `icon-row`, `scroll-list`, `chat`,
`animation` and `animation-3d`.

A part of a skin that does not hold (an unknown key, kind, metric or parameter, a missing child) is
skipped with one warning, shown as a dim line under the bar for 60 seconds, and the rest is drawn.

An asset reference is `<game>:<path>`, a path inside that game's assets package
(`doom:images/mugshot/STFST01.png`). A plain path is the skin's own: inside a user skin's folder,
or for a bundled skin inside its game folder `src/games/<game>/`. A reference naming an npm package
(`@scope/...`) is refused with a warning; the bar installs only the packages game manifests pin.

### Skin scripts

This interface is internal and may change between releases. Its reference is the header comment of
`src/kit/skin/scripts.js`, with the host's rules in `src/platform/scripts/host.js`.

Any element can name a `script`: the bar runs it before the element is drawn, and what it returns
changes how the element looks this render. An `animation` needs one to pick its frame; DOOM's
mugshot (`games/doom/assets/scripts/mugshot.js`) and Minecraft's hotbar highlight
(`games/minecraft/assets/scripts/hotbar-highlight.js`) are working examples.

A script is a plain JavaScript file, a classic script rather than a module (no `import` or
`export`), that defines a global function `render(input)`. It runs in a context of its own with the
language's built-ins only: no timers, no `require`, no `eval`, no WebAssembly, no `console`. It
returns its result directly; a returned promise counts as an error. Input and output travel as
JSON, so a value JSON cannot hold (an age of `Infinity`) arrives as `null`.

`input`:

| Field | What it is |
|---|---|
| `value` | the element's metric value, raw as the catalogue gives it; `null` without a metric or while the session does not report it |
| `standIn` | `null` while `value` is the metric's own; `"empty"` or `"full"` while the element draws a stand-in for an absent metric (its `when_absent`) |
| `metric` | the metric id, or `null` |
| `params` | the element's parameters as the skin set them, defaults filled in |
| `reaction` | the session's game-neutral reaction (`src/metrics/reaction.js`): `expr` and `exprAge` (what just happened and how many seconds ago), `flash` (the reaction showing now: `"dead"`, `"god"`, an expression or `null`), `hp` (0 healthy to 4), `god`, `dead` |
| `now` | the time in seconds; `tick` the render tick |
| `width`, `rows` | the columns and rows the fit gave the element |
| `children` | a container's drawn children, in order: `[{ id, metric, value, standIn, width }]` |
| `state` | what the script returned as `state` the last time it ran for this element in this session; `{}` the first time, and again after the skin or the script changes |

The result (anything else is ignored):

| Field | What it does |
|---|---|
| `frame` | the frame an `animation` draws: a file name in its `frames` folder, `.png` added when it has no extension |
| `selected` | the index among `children` of the cell a `grid` frame selects; outside the range selects none |
| `params` | parameters drawn instead of the skin's this render (characters, colours, icons). A value the element's visual does not accept keeps the skin's. A script never changes an element's size: parameters that would change a frame's size are ignored, and a visual drawn wider is cut to its columns |
| `state` | kept for the next run; it is the only thing that survives, since the input is a copy |

Where a script comes from follows the asset rules above: `<game>:<path>` from that game's assets, a
plain path from the skin's own folder. A path that leads out of that folder, or an absolute one, is
refused with a warning and never run.

Budgets and failures:

- Each call has 20 ms, enforced by the script's own timeout. All scripts of one render pass of the
  daemon share 200 ms across every session it draws; when a session finds none left, its elements
  draw their defaults for that render, with no warning and nothing turned off.
- A script that throws, cannot be loaded or returns a promise draws its element's default (an
  animation's `default_frame`, else a blank of its width), shows a warning under the bar, and is
  not run again until its file or its skin changes.
- A script that runs past its budget is stopped and turned off for a cooldown: 30 s, doubling each
  time it runs late again, up to 10 minutes. A call that returns in time resets the cooldown to
  30 s; a change of its file or skin ends it at once.
- All scripts share one worker thread with a 64 MB heap.

Scripts run only in the render daemon. The one-shot status line (no bash 5, or no daemon) runs
none: an animation shows its `default_frame` there, and a chat plays the platform's metrics library
only.

Scripts are trusted code, like any program the user installs: the bar runs them from the user's own
skin folders and from the game packages it installed, and never downloads code from anywhere else.
The script context keeps timers, `require` and `eval` out of reach, but it is not a security
boundary.

### Conversation libraries

A `chat` element plays conversations about the session; it costs no tokens. The platform's metrics
library (`src/kit/chat/metrics-library.js`) always plays, the one-shot status line included. A skin
adds libraries in the chat's `libraries` parameter; each is a script, found like any other, that
defines `conversations(facts)` instead of `render`. Same budgets and failure rules; a library that
fails is left out of the chat with a warning. `games/minecraft/assets/conversations/minecraft.js` is
a working example.

`facts` holds every fact the chat can say (model, effort, context, rate limits, branch, tasks, CPU
and more), as strings and numbers, `null` when unknown; the list is `facts()` in the metrics
library. The function returns:

```js
{ cast: { a: "Ada", b: "Ben" }, conversations: { "<key>": [line, ...], ... } }
```

A line is one of:

- `[role, "text"]`: a message, drawn `<name> text`. Role `"me"` is the running model; another role
  is a name of the cast, or the role itself when the cast does not name it.
- `[role, ["text", "backup", ...]]`: the first text whose placeholders are all known.
- `"text"`: a plain line in the chat's system colour.
- `[{ text, role }, ...]`: parts in their own colours, role `"text"`, `"me"`, `"system"` or
  `"accent"`.

Text may name any fact or cast role in braces (`{ctx}`, `{me}`, `{a}`); a line with a fact that is
not known is left out.

The sources merge in order: the metrics library, the skin's libraries in the order it lists them,
then the chat's own `conversations` parameter. A later conversation with an existing key replaces
it in its place; a new key plays after the rest. Every key in `drop` is left out at the end. The
metrics library's keys are listed at the top of its file.

A skin's own conversations are text, one line per line: `role: text` is a message, any other line
a plain line. Quote a key that has a dot:

```toml
[element.chat]
kind = "chat"
drop = ["cost.ask", "cost.answer"]

[element.chat.conversations]
"ctx.low" = """
a: {me}, your context is at {ctx}%
me: time to wrap up
"""
greeting = "a: hi {me}!"
```

## Releasing

A release is published by pushing a `vX.Y.Z` tag: `.github/workflows/publish.yml` runs the tests
and publishes to npm with trusted publishing (no token). The tag must point at a commit that is
already on `master`, so the version bump goes through a pull request first:

1. `git switch master && git pull && git switch -c release/X.Y.Z`
2. Move the `[Unreleased]` entries in `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`, add the
   compare link at the bottom, and commit it on its own: `docs: changelog for X.Y.Z`.
3. `npm version <patch|minor|major> --no-git-tag-version` (runs `npm test` first), then commit
   `package.json` and `package-lock.json` with the message `X.Y.Z`.
4. Push the branch, open a pull request, and merge it once the checks are green.
5. Tag the merged commit and push only the tag:

   ```sh
   git switch master && git pull
   git tag -a vX.Y.Z -m X.Y.Z
   git push origin vX.Y.Z
   ```

6. Check the outcome: `gh run watch` on the `Publish to npm` run, then
   `npm view claude-game-bar version --prefer-online`.

If the publish run fails (for example a test that only fails in CI), nothing reaches npm. Fix it
through a pull request, then move the tag to the fixed commit on `master`:
`git push origin :refs/tags/vX.Y.Z`, `git tag -fa vX.Y.Z -m X.Y.Z <commit>`, `git push origin vX.Y.Z`.

### Asset packages

Each game's assets are their own npm package, `@claude-game-bar/<game>`, published from
`games/<game>/assets/`. The main package ships no game assets (`test/install/package-files.test.mjs`
checks that): an installed bar fetches the version its game manifests pin, in the background, the
first time a skin needs it.

`.github/workflows/publish-assets.yml` runs on every push to `master` that touches an assets folder.
It publishes each package whose version is not on npm yet, with trusted publishing and provenance,
from the GitHub environment `npm-assets`, whose deployment rule allows only `master`. A version
already on npm, the placeholder `0.0.0` and a package npm does not know yet are skipped with a
notice.

To change a game's assets:

1. In one pull request, change the files, bump `version` in `games/<game>/assets/package.json`, and
   set the same `version` in `src/games/<game>/game.toml` (`[assets]`). The package-files test
   fails while the two differ. A version is never `0.0.0`, which means "not published".
2. Merge it. The workflow publishes the new version.
3. In a second pull request, set `integrity` in `game.toml` to what
   `npm view @claude-game-bar/<game>@<version> dist.integrity` prints. Until then the bar treats
   the game as unpublished and a checkout uses its own folder; an installed bar has no assets for
   the game.
4. Release the bar as usual. Users get the new assets with that release, never earlier.

#### One-time bootstrap (owner)

Trusted publishing can be set up only for a package that exists, so each new package name starts by
hand:

1. Create the npm organisation `claude-game-bar` (once).
2. Set the package's first version (not `0.0.0`) in its `package.json` and manifest, then publish
   it from its folder: `cd games/<game>/assets && npm publish --access public`.
3. On npm, add a trusted publisher to the package: this repository, workflow `publish-assets.yml`,
   environment `npm-assets`. In the repository settings, create the `npm-assets` environment with a
   deployment rule that allows only `master`.
4. In the package's settings on npm, require two-factor authentication and disallow tokens.
5. Pin the published version and its integrity in the manifest, as in step 3 above.

Until both games are bootstrapped and pinned, an installed bar cannot fetch any game assets; a
checkout works from its own `games/` folders.
