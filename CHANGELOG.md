# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-11

### Added
- Scroll overflow marker (`↑k` / `↓k`) is now right-aligned at the end of the
  row in the TASKS and AGENTS boxes, instead of prefixing the first/last row.
- Task status icons are now 2-column emoji so rows align and stay vivid:
  completed ✅, deleted ❌, in_progress ⏩, pending 🎯.

### Changed
- README HUD image now has a transparent background around the boxes and mugshot.

### Fixed
- Deleted tasks now scroll out of the TASKS box together with completed ones,
  instead of staying pinned at the settled/open boundary.

## [0.1.1] - 2026-06-11

### Added
- GitHub Actions workflow that publishes to npm on `v*.*.*` tags via npm
  trusted publishing (OIDC).
- `preversion` / `postversion` / `prepublishOnly` scripts for one-command releases.
- `CHANGELOG.md` and `RELEASING.md`.

Note: no changes to the published package contents (`src`, `bin`, `presets`,
`assets`); this release validates the automated publish pipeline.

## [0.1.0] - 2026-06-11

### Added
- Initial release: DOOM-inspired status bar / HUD for the Claude Code CLI.
- Mugshot tracking session health, plus usage, model, project, and system stats.
- Live subagent list with always-visible AGENTS and TASKS boxes.

[Unreleased]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/99LevelsUp/claude-doom-statusbar/releases/tag/v0.1.0
