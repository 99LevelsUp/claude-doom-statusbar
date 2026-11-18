// The metric catalogue: every key the metric producers emit (src/metrics), with a human name and
// the type of value it carries. A skin binds metrics by these ids, and a visual says which value
// types it can draw. A key a session does not report is absent from its values, never empty.
//
// Values are raw: no colours, icons or hyperlink escapes. Whatever draws a value owns how it looks.
//
// The value types, and the shape of a value of each:
//   percentage    a number from 0 to 100
//   number        a number
//   text          a string, or { text, url } for text that links somewhere (url null when it doesn't)
//   list          an array; each entry below says what its items are
//   timeseries    an array of numbers from 0 to 1, oldest first
//   conversation  a chat log; no producer emits one, a skin's script writes it

export const VALUE_TYPES = ["percentage", "number", "text", "list", "timeseries", "conversation"];

const m = (name, type) => ({ name, type });

export const CATALOGUE = {
  // The model and how it runs.
  "model.name": m("Model", "text"),
  "model.effort": m("Effort level (low, medium, high, xhigh, max)", "text"),
  "model.window": m("Context window size", "text"),
  // Items are [flag, state]: ["thinking", "on" | "off"], ["fast", "on" | "off"].
  "model.mode": m("Thinking and fast mode", "list"),
  "model.style": m("Output style", "text"),
  // The permission mode as Claude Code names it (plan, auto, acceptEdits, bypassPermissions);
  // absent in the default mode.
  "model.permission": m("Permission mode", "text"),
  "advisor.model": m("Advisor model", "text"),

  // Context, usage limits and cost.
  "context.hp": m("Context window used", "percentage"),
  "ratelimit.5h": m("5-hour usage limit used", "percentage"),
  "ratelimit.7d": m("7-day usage limit used", "percentage"),
  "usage.reset5h": m("Time until the 5-hour limit resets", "text"),
  "usage.reset7d": m("Time until the 7-day limit resets", "text"),
  "health.headroom": m("Usage headroom left", "percentage"),
  "cost.total": m("Session cost in US dollars", "text"),

  // The session and where it works.
  "session.name": m("Session name, or its id when unnamed", "text"),
  "session.title": m("Session name", "text"),
  "sys.session": m("Session duration", "text"),
  "loc.cwd": m("Project folder", "text"),
  "loc.churn": m("Lines added and removed", "text"),
  "loc.added": m("Lines added", "number"),
  "loc.removed": m("Lines removed", "number"),
  "git.branch": m("Git branch", "text"),
  "git.status": m("Changed files", "number"),
  "git.behind": m("Commits behind upstream", "number"),
  "git.ahead": m("Commits ahead of upstream", "number"),
  // Items are [part, count]: ["changed", files] when the status is known, then ["behind", n] and
  // ["ahead", n] when the upstream is.
  "git.work": m("Changed files and commits to pull or push", "list"),
  "pr.state": m("Pull request", "text"),

  // What the session is doing.
  "act.geiger": m("Tool activity over the last 30 seconds", "timeseries"),
  "act.agents": m("Running subagents", "number"),
  // Items are [description, running time].
  "act.subagents": m("Running subagents and their time", "list"),
  "act.tasks": m("Tasks done of all tasks", "text"),
  // Items are { status, text }, status one of completed, deleted, in_progress, pending.
  "act.tasklist": m("Task list", "list"),
  "act.errors": m("Failed tool calls", "number"),

  // The machine.
  "sys.ram": m("Memory used", "percentage"),
  "sys.cpu": m("CPU used", "percentage"),
  // Items are each core's use, from 0 to 1.
  "sys.cores": m("CPU use per core", "list"),
  "sys.disk": m("Disk used", "percentage"),
  "sys.clock": m("Clock", "text"),
  "sys.zombies": m("Live bash processes (Windows)", "number"),

  // Tokens saved by context tools.
  "save.leanctx": m("Tokens saved by lean-ctx", "text"),
  "save.lingua": m("Tokens saved by LLMLingua", "text"),
};
