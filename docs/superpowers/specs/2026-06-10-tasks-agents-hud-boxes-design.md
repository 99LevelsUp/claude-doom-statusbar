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
- **No hard limit of one `in_progress` at a time.** The Task\* system is multi-owner by design and the docs document no "exactly one in_progress" constraint (that was a soft TodoWrite convention, never tool-enforced). So we must handle **multiple concurrent `in_progress`** defensively: we anchor the window on the settled/open boundary, not on a single "current" task. In the common single-in_progress case it still lands mid-window because `in_progress` items sort first in the open group (just below the boundary).

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
  - **Open (bottom half) — "to do":** `in_progress` (`▶`) first, then `pending` (`🎯`); creation order within each status.
  - Boundary index `B = |settled|` (count of completed + deleted). Window `start = clamp(B − floor(H/2), 0, N − H)`, so the settled→open transition sits mid-window. `in_progress` items sort first in the open group, so they sit just below the boundary ≈ center.
  - The clamp encodes the full intended behavior (no separate cases needed):
    - `N ≤ H` (all fit) → `N − H ≤ 0` → `start = 0`: items **top-aligned**, no centering, trailing blank rows below.
    - `N > H` → window always full, **never blank rows inside**.
    - few settled (`B < H/2`) → `start = 0`: boundary/in_progress in the **upper half** (first task may sit on row 1).
    - few open (`open < H/2`) → `start = N − H`: boundary/in_progress in the **lower half** (last task on the last row).
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

**Revised (user request, 2026-06-10): AGENTS and TASKS boxes are ALWAYS shown, even empty.** The statusline always emits `act.subagents`, `act.tasklist`, `act.agents`, `act.tasks` — so the box frames and the ACTIVITY counts (`👹 0`, `🎯 0/0`) are always visible. There is no statusline-side hide/linger gate.

- **AGENTS:** always shown; agents drop out of the list as they stop (height-capped), box frame stays even at zero.
- **TASKS:** always shown. The hook still prunes the task map `TASK_LINGER` (**10 s**) after everything settles — so completed/deleted work clears the *list content* (back to an empty box) while the *box frame* remains. Within the linger the all-checked state is visible; after it the list empties but the box stays.

## Testing

- **hook:** `TaskCreated`/`TaskCompleted`/`TaskUpdate(status)` fold into the correct map; `act.tasks` count derived correctly; prune clears only when all-terminal past linger.
- **render (`scroll`):**
  - `anchor:"top"` — caps at `H`, shortens as items leave, `↓k` overflow.
  - `anchor:"boundary"` — settled-on-top reorder; boundary centered; clamp at edges (all settled / none settled); `N ≤ H` top-aligned with no centering; `N > H` no blank interior rows; **multiple concurrent `in_progress`** grouped first in the open half; `↑k`/`↓k` overflow; truncation; empty → hidden.
  - **neither box increases `totalRows`** (the core height-decoupling assertion).
- **smoke:** full HUD renders with a populated task map.

## Spike findings (Task 1, 2026-06-10)

Run in the live session (hook = `node src/hook.js`, counter version). Created 10 tasks, set one `in_progress`, deleted one (`TaskUpdate status:"deleted"`), via the session's own Task tools.

- **`TaskCreated` fires** — main hook state showed `tasks.created: 10` (9 tracking + 1 dummy). Path B accumulation is viable; `pending`→`completed` is the **confirmed, reliable** signal.
- **`TaskUpdate` (`status` enum) confirmed** as a tool: `pending | in_progress | completed | deleted` (from the tool schema).
- **`PostToolUse(TaskUpdate)` for `in_progress`/`deleted`: NOT yet verified.** A bulletproof capture hook added to `settings.local.json` mid-session **never fired** — newly-added hook entries are not activated without a session restart (existing entries are read from disk live; the *set* of entries is fixed at session start). So the capture couldn't observe the `TaskUpdate` payload.
- **Decision: proceed Path B.** Implement the `PostToolUse(TaskUpdate)` branch defensively (unit-tested with mock events). Live-verify `in_progress`/`deleted` in **Task 9** after the new hook is active (a restart happens naturally when the new code lands), reading the resulting task map from the state file. If it turns out `PostToolUse(TaskUpdate)` does not fire, the box degrades gracefully to 2-state (`pending`/`completed`); record that here if confirmed.
- **Path A (stdin task-list snapshot): not pursued.** Path B is sufficient and proven; per YAGNI we don't build the snapshot reader speculatively.

### Live confirmation (post-merge, 2026-06-10) — Path B fully validated

Verified in the live session after the new hook went active (hook command is read from disk live, so no restart was needed — the merge alone activated the new code):

- **`in_progress` CONFIRMED:** `TaskUpdate`→in_progress arrives via `PostToolUse(TaskUpdate).tool_input.status`; the state file showed `status:"in_progress"`. ✓
- **`deleted` CONFIRMED:** likewise `status:"deleted"` recorded. ✓ → **no stuck-box risk**: a deleted task leaves the open set, so the box clears on schedule.
- **Subject key:** the dedicated `TaskCreated` event's `task_title` is empty; the subject resolves through a defensive chain (`taskTitle(ev)` tries `task_title`/`task_subject`/`subject`/`title`/`tool_input.subject`). Live test rendered the real subject. ✓

The 4-state list (`✓`/`✗`/`▶`/`🎯`) and the delete path work against real Claude Code events, not just mocks.

## Risks / open items

- **Stale tasks if the spike fails both ways** (no `PostToolUse(TaskUpdate)` payload and no stdin snapshot): a `deleted` task can't be detected, so it lingers as `pending` and keeps the box open. Mitigation deferred to the Step 0 result; if we land here, the chosen fallback (snapshot vs. accept-staleness) gets recorded back here before coding the delete path.
- `TASK_LINGER = 10 s` is a proposed default, easy to tune.
- Ordering: settled group in creation order; open group sorts `in_progress` before `pending` (so the current work sits right under the boundary ≈ center), each in creation order within its status. `in_progress` is distinguished by glyph, not by a single fixed slot — there may be more than one.
