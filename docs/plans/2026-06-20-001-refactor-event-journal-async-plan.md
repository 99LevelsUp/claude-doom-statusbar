# Refactor: async hooks + append-only event journal

Date: 2026-06-20
Branch: `refactor/event-journal-async` (from `master`, excludes the `b00c329` git-cache stopgap)
Status: awaiting approval

## Problem

Two coupled issues with the current design:

1. **Hook latency on the critical path.** Every lifecycle event spawns `node hook.js`
   (~235 ms here: ~80 ms fixed process-spawn floor from ESET's on-launch scan + ~120 ms
   node runtime init + ~35 ms work). Hooks are blocking — `PreToolUse` blocks before the
   tool, `PostToolUse` is synchronously awaited before the next model turn — so a busy
   session pays ~470 ms (Pre+Post) per tool call.

2. **`git` on the render hot path.** `statusline.js` spawns `git` 3× per render tick
   (every ~1 s, every session). On Windows concurrent `git.exe` invocations race
   Git-for-Windows' shared MSYS section and corrupt it (`add_item ... failed, errno 1`),
   a cascade that also takes down hooks ("the bash flood"). The `b00c329` per-cwd TTL
   cache only reduced frequency; git still runs on the time-driven, multi-session hot path.

A naive fix (just add `async: true`) removes hook latency but **amplifies a lost-update
race**: the current hook does read-modify-write on one shared state file, and async lets
many ~235 ms hook processes overlap. Worst hit: parallel-subagent `SubagentStart/Stop`
events fired close together — i.e. exactly the live agent tracking we must not regress.

## Approach

Split writer and reader onto two files with two roles, so no shared file is ever
read-modified-rewritten by competing processes:

- **Journal** `mugshot_<sid>.jsonl` — hooks **append only** (one JSON line per event).
  No reads, no folding in the hook.
  - **Append atomicity verified empirically (2026-06-20):** 50 concurrent `node`
    processes appending mixed 80 B / 1800 B lines via `appendFileSync(..., {flag:"a"})`
    to one file, 3 trials — all lines present, zero torn/interleaved lines. So separate
    async hook processes can safely share one journal on this Windows/NTFS setup.
  - **Fallback if atomicity ever fails (spool directory):** each hook writes one
    uniquely-named `<sid>_<pid>_<ts>.evt` file (atomic create, no shared file);
    statusline reads + folds + deletes consumed files. Not needed now; kept as plan B.
- **Checkpoint** `mugshot_<sid>.json` — `statusline.js` **owns** it: folded state plus a
  byte `offset` into the journal. Same folded shape as today's state file
  (`spans, squad, pending, tasks, tasks_ts, expr, ts, errors, mode` + new `git`).

The fold (today's `foldActivity` + `expression`) moves from hook-write-time to
statusline-read-time.

### Fast read (the scaling requirement)

Each render (~1 Hz):

```
1. read checkpoint            -> { state, offset }   (small; spans pruned to 30 s window)
2. read journal [offset..EOF] -> only lines appended since last render
3. fold new events into state, prune by time (geiger 30 s, settled tasks past linger)
4. write checkpoint (offset = EOF)
5. render (existing activityValues(state, now) is unchanged)
```

`offset` is the "forget line": everything before it is never re-read. Read cost is
`O(new events since last tick)`, independent of session length — a multi-hour session
still reads only ~1 s of new lines per tick. This is the exact technique already proven
in `leanCtxSavings` (`statusline.js:294`): per-session byte offset, read-from-offset,
consume only complete lines (keep any partial tail).

Concurrent renders are safe: two statusline processes that start from the same checkpoint
fold the same `[offset..EOF]` range deterministically and write the same result.

### Checkpoint invariant (load-bearing — the reducer is NOT idempotent)

The reducer uses `st.spans.push(...)` and `st.errors += 1` (append/increment, not keyed
assignment). So **any** drift between `checkpoint.offset` and `checkpoint.state`
double-counts spans (geiger over-reads) and inflates errors. The whole design rests on
one invariant, stated here explicitly:

> `checkpoint.state` MUST always equal `fold(journal[0 .. offset])`, and `state` + `offset`
> MUST be written together, atomically.

Rules that enforce it:
- Checkpoint writes use tmp + `renameSync` (carry over the atomic-write idiom from today's
  `hook.js:128`). `state` and `offset` live in the same file → always consistent together.
- **Never re-fold a range onto state that already includes it.** The dangerous path is
  "checkpoint parse fails → fall back to offset 0 → fold onto non-empty in-memory state"
  → double-count. Safe rule: a missing/unparsable checkpoint resets to **fresh empty
  state AND offset 0** (full recompute from the journal start). Because `SessionStart`
  truncates the journal, "fold from 0 onto empty" is a correct full recompute, never a
  double-count.

### Event ordering under async (ghost-agent guard)

Blocking events arrived ordered; async gives **no append-order guarantee**. `SubagentStop`
can be journaled before its `SubagentStart` (separate processes) → `delete` on a missing
key then `add` → a ghost agent that lingers until `MAX_RUN`. Same for `PostToolUse`
closing a span before its `PreToolUse`. Mitigation: **sort each folded batch by event `ts`
before folding it.** Cross-batch disorder (an event split across the offset boundary)
can't be sorted and is accepted as acceptable for a cosmetic HUD — a conscious decision,
not an oversight.

### Disk growth

Reads are bounded regardless. Disk grows `O(session length)` (~tens of MB over many
hours, in TEMP). Bound it race-free by **truncating the journal on `SessionStart`**
(no concurrent appender at that instant). No mid-session compaction (append-vs-truncate
race not worth it). Orphaned journals are cleaned by OS temp cleanup.

### git moved off the render path (the "bonus")

`git` computation moves into the **async** hook, on write-affecting events
(`PostToolUse` of Edit/Write/Bash/ctx_edit/ctx_shell, and `Stop`), throttled by a TTL.
The hook appends a `git` event (`{ br, lr, st, cwd }`) to the journal; statusline folds
the latest git into `state.git` and renders from it. `statusline.js` no longer spawns
anything — the render path becomes pure read+compute, killing the flood by construction.
git still spawns, but now: async (off critical path), event-driven (only when the tree
could have changed), TTL-throttled, and never per-second across idle sessions.

**Freshness story:** `Stop` is in the refresh set and fires **once per turn** (whenever
Claude finishes responding), so git refreshes per-turn — plenty fresh for a HUD. This is
the framing to lead with: it's "per-turn instead of per-second," not "stale." The
`DOOMBAR_GIT_TTL` marker is a *best-effort* throttle, not a clean lock — the marker file
is itself a small shared RMW, so the worst case is a rare redundant concurrent git spawn
(harmless). Don't oversell it as race-free.

Kept verbatim from `b00c329`: the three git commands + parsing, the `DOOMBAR_GIT_TTL`
throttle (default 4000 ms, env-overridable for tests), the `spawnSync` `timeout: 1000`,
and the defensive `try/catch -> null`. Dropped: render-path location, shared per-cwd cache.

## File-by-file changes

### `src/fold.js` (new — shared reducer)
- Move `foldActivity`, `expression`, `base`, `taskTitle`, and the geiger/task constants
  here as pure functions. Both `hook.js` (for git-event shaping only) and `statusline.js`
  (for folding) import from here. Keeps the reducer independently unit-testable.

### `src/hook.js` (becomes append-only + async git)
- Read event from stdin. Append one line `{ name, ev, ts }` to the journal. No state read,
  no fold, no RMW. Still `exit 0`, still swallow all errors.
- On write-affecting events / `Stop`, if `now - lastGitTs > GIT_TTL` (tracked via a tiny
  per-session marker, or piggybacked), compute git and append a `git` event line.
- On `SessionStart` (new event, see cli), truncate the journal.

### `src/statusline.js`
- New `loadState(data)`: read checkpoint, read journal from `offset`, fold via `fold.js`,
  prune, persist checkpoint, return folded state. Replaces today's `readState`.
- Remove `git()` / `gitInfo()` and the `spawnSync` import. `buildValues` reads
  `state.git` (folded) instead of calling `gitInfo(cwd)`.
- `activityValues`, `statsValues`, `sysValues`, render — unchanged.

### `bin/cli.js`
- Add `"async": true` to every hook command entry.
- Register `SessionStart` (journal reset) in `HOOK_EVENTS`.
- Bump `refreshInterval` back to 1 (no change) — latency is solved by async, not by
  slowing the render.

### `.claude/settings.local.json` (dev's live wiring)
- Mirror the cli changes (add `async: true`, add `SessionStart`). This is the dev's live
  statusbar; update carefully (a broken no-matcher PreToolUse hook blocks all tools).

## Test plan

- `hook-tasks.test.mjs` — re-point `foldActivity` import to `src/fold.js`; assertions
  unchanged (reducer is identical).
- `e2e-tasks.test.mjs`, `statusline-tasks.test.mjs` — inject the **checkpoint** (same
  folded shape as today's state file) with an empty/absent journal; renders unchanged.
- New `test/journal.test.mjs`:
  - hook appends a parseable line per event; never does RMW; exit 0 on garbage stdin.
  - statusline folds journal -> checkpoint; offset advances to EOF.
  - **multi-hour skip**: pre-seed a large journal + checkpoint offset near EOF; assert the
    next render reads only the tail (offset jumps, old events not re-folded — assert via a
    sentinel that an old event before the offset does NOT affect state).
  - partial last line tolerated (no newline) — folded on the next tick.
  - concurrent-render idempotence: folding the same range twice yields the same state.
  - **out-of-order batch**: `SubagentStop` line before its `SubagentStart` in the same
    batch → after ts-sort, no ghost agent survives (squad empty).
  - **checkpoint corruption → full recompute, no double-count**: a garbage checkpoint
    resets to empty state + offset 0; geiger/errors match a clean single fold (assert
    `errors` and span count are not doubled).
- New `test/git-event.test.mjs`: hook computes git on a write event within TTL once;
  statusline folds `state.git` and `buildValues` emits `git.branch` / `git.work`.
- `smoke.test.mjs`, `installer.test.mjs` — update installer expectations (async field,
  SessionStart present).

## Open questions / decisions

1. git-TTL tracking in an append-only hook: cheapest is a tiny per-session marker file
   (`mugshot_git_<sid>.ts`) the hook stamps; or read the journal tail for the last git ts.
   Lean toward the marker (O(1), no journal read in the hook).
2. `SessionStart` is the chosen reset point. Confirm Claude Code fires it once per session
   before other events (it does per docs); fallback: also reset when checkpoint is absent.
3. Does `PreToolUse` honor `async: true`? Docs treat `async` as a general command-hook
   field; verify empirically once wired. If it refuses, `PreToolUse` stays blocking but is
   now trivial (append one line, ~35 ms) — still a big win.

## Out of scope

- Daemon / persistent hook process. The journal composes with a future daemon (it could
  tail the journal or replace the fold), and the daemon could be invoked async too — but
  not now. Ceiling of any per-event approach is the ~80 ms ESET spawn floor regardless.
```
