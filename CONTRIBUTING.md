# Contributing

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

This interface is internal. It may change between releases, without a major version bump.

A game is one folder under `src/games/` plus one entry in the registry, `src/games/index.js`.
The data collection, the metric engine, the drawing kit, the render daemon, the hooks and the
installer reach a game's code and files only through the registry, so adding a game changes
nothing outside its folder and its entry.

```
src/games/<name>/
  layout.js          the layout function (and any game-specific drawing it needs)
  presets/*.toml     the game's presets
  assets/            images or other files the game reads, if any
```

The registry entry describes the game. The comment at the top of `src/games/index.js` lists every
field; these are the main ones:

- `name` and `about`: the theme name and its one-line blurb in `theme`. `aliases` lists older
  names that still choose the game.
- `layout`: the drawing function. `layoutKey`: the preset `[bar] layout` value that selects it.
  The preset decides the layout, not the theme, so a preset of one game named through
  `DOOMBAR_PRESET` still draws with its own game's layout.
- `presets` (name to absolute path) and `defaultPreset`: the preset the theme renders.
- `sample`: an optional image the glyph test card draws at every glyph step.

The list order is the order `theme next` cycles through.

The layout is called as `layout(cfg, target, ctx)` and returns the bar's lines:

- `cfg` is the parsed preset.
- `target` is the terminal width in columns.
- `ctx` is the render context from `src/kit/context.js`. It holds the metric values, the glyph
  step, the clock, the marquee tick, the overflow and indent settings, and a loader for sibling
  presets.
- `ctx.reaction` is the session's game-neutral reaction from `src/metrics/reaction.js`: what just
  happened (`expr`, `exprAge`), its decayed `flash`, the health level `hp`, and `god` and `dead`.
  A game turns it into its own look, such as DOOM's face or the Minecraft heart colour.

A layout reads everything from these three arguments and keeps no state about a session between
calls. The render daemon draws many sessions in turn with the same modules.

`test/games/registry.test.mjs` registers a small fixture game from `test/games/fixture-game/` and
renders it. It is a working example of a folder plus an entry.

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
   `npm view claude-doom-statusbar version --prefer-online`.

If the publish run fails (for example a test that only fails in CI), nothing reaches npm. Fix it
through a pull request, then move the tag to the fixed commit on `master`:
`git push origin :refs/tags/vX.Y.Z`, `git tag -fa vX.Y.Z -m X.Y.Z <commit>`, `git push origin vX.Y.Z`.
