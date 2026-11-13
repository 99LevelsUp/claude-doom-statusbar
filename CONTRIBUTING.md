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
