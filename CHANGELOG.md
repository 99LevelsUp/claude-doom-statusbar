# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Marquee scrolling for overflowing text** (the "car radio" effect). Plain text
  that is too wide for its column budget now glides left until its tail shows,
  pauses, then glides back to the start and pauses again — ping-pong, advanced one
  step per statusbar refresh (a pure function of time, so renders stay
  deterministic). Applies to `scroll` and `list` rows (agent labels, task titles)
  and to plain `text`/`number` values. Values carrying ANSI/OSC escapes (coloured
  text, hyperlinks such as `loc.cwd`, `git.branch`, `pr.state`) are left untouched,
  since they can't be sliced by column without corrupting the escape sequence.
  The `full` preset caps the AGENTS and TASKS boxes (`max_width = 22`) so long
  labels actually scroll instead of stretching the box.

## [0.5.0] - 2026-06-12

### Changed
- SAVE box savings are now **per-session** instead of global. The lean-ctx row
  (🪶) sums tokens saved for files under the current working directory from
  lean-ctx's append-only `events.jsonl`, read incrementally by byte offset and
  accumulated in a per-session state file — so concurrent sessions no longer show
  identical numbers, and the figure follows you across `cwd` changes. The llmlingua
  row (📜) reads the per-session block keyed by `CLAUDE_CODE_SESSION_ID`. The
  compression rate is derived from each session's own accumulated totals.

## [0.4.0] - 2026-06-12

### Added
- SAVE box showing per-tool session token savings, read from the JSON files
  that lean-ctx (`~/.lean-ctx/mcp-live.json`, 🪶) and llmlingua
  (`~/.llmlingua-stats.json`, 📜) already persist — no plugin patching, no
  binary spawn. Rows read defensively: a missing file, malformed JSON, or zero
  savings omits the row, so the box collapses entirely when neither tool is
  installed. Shown in the `default` (after USAGE) and `full` presets.

## [0.3.1] - 2026-06-11

### Fixed
- Agent labels and task titles are clipped to 24 characters so a long subagent
  description or task title can no longer blow up the AGENTS / TASKS box width
  (mirrors the existing PROJECT box clip).

## [0.3.0] - 2026-06-11

### Added
- PROJECT box now shows the session name on its first row (from `session_name`,
  falling back to `session_id`), clipped to 24 characters.

### Changed
- PROJECT box merges the changed-file count and pull/push (ahead/behind) onto a
  single row: files first, then pull/push.

### Fixed
- Repository and branch names are clipped to 24 characters so a long name can no
  longer blow up the PROJECT box width and push other boxes off screen.

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

[Unreleased]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/99LevelsUp/claude-doom-statusbar/releases/tag/v0.1.0
