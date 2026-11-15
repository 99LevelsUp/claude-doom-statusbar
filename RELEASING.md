# Releasing

`claude-game-bar` is published to npm as the package `claude-game-bar` from the GitHub repository
[99LevelsUp/claude-game-bar](https://github.com/99LevelsUp/claude-game-bar). It follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **MAJOR** — incompatible / breaking changes.
- **MINOR** — new functionality, backward compatible.
- **PATCH** — backward-compatible bug fixes.

Publishing to npm is automated by `.github/workflows/publish.yml`, which runs on
every pushed tag matching `v*.*.*` and publishes via npm trusted publishing (OIDC).

## Cutting a release

`master` is protected and takes changes only through a pull request, so the version
bump goes through a pull request first and the tag is pushed afterwards, on the merged
commit. The steps are in [CONTRIBUTING.md, *Releasing*](CONTRIBUTING.md#releasing).

Do not run a plain `npm version`: it commits and tags locally, the push of the commit
to `master` is rejected, and a tag pushed with it would publish a commit that is not
on `master`.

## Prerequisites (one-time)

- On npmjs.com, configure the `claude-game-bar` package with a **trusted publisher** for the
  GitHub repository `99LevelsUp/claude-game-bar` and the `publish.yml` workflow, so the OIDC token authorizes
  publishing without a long-lived `NPM_TOKEN`.
- The GitHub `npm` environment referenced by the workflow must exist in the repo
  settings.
