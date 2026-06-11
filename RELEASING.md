# Releasing

This project follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **MAJOR** — incompatible / breaking changes.
- **MINOR** — new functionality, backward compatible.
- **PATCH** — backward-compatible bug fixes.

Publishing to npm is automated by `.github/workflows/publish.yml`, which runs on
every pushed tag matching `v*.*.*` and publishes via npm trusted publishing (OIDC).

## Cutting a release

1. Make sure `master` is clean and all changes are committed.
2. Move the relevant `CHANGELOG.md` entries from `[Unreleased]` into a new
   version section, then commit.
3. Bump the version. This runs the test suite, updates `package.json` +
   `package-lock.json`, creates a commit, and tags it `vX.Y.Z`:

   ```bash
   npm version patch   # 0.1.0 -> 0.1.1  (bug fixes)
   npm version minor   # 0.1.0 -> 0.2.0  (new features)
   npm version major   # 0.1.0 -> 1.0.0  (breaking changes)
   ```

4. The `postversion` script automatically pushes the commit and the tag
   (`git push --follow-tags`). The tag triggers the publish workflow.

That's it — no manual `npm publish`. The workflow runs `npm ci`, runs tests via
`prepublishOnly`, and publishes the package.

## Prerequisites (one-time)

- On npmjs.com, configure this package as a **trusted publisher** for the
  GitHub repository and the `publish.yml` workflow, so the OIDC token authorizes
  publishing without a long-lived `NPM_TOKEN`.
- The GitHub `npm` environment referenced by the workflow must exist in the repo
  settings.
