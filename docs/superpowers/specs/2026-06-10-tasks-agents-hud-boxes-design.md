# Design: AGENTS rename + live TASKS box

Date: 2026-06-10
Status: approved-pending-review

## Goal

Two HUD changes, driven by the ideation TODO "a TASKS box (live list, like SUBAGENTS)" (docs/ideation/2026-06-06, lines 637-641):

1. Rename the `SUBAGENTS` box to `AGENTS`.
2. Add a `TASKS` box that lists individual tasks with their status and checks them off live, scrolling within the available height instead of growing the HUD.

Both lists become height-capped (they no longer stretch the mugshot), sharing one new render mode.

## Background: how tasks reach us

The active task system in current Claude Code is the **Task\*** family (TodoWrite is deprecated/off by default since v2.1.142). Verified facts (via claude-code-guide against the docs):

- Dedicated hook events exist for **only two** transitions: `TaskCreated`, `TaskCompleted`.
- The full status enum is `pending` | `in_progress` | `completed` | `deleted`. There is **no** `skipped`/`cancelled` status.
- Tasks are added incrementally (`TaskCreate` per item). Removal is `TaskUpdate` with `status: "deleted"` — no `TaskDelete` tool.
- `in_progress` and `deleted` transitions fire **no dedicated hook event**. The only possible granular signal is a generic `PostToolUse` with `tool_name == "TaskUpdate"` carrying `{ taskId, status }` — **undocumented, must be verified empirically**.

### Step 0 — verification spike (blocks the 3-state / delete features)

Before building the richer behavior, empirically capture what actually arrives:

- Add a `PostToolUse` branch for `tool_name == "TaskUpdate"`; log `tool_input`.
- In a live session: create tasks, move one to `in_progress`, complete one, delete one.
- Also inspect the statusline **stdin** JSON for an authoritative task list (e.g. a `TaskList`-shaped field) usable as a ground-truth snapshot.

Outcomes drive the fallbacks:

| Spike result | `in_progress` (`▶`) | `deleted` (`✗`) | stale risk |
|---|---|---|---|
| `PostToolUse(TaskUpdate)` carries `{taskId,status}` | shown | task marked deleted, moves to settled group | none |
| not carried, but stdin has a task list snapshot | derived from snapshot | derived from snapshot | none |
| neither | fall back to 2 states (`✓`/`🎯`) | cannot detect granularly | open (see Risks) |

## Components

### 1. hook.js — accumulate a keyed task map

Replace the counter `st.tasks = { created, completed }` with a keyed map:

```
st.tasks = { [task_id]: { title, status, ts } }   // status ∈ pending|in_progress|completed|deleted
```

- `TaskCreated` → set `{ title: task_title, status: "pending", ts: now }`.
- `TaskCompleted` → set `status: "completed"`, refresh `ts`.
- `PostToolUse` with `tool_name == "TaskUpdate"` → if `tool_input.status` is a known value, set it (covers `in_progress` and `deleted`). Gated on the Step 0 result.
- Track `st.tasks_ts = now` on any task change (drives the linger timeout).
- Prune: when **all** tasks are terminal (`completed`/`deleted`) and `now - tasks_ts > TASK_LINGER`, clear the map so a later `TaskCreated` starts a fresh list (no resurrected old tasks).

Backward-compat for the ACTIVITY box: `act.tasks` (the `🎯 number`) is derived from the map as `${completed}/${open+completed}` (deleted excluded). ACTIVITY is otherwise unchanged.

### 2. statusline.js — build the list values

- `act.subagents` (AGENTS): unchanged data shape (`[type, runtime]` pairs).
- `act.tasklist` (TASKS): emit an ordered array of `{ glyph, color, title, status }` items, or omit the key entirely when the box should be hidden (see Visibility).

### 3. render.js — new `scroll` render mode

A height-capped list that does **not** contribute to `totalRows` (so neither box stretches the mugshot). Window height `H = totalRows − header`, set by the fixed boxes (PROJECT ≈ 6 rows + header), so in practice `H ≈ 6–7`.

Two anchor behaviors:

- **`anchor: "top"` (AGENTS):** show items from the top, up to `H`. No reordering, no boundary. As agents finish they drop out and the list shortens. Overflow shown compactly as `↓k` on the last visible row.
- **`anchor: "boundary"` (TASKS):** reorder into two groups, then center the boundary:
  - **Settled (top half) — "won't touch again":** `completed` (`✓`, green) and `deleted` (`✗`, red), in creation order.
  - **Open (bottom half) — "to do":** `in_progress` (`▶`) and `pending` (`🎯`), in creation order.
  - Boundary index `B = |settled|`. Window `start = clamp(B − floor(H/2), 0, N − H)`, so the settled→open transition sits mid-window.
  - Overflow shown compactly as `↑k` / `↓k` prefixed on the edge visible rows (no dedicated separator line — boundary is implicit in the glyph transition).

Shared `scroll` details:
- Long titles truncated to box width with `…`.
- Empty list → box hidden (unlike today's `list`, which never collapses).

Glyph/color legend:

| status | glyph | color |
|---|---|---|
| completed | `✓` | green |
| deleted | `✗` | red |
| in_progress | `▶` | default |
| pending | `🎯` | default |

### 4. presets/full.toml

- `SUBAGENTS` → title `AGENTS`; its metric switches to `render = "scroll"`, `anchor = "top"` (data id `act.subagents` unchanged).
- New `TASKS` box to the right of AGENTS (right-side order: ACTIVITY, AGENTS, TASKS, SYS):
  ```toml
  [[segment]]
  type  = "box"
  title = "TASKS"
  metric = [ { id = "act.tasklist", render = "scroll", anchor = "boundary" } ]
  ```
- TASKS header has **no count** (the count already lives in ACTIVITY's `🎯 act.tasks`).

## Visibility / lifecycle

- **AGENTS:** visible while `squad` is non-empty; agents drop out as they stop (current behavior, now height-capped).
- **TASKS:** visible while any task is **open** (`pending`/`in_progress`) OR `now − tasks_ts < TASK_LINGER`. Once everything is settled, the box lingers `TASK_LINGER` (proposed **10 s**) showing the all-checked state, then empties. The hook prune (above) clears the map at the same threshold.

## Testing

- **hook:** `TaskCreated`/`TaskCompleted`/`TaskUpdate(status)` fold into the correct map; `act.tasks` count derived correctly; prune clears only when all-terminal past linger.
- **render (`scroll`):**
  - `anchor:"top"` — caps at `H`, shortens as items leave, `↓k` overflow.
  - `anchor:"boundary"` — settled-on-top reorder; boundary centered; clamp at edges (all settled / none settled); `↑k`/`↓k` overflow; truncation; empty → hidden.
  - **neither box increases `totalRows`** (the core height-decoupling assertion).
- **smoke:** full HUD renders with a populated task map.

## Risks / open items

- **Stale tasks if the spike fails both ways** (no `PostToolUse(TaskUpdate)` payload and no stdin snapshot): a `deleted` task can't be detected, so it lingers as `pending` and keeps the box open. Mitigation deferred to the Step 0 result; if we land here, the chosen fallback (snapshot vs. accept-staleness) gets recorded back here before coding the delete path.
- `TASK_LINGER = 10 s` is a proposed default, easy to tune.
- Group-internal ordering is creation order; `in_progress` is distinguished by glyph, not by position.
