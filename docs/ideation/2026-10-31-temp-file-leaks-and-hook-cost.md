# Temp-file leaks and wasted hook work

**Date:** 2026-10-31
**Trigger:** the owner keeps finding piles of small files the bar leaves behind and has to hunt them down
and delete them by hand after sessions end.
**Status:** measured on the owner's machine; not planned yet. Ties into the rename
(`2026-10-31-shared-game-layout-engine.md`), which touches every one of these file names anyway.

## Where the bar writes

Everything per-session goes to `os.tmpdir()` (`%TEMP%` = `C:\Users\<user>\AppData\Local\Temp`). Nothing goes
anywhere else, except `~/.claude/doombar-theme.json` (one file, written only by `theme`) and settings.json
written by the installer.

| File | Written by | Lifetime today |
|---|---|---|
| `mugshot_<sid>.json` (checkpoint) | statusline, atomic tmp + rename | swept 7 days after last write |
| `mugshot_<sid>.json.jsonl` (event journal) | every hook event, append | truncated at SessionStart, swept after 7 days |
| `mugshot_git_<sid>.json`, `mugshot_msys_<sid>.json` (probe throttle markers) | hook | swept after 7 days |
| `mugshot_adv_<sid>.json` (advisor cache; raw sid, not `sidKey`) | statusline | swept after 7 days |
| `mugshot_<sid>.json.<pid>.tmp` | statusline, when the rename fails | swept after 7 days |
| `savings_<sid>.json` | statusline | **never swept** (wrong prefix) |
| `mugshot_cpu.json`, `mugshot_ratehealth_global.json`, `mugshot_ratelimits_global.json`, `mugshot_reap_tick.json` | statusline | shared, one each (fine) |

## Measured 31.10.2026 (owner's machine)

- **~3,690 bar files, ~5.8 MB** in `%TEMP%`: 1,181 journals, 1,181 git markers, 1,180 msys markers,
  30 checkpoints, 13 advisor caches, 9 orphaned `.tmp`, 72 `savings_*` (31 of them older than 7 days).
- All `mugshot_*` files are younger than 7 days, so the sweep works as written. The problem is the volume:
  **~1,180 sessions in 6 days, ~200 a day.**
- **1,155 of the 1,181 journals have no checkpoint**: the statusline never rendered for those sessions.
  A typical one: `SessionStart`, a git snapshot, an msys count, `Stop` 15 s later, 517 bytes. These are
  headless `claude -p` runs (launched by other tools' hooks and scripts), which fire the user-level hooks
  like any session but never display a bar.
- Test leftovers in the real temp dir: `mugshot_msys_msysrw-*`, `mugshot_msys_gittest-*`,
  `mugshot_git_msyshook-*`, `mugshot_msys_x.json`, `mugshot_msys_default.json`.
- `%TEMP%` holds 12,767 entries in total.

## Findings

### Leaks

1. **No end-of-session cleanup.** Files live until a later session's SessionStart sweep finds them 7 days
   old. Claude Code has a `SessionEnd` hook event; the installer doesn't register it.
2. **Headless sessions cost three files each and never use them.** 98 % of the journals belong to sessions
   that never render.
3. **`savings_<sid>.json` is never deleted.** The sweep only knows the `mugshot_` prefix.
4. **Orphaned `.tmp` from atomic writes.** On Windows `renameSync` fails (EPERM / EBUSY) when another
   process has the target open; the tmp is left behind instead of being unlinked.
5. **Probe markers ignore `MUGSHOT_STATE`.** `gitMarkerPath` / `msysMarkerPath` always use `os.tmpdir()`,
   while the checkpoint and journal follow `MUGSHOT_STATE`. Tests that relocate state still write markers
   into the developer's real temp dir, and the sweep (which scans the checkpoint's directory) never sees them.

### Wasted work

6. **Each headless session pays for probes nobody will see.** SessionStart spawns `git` three times
   (branch, ahead/behind, status) and `tasklist` once, and Stop can repeat the git probe: about 4–7 process
   spawns per session, ~200 sessions a day.
7. **The sweep scans all of `%TEMP%`.** Every SessionStart lists 12.7 k entries and stats each `mugshot_`
   file (3.6 k), ~200 times a day. The leak makes its own cleanup slower.

### Minor

8. `mugshot_cpu.json` and `mugshot_ratelimits_global.json` aren't in the sweep's `SHARED_STATE` list. Only
   deleted after 7 days without any render, when the data is stale anyway, so harmless; list them for clarity.
9. `mugshot_adv_<sid>` uses the raw session id where everything else uses `sidKey(sid)`.
10. A journal is truncated only at its own SessionStart, so a long session's journal keeps growing (largest
    seen: 211 KB). The statusline reads it incrementally by offset, so this costs disk, not render time.
    Low priority.

### One-off cleanup done 31.10.2026

3,244 files deleted by hand (sessions without a checkpoint older than 1 day, orphaned `.tmp` older than
1 day, 30 test leftovers); 465 files (1.1 MB) kept: rendered sessions and headless runs younger than a day.
Found while doing it: `savings_<sid>.json` also ignores `MUGSHOT_STATE` (its own `DOOMBAR_SAVINGS_STATE`
or `%TEMP%`), so a test or a sandboxed render writes it into the real temp dir too; it belongs under F.

Open items are tracked in [../BACKLOG.md](../BACKLOG.md).

## Proposals

| # | Change | Fixes | Size |
|---|---|---|---|
| A | **Own directory, one subdirectory per session:** `%TEMP%/claude-game-bar/<sidKey>/` for checkpoint, journal, markers, advisor cache and savings; shared files in `%TEMP%/claude-game-bar/`. Cleanup is one recursive delete; the sweep lists a small directory instead of all of `%TEMP%`. | 3, 5, 7, 9; makes 1 and 2 trivial | medium; do it **with the rename** (new names anyway) |
| B | **`SessionEnd` hook deletes the session's files.** Keep only what a `--resume` needs, if anything (see open questions). | 1, 2 | small |
| C | **Short TTL for sessions that never rendered**: no checkpoint and last write older than ~1 h → delete. Covers sessions that end without SessionEnd (crash, kill). Keep 7 days for rendered ones. | 2 | small |
| D | **Skip probes in headless sessions.** Either detect headless (to verify: `CLAUDE_CODE_ENTRYPOINT` in the hook's environment, or a payload field), or do the git / msys probes only once the statusline has rendered (checkpoint exists). Trade-off of the second: the branch appears on the first event after the first render instead of at once. | 6 | small–medium |
| E | **Unlink the tmp when the rename fails** (checkpoint and ratelimits writers). | 4 | trivial |
| F | **Markers follow the state location** (derive them from `statePaths`, like the journal). | 5 | trivial |
| G | Sweep knows every file the bar writes (`savings_*` now; with A it's simply the directory). | 3, 8 | trivial |

**Quick wins** that can ship before the rename: E, F, G, B and C. A follows with the rename, D after
checking what identifies a headless session.

**Migration:** with A, the first sweep under the new layout should also delete old-style `mugshot_*` and
`savings_*` files in `%TEMP%` (same age rules), so users never have to clean up by hand.

## Open questions

- Does `--resume` keep the session id? If it does, deleting the checkpoint at SessionEnd resets counters
  (errors, tasks) on resume. Options: keep the checkpoint with a 1-day TTL and drop only the journal and
  markers, or accept the reset.
- Is a headless run reliably identifiable from the hook's environment or payload? If not, D falls back to
  "probe only after the first render".
- Where do the ~200 headless sessions a day come from? Not the bar's problem to fix, but worth knowing:
  every user-level hook (not just ours) runs for each of them.
