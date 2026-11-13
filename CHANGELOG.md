# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.15.0] - 2026-11-13

### Added
- **The render daemon and its fast client on Linux, and on macOS with bash 5.** A status line
  tick no longer starts Node there: `install` writes a command that hands the tick from
  `/bin/sh` to bash, which prints the frame the daemon already drew. A tick costs about as much
  as starting bash: about 4 ms on a Raspberry Pi 5, against 255 ms for the one-shot renderer,
  and 3 ms against 40 ms on a GitHub Linux runner. Without a bash 5, as on a stock Mac, the
  one-shot renderer stays. Run `claude-doom-statusbar install` once after upgrading to switch;
  running sessions pick it up at their next tick. macOS with bash 5 is not tested on a real Mac
  yet.
- **`install --local`** writes the project's `.claude/settings.local.json`, which overrides
  `settings.json`, for a checkout wired to itself.

### Changed
- **On Linux and macOS the bar's files leave the shared `/tmp`.** Other users could read them
  there, and plant some, such as the face cache, whose text goes straight to the terminal. They
  now live in a private directory: `$XDG_RUNTIME_DIR/doombar`, on macOS `$TMPDIR/doombar`,
  otherwise `/tmp/doombar-<uid>`, mode 0700. A directory that is not this user's own is never
  read or written; the bar shows `doombar: offline` instead. The runtime directory is cleared at
  logout, so a session resumed after one starts its HUD state afresh. Files a previous version
  left in `/tmp` are not moved; a reboot clears them. `DOOMBAR_RUNTIME_DIR` sets the place.
- **Each session's glyphs follow its own terminal on Linux too:** `TERM` and `VTE_VERSION` now
  travel with the session to the daemon.
- **`uninstall` stops the render daemon on Linux and macOS too** and removes its files from every
  place the runtime directory can be. It asks the daemon to stop, kills it after 3 s if it has
  not, and kills only a process it has confirmed as this installation's daemon.

### Known issues
- `install --local` in a checkout that is also installed globally registers the hooks a second
  time (backlog D-16). Wire a development checkout with one or the other.

## [0.14.0] - 2026-11-11

### Added
- **One render daemon per installation, on Windows with Git Bash.** The statusLine is now a
  small bash client that uses builtins only and starts no process: it hands the session's data to
  the daemon and prints the frame the daemon has already drawn. The daemon gathers the
  machine-wide data once, draws every session's bar about twice a second at below-normal
  priority, and exits after 10 minutes without a session. A frame past its deadline turns grey
  and ends in `OFFLINE`, so old values never pass for live ones. The hooks start the daemon,
  replace one that hangs or is outdated, and leave it alone while the machine is busy, since it
  is then starved rather than hung. After a global upgrade run `claude-doom-statusbar install`
  once to move the statusLine to the client. Linux and macOS keep the one-shot render for now.
- **The installer makes sure Linux can draw the emoji.** On Linux, `install` asks fontconfig
  whether a font covers the bar's emoji. If none does, it downloads Noto Color Emoji v2.051,
  checks its SHA-256 and installs it for the user (`~/.local/share/fonts`, no `sudo`), then runs
  `fc-cache`. It installs nothing over SSH and skips Windows and macOS, which ship emoji fonts.
  `--no-fonts` or `DOOMBAR_NO_FONTS=1` turns it off.
- **`claude-doom-statusbar test-card`** prints every glyph step and the mugshot drawn at each,
  then names the step the bar picked for this terminal.
- Snapshot tests that pin what the DOOM presets and the Minecraft hotbar draw, and a Linux test
  workflow that runs the suite on every push to `master`.

### Changed
- **The mugshot no longer needs chafa.** The bar converts the face to block glyphs itself, at
  any height, so no process starts to draw it and it looks the same with or without chafa
  installed. The conversion samples the sprite smoothly and picks each cell's glyph by its shape,
  as chafa does; side by side with chafa on all 42 faces it drew the cleaner outlines. The
  pre-rendered `.ans` faces are gone from the package, and chafa is no longer used at all.
- **The face's glyphs follow the terminal.** Windows Terminal, kitty and Ghostty get octants,
  VS Code, WezTerm and VTE terminals wedges, tmux, screen and unknown terminals half blocks,
  which every font draws. `DOOMBAR_GLYPHS` overrides the pick, and the presets' `[mugshot]
  glyphs` key caps it for the face.
- **Finished tasks stay in the count for the whole session.** Ten seconds after the last task
  settles only the task list empties; the count no longer drops back to zero. When Claude Code
  cleans up a finished list (it deletes the task files and keeps `.highwatermark`), the tasks
  up to that mark still count as done, including after a reboot or `--resume`.

### Fixed
- **Tasks survive a reboot and `claude --resume`.** The bar knew tasks only from its journal in
  the temp directory, which a reboot wipes, so a resumed session showed 0/0 with tasks still
  open. It now reads Claude Code's own task list in `~/.claude/tasks/<session id>/` (or
  `CLAUDE_CODE_TASK_LIST_ID`), and fills in from the journal the order and the tasks it saw
  deleted.
- **The bar no longer leaves piles of small files in the temp directory.** A session's files
  are deleted when it ends (a new `SessionEnd` hook; re-run `install` to add it), keeping only
  its savings total for a later resume. Sessions that never showed a bar, such as headless
  `claude -p` runs, which were most of the files, are swept after an hour
  (`DOOMBAR_UNRENDERED_TTL`) instead of a week. The savings files, which were never swept, now
  are, and a failed atomic write no longer leaves its `.tmp` behind.
- **Every per-session file follows `MUGSHOT_STATE`.** The probe markers, the advisor cache and
  the savings file used to go to the system temp directory regardless, so `npm test` wrote into
  the machine's real temp directory. The test suite now leaves nothing there.

## [0.13.1] - 2026-10-31

### Changed
- **Minecraft theme: hearts and hunger swapped.** Hearts are now the 5-hour limit (so running
  out of it empties them and shows "You died!", like in the game) and the 🍖 hunger is the
  context window. The chat lines about food and hearts follow.

### Fixed
- **Usage limits now match across chats.** Rate limits belong to the account, but Claude Code
  only refreshes a chat's copy when that chat calls the API, so an idle chat kept showing old
  numbers (12% on the 7-day bar while another chat was at 16%). Every render now pools its
  reading into a shared file in the temp directory and shows the freshest one any chat has
  seen: per window, a later `resets_at` wins, and within a window the higher percentage wins
  (usage only rises). Brand-new chats show the limits before their first message, and the
  mugshot's rate-based health uses the same shared numbers. `DOOMBAR_RATELIMITS_SHARE=0` turns
  it off. Context (the hunger / HP bar) stays per chat: each chat has its own.

## [0.13.0] - 2026-10-31

### Changed
- **The Minecraft chat now says everything the status bar knows.** The hotbar's nine slots are
  configurable, so the chat is where every session fact gets said: session name and project,
  branch, changed files, lines added and removed, push/pull, PR, effort, thinking and fast mode,
  permission mode, output style, advisor, context, both usage limits with their resets, cost,
  running agents (with what they're doing), the current, next and last-finished task, errors,
  token savings, CPU per core, RAM, disk, zombie shells, session length and the time. Some lines
  only appear when they fit (a warning when context is nearly full, "skip the night" after 9pm),
  and a question is only asked when its answer is known. New `session.title` metric: the
  session's real name (`/rename`), never its id.
- **The chat is as wide as it can be and wraps instead of cutting off.** It takes all the room
  left of the hotbar, up to its longest message, and a message that still doesn't fit continues
  on the next line, like the game's chat. Narrow the terminal and more messages wrap; the newest
  stays at the bottom.
- **The hotbar theme is now just `minecraft`** (it was `minecraft-hud`). The old name still works,
  both typed (`theme minecraft-hud`) and as a saved choice from 0.12.x.

### Removed
- The box-style `minecraft` and `satisfactory` themes from 0.12.0 (DOOM's layout with restyled
  boxes) and their pixel-art mugshots, along with the `[mugshot].face` option. A saved
  `satisfactory` choice falls back to `doom`. The `icons` render type and `[bar].title_color`
  stay as general preset options.

## [0.12.1] - 2026-10-31

### Added
- **`minecraft-hud` theme: the in-game survival screen** instead of a row of boxes:
  - 10 hearts (context left) across the left half and 10 🍖 shanks (5h limit left, 🦴 when
    eaten) across the right;
  - the XP bar (7-day usage, level = its percent);
  - a 9-slot hotbar with a session stat in each slot (context size, cost, changed files, lines
    added, agents, tasks, errors, CPU, clock), drawn with heavy box lines. Slots are an odd 7
    columns wide so values centre exactly. The selected slot jumps to what just happened (error, write, finished task) and
    wanders on its own when idle;
  - a Minecraft-style chat on the left, a long pre-written script that loops (no tokens). The
    running model is always one of the speakers, its name coloured by reasoning effort (low red,
    medium orange, high green, xhigh aqua, max a drifting rainbow). Answers to questions arrive
    within 2 s, other messages after a varied 3-10 s pause, and a few lines quote live session
    values.
  It flashes the hearts on errors, turns them gold while invulnerable, and shows "You died!" when
  out of usage. Narrow terminals hide the chat, drop slots from the right and halve the hearts.
  It's centred on the true middle of the terminal (Claude Code draws the status line 2 columns
  in; `DOOMBAR_INDENT` overrides). Configured by `presets/minecraft-hud.toml`
  (`[bar] layout = "hotbar"`, `[hotbar]`, `[hotbar.react]` and nine `[[slot]]` entries).
- Screenshot of `minecraft-hud` and a "Switching themes" guide in the README.
- `loc.added` metric: lines added this session as a plain number; `model.effort_level`: the raw
  reasoning effort level.

## [0.12.0] - 2026-10-31

### Added
- **Game themes: Minecraft and Satisfactory**, alongside the original DOOM look. Switch live with
  `claude-doom-statusbar theme <doom|minecraft|satisfactory>` (or `theme next` to cycle, `theme`
  to list). The choice is saved to `~/.claude/doombar-theme.json` and read on every render, so it
  applies on the next refresh with no restart; `DOOMBAR_THEME` overrides it for one shell.
  - **minecraft**: hearts for context left, a hunger row for the 5h limit, an XP bar for the 7-day
    one, plus PLAYER / SURVIVAL / WORLD / REDSTONE / PETS / ADVANCEMENTS / F3 DEBUG boxes.
  - **satisfactory**: a POWER GRID box (the 5h limit is the grid load, the 7-day one the
    batteries), FACTORY, PRODUCTION, DRONES, MILESTONES and HUB.
  - Each theme has its own original pixel-art mugshot (a blocky miner, an engineer's helmet whose
    visor colour tracks health) that reacts to the same events as the Doomguy face, with a health
    caption underneath. It's drawn from code, so it needs no chafa.
- `icons` render type: a row of glyphs filled by value (`glyph`, `empty_glyph`, `count`,
  `invert`, `empty_color`, `show_pct`, `suffix`), e.g. hearts.
- `[bar].title_color` sets the box-title colour, and `[mugshot].face` picks the face
  (`doom` | `minecraft` | `satisfactory`).

## [0.11.6] - 2026-08-27

### Fixed
- **The journal sweep now cleans the directory it actually writes to.** 0.11.5 read `os.tmpdir()`
  directly while honouring `MUGSHOT_STATE` for the files it created, so a run with the checkpoint
  relocated deleted from the real temp directory instead of the relocated one. The test suite does
  exactly that, which means `npm test` was quietly sweeping the developer's own temp directory.
  The sweep is now scoped to the checkpoint's own directory — identical in normal use, correct
  when relocated.

## [0.11.5] - 2026-08-27

### Fixed
- **Per-session state files are now cleaned up instead of accumulating forever.** Each session
  left a checkpoint, a journal and two markers in the temp directory, keyed by session id, and
  nothing ever removed them — a real box had **12 395 files / 10 MB**, including orphaned
  `<checkpoint>.<pid>.tmp` files from interrupted atomic writes. They are pure scratch (once a
  session ends its journal can never be read again), so `SessionStart` now sweeps the ones older
  than `DOOMBAR_JOURNAL_TTL` (default 7 days) alongside the journal reset it already did. The
  sweep is deliberately narrow: only our own `mugshot_` prefix, only the temp directory,
  non-recursive, never this session's own files, and never the cross-session shared state (the
  rate-health accumulator and the reap throttle are keyed by fixed names and excluded). A file
  whose mtime can't be read is kept, not guessed at. `DOOMBAR_JOURNAL_TTL=off` disables it.
  Runs in the async `SessionStart` hook, so the directory scan delays nothing.

## [0.11.4] - 2026-08-27

### Fixed
- **Upgrading no longer leaves the hooks on the previous version's code.** The installer skipped
  any hook entry it recognised as its own, so an install whose package path had moved — a fresh
  `npx` cache directory, or switching from `npx` to a global install — kept the *old* path in
  `hooks` while `statusLine` was replaced unconditionally with the new one. The result was a
  split install: the render ran the new version, every hook ran the previous one, and anything
  shipped in `hook.js` silently never took effect. Found while deploying 0.11.3, where it would
  have left the MSYS reaper active in the render and missing from the hook. Entries of ours that
  point somewhere else (or use the legacy shell form) are now re-pointed instead of skipped, and
  the install reports how many. A second run is still a genuine no-op.

## [0.11.3] - 2026-08-27

### Fixed
- **Windows: a 1-second refresh no longer poisons Git Bash.** On Windows every render is wrapped
  in Git Bash — `statusLine` has no exec form (its whole schema is
  `type`/`command`/`padding`/`refreshInterval`), so Claude Code always hands the command to a
  shell, and that shell is Git Bash whenever Git for Windows is installed. Neither
  `CLAUDE_CODE_GIT_BASH_PATH`, nor `CLAUDE_CODE_USE_POWERSHELL_TOOL`, nor `defaultShell` redirects
  it (all three measured with no effect; `defaultShell` governs only the `!` shell-mode prefix).
  Because `Git\bin\bash.exe` is a stub that re-execs `Git\usr\bin\bash.exe`, each render costs two
  MSYS initialisations. Healthy that is ~0.15 s apiece and nothing accumulates; the failure starts
  from a single **hung** init, which corrupts the shared MSYS section
  (`add_item ("\??\C:\Program Files\Git", "/", ...) failed, errno 1`) and then sustains itself — a
  poisoned `bash -c` hangs ~15 s before dying with `0xC0000005`, so at 1 Hz the wrapper population
  never reaches zero, the section never gets an instant with no holder, and it cannot heal. Git
  Bash ends up unusable machine-wide, `bash --version` included, on an intact install.
  **The refresh interval stays at 1 s on every platform**; the fix is a reaper that kills hung
  wrappers so the section can heal. It targets only `bash.exe` running this package's
  `statusline.js` past `DOOMBAR_MSYS_REAP_AGE` (default 10 000 ms, against ~300 ms healthy) — such
  a shell is already hung and its render lost. Measured effect: 15 233 ms + `0xC0000005` → 277 ms +
  exit 0. It runs from the hook on any event once live `bash.exe` reaches `DOOMBAR_MSYS_REAP_MIN`
  (default 4), **and** from the render, throttled to `DOOMBAR_REAP_TICK` (default 15 000 ms),
  because an idle session produces no hook events and idle is exactly when the 1 Hz timer is the
  only thing spawning shells. The render's kick is detached and unref'd, so it never delays a
  render (measured 207 ms with the reaper armed). `DOOMBAR_MSYS_REAP=0` disables both.
  The old claim that the render path made this flood "impossible by construction" was only ever
  true of the render's *children*, not of the wrapper Claude Code spawns above it.
- **Mugshot no longer reads bloodied at low usage from a physically impossible cap ratio.** The
  gross-sum estimator could learn `k = cap7d/cap5h < 1` — the 5h window resets ~33× more often
  than the 7d one, and every reset straddling two samples drops the new window's initial climb as a
  skipped negative delta, systematically deflating `sum5`. A `k < 1` (observed live at
  `489/1469 = 0.33`) then discounted the ample 7d budget and pinned health low (e.g. 5h at 24%,
  7d at 34% → health 22, near-bloodied). `k` is now floored at its physical minimum of 1
  (`cap7d ≥ cap5h`), so that case reads `min(rem7 × 1, rem5) = 66` — healthy. See
  `docs/ideation/2026-07-11-cap-ratio-accumulator-fix.md` for the estimator redesign (paired
  instantaneous deltas + EWMA/median, decay/TTL, atomic writes) that removes the underlying bias.
- **Mugshot health is now consistent across concurrent sessions.** The cap-ratio accumulator
  (`k = cap7d/cap5h`) was stored per session, so each session re-learned `k` from scratch and —
  because the 7d window barely moves within one session — almost always stalled at `k = 1`. Two
  sessions on the *same account* could therefore show wildly different health (e.g. 24 vs 93).
  Rate limits are account-wide, so the accumulator is now a single global file: one shared `k`,
  identical health everywhere, and it also captures movement that happened while a given session
  wasn't sampling.

### Added
- **`--refresh N` on the installer.** Sets `statusLine.refreshInterval` explicitly; `0` omits the
  key so the HUD renders on events only. Defaults to `1` on every platform.

### Changed
- **Cold-start health now uses the 5h clip alone instead of `k = 1` min-remaining.** Before the
  cap ratio is known, guessing `k = 1` wrongly scaled the slow 7d window 1:1 and dragged health
  down (e.g. 7d at 76% pinned health to 24 from the first render). Health now ignores the 7d
  window until `k` is actually measured: `health = rem5` when the ratio is unknown,
  `min(rem7 × k, rem5)` once it's known. The one exception is death — a fully exhausted window
  (`rem == 0`) reads as dead regardless of `k`.

## [0.11.0] - 2026-06-25

### Changed
- **Mugshot health is now distance-to-wall weighted by the learned cap ratio**, replacing the
  time-to-exhaustion model from 0.10.0 (whose health dipped while actively working and rose when
  idle — unintuitive). Health now declines with how much budget is *consumed* and is flat when
  idle, like a depleting clip. The rate-limit caps are unknown, but their ratio is recoverable:
  the same usage is a larger %-step of the smaller cap, so `k = d(5h%)/d(7d%) = cap7d/cap5h`,
  accumulated from positive per-sample deltas (reset-robust). Health is then the nearer wall in
  5h-budget units — `min(100 − 5h%, (100 − 7d%) × k)` — which correctly picks the window you'd
  hit first without any token counts or subscription info. Exhausting the weekly (7d) window
  reads as dead even while the 5h clip is free, and stays dead until the 7d window resets. Until
  enough 7d signal exists, `k = 1` (plain min-remaining), so cold start is seamless.

## [0.10.0] - 2026-06-25

### Changed
- **The mugshot's health now tracks which rate-limit window you hit _first_, not which is
  proportionally fullest.** Anthropic exposes only `used_percentage` per window (no caps, no
  absolutes), so the binding window is derived from the _rate_ each percentage climbs —
  `time-to-exhaustion = (100 − used%) / d(used%)/dt`, normalised to a 5-hour clip. The absolute
  caps cancel, so this needs no token counts or subscription info. Health is the floor of that
  rate runway and the instantaneous level (tightest remaining %), so the face warns when you're
  burning fast _or_ simply near a wall — and a window that resets before it would exhaust, or a
  percentage drop (window rollover), no longer drags the face down. Rate is averaged over
  `DOOMBAR_RATE_WINDOW` (default 60s); before a baseline exists, health equals the previous
  snapshot metric, so cold start and context-only (API-key) setups are unchanged.

## [0.9.2] - 2026-06-25

### Changed
- **The installer now writes hooks in exec form** (`"command": "node", "args": [hook]`)
  instead of shell form (`"command": "node \"...\""`). On Windows, Claude Code launches
  shell-form hooks through Git Bash (`bash -c "node ..."`); wiring the hook into ~10
  events then spawns a bash per event, and concurrent bursts (especially at SessionStart
  across multiple instances) poison the shared MSYS section — the `add_item ... errno 1`
  flood. Exec form spawns node directly with no shell on any platform, so the hooks no
  longer create bash at all. `statusLine` has no exec form and stays shell-form (one
  sequential spawn per tick, not a concurrent burst). Existing installs are matched in
  either form, so `uninstall` still cleans up hooks written by older versions.

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

[Unreleased]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.15.0...HEAD
[0.15.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.11.6...v0.12.0
[0.6.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/99LevelsUp/claude-doom-statusbar/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/99LevelsUp/claude-doom-statusbar/releases/tag/v0.1.0
