# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.1] - 2026-06-25

### Fixed
- **`sys.zombies` no longer sticks at a stale spike.** The bash-count snapshot rode
  git's write-gated cadence, so non-write activity (PowerShell, Read, Grep) never
  refreshed it and a captured spike lingered on the HUD long after the real count
  dropped. It now has its own time-based gate (`DOOMBAR_MSYS_TTL`, default 4 s) that
  fires on any event, so the gauge tracks reality regardless of which tools run.

## [0.9.0] - 2026-06-25

### Added
- **Windows MSYS "bash flood" gauge (`sys.zombies`, 🧟).** On Windows every Claude
  Code hook and the Bash tool launch through Git Bash, so concurrent `bash.exe`
  inits can poison the shared MSYS section (`add_item ... errno 1`). The async hook
  now counts live `bash.exe` via `tasklist` (a direct exe — never through bash,
  which would feed the very flood being measured), piggybacked on the throttled
  git-snapshot event so it never runs on a render tick. The SYSTEM box renders the
  count with a count-tuned gradient (green ≤5, amber ~8, red ≥10). Win32 only —
  hidden everywhere else.
- **`tools/fix-msys.cmd`** — a manual, out-of-session repair script for the poisoned
  state. Pure `cmd.exe` (works even if bash is broken); locates `dash.exe`, refuses
  to run while any `bash.exe` is alive (rebaseall needs zero live MSYS processes or
  it corrupts `msys-2.0.dll`), then runs `rebaseall`. Never auto-triggered.

### Changed
- **The SYS box is now SYSTEM**, and the per-core CPU equalizer shares one row with
  the aggregate CPU %: a 🔥 icon, the per-core equalizer, and the CPU percentage
  right-aligned beside it (aligned with the disk bar's percentage below).
- **The scroll overflow marker (↑k/↓k) is now gold**, not the dim body colour, so
  the count of hidden rows in AGENTS/TASKS stands out.

## [0.8.1] - 2026-06-21

### Added
- **Configurable colour gradients.** A metric's `color` now accepts custom gradient
  stops — `[[value, "#hex"], ...]` pairs interpolated smoothly between stops. A single
  pair is a solid colour; adjacent stops (50/51) make a hard step. `color = "threshold"`
  is now a smooth green→yellow→red gradient (0/50/100) instead of hard 60/85 cutoffs,
  and applies to all progress visuals (bars, ammo, equalizer, coloured numbers).

### Fixed
- **`sys.cores` no longer flickers between 0 % and 100 %.** Per-core CPU was sampled
  over sub-second intervals where Windows' clock-tick quantisation dominates; it now
  holds the last reading until at least 1 s has elapsed, matching Task Manager.
- **`sys.cores` equalizer icon alignment.** Swapped the slider glyph (rendered one
  column wide in most terminals) for a bar-chart emoji that is reliably two columns,
  so the metric no longer shifts.

## [0.8.0] - 2026-06-21

### Added
- **`equalizer` render type** — a one-row VU-meter that draws an array of `0..1`
  values as side-by-side block columns, each coloured by its own value via the
  threshold ramp (green / yellow / red). Uses its own 9-level height ramp (empty
  through full block), distinct from the `spark` sparkline. When channels exceed
  the column cap they densify by averaging, so the rendered width stays fixed.
- **`sys.cores` metric** — per-core CPU utilisation as a `0..1`-per-core array,
  surfaced in the `full` preset's SYS box as a per-core equalizer beside the
  aggregate `sys.cpu`. Reuses the existing CPU snapshot cache.

## [0.6.0] - 2026-06-15

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
- **Responsive width with preset fallback.** As the terminal narrows, bars
  (14 → 4 cells) and text (24 → 10 columns) shrink together on one scale; overflow
  is handled by the marquee. When even the smallest layout no longer fits the
  terminal width (`COLUMNS`), the preset falls back to a smaller one via a new
  `[bar].fallback` key — `full → standard → minimal`. The chosen preset is the
  ceiling; widening recovers it. Stateless: each refresh re-reads `COLUMNS`, so it
  tracks live resizes.

### Changed
- **Renamed the `default` preset to `standard`** (`presets/default.toml` →
  `presets/standard.toml`). The default `DOOMBAR_PRESET` and installer help now
  reference `standard`. No back-compat alias — update any config that named
  `default`.
- **Trimmed the `standard` and `minimal` presets** so the fallback chain steps
  down in size. `standard` drops the SAVE and SYS boxes; `minimal` is pared to
  USAGE, PROJECT, and ACTIVITY around the mugshot, with PROJECT to the right of
  the face.

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

[Unreleased]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/99LevelsUp/claude-doom-statusbar/releases/tag/v0.1.0
