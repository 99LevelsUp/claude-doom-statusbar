// A session's metric values in the raw form the metric producers emit (src/metrics/catalogue.js):
// numbers as numbers, links as { text, url }, names where icons used to be. For tests that draw skins.

export const RAW_SAMPLE = Object.freeze({
  "model.name": "Opus 4.8", "model.effort": "high", "advisor.model": "Opus 4.8",
  "model.window": "1M", "model.mode": [["thinking", "on"], ["fast", "off"]], "model.permission": "auto", "model.style": "default",
  "usage.reset5h": "2h13m", "usage.reset7d": "3d4h", "sys.session": "5h55m", "loc.churn": "+185 / -62",
  "context.hp": 78, "ratelimit.5h": 64, "ratelimit.7d": 31, "cost.total": "$1.83",
  "git.branch": { text: "main", url: null }, "git.behind": 2, "git.ahead": 3, "git.status": 3,
  "git.work": [["changed", 3], ["behind", 2], ["ahead", 3]], "session.name": "doom-hud-demo", "session.title": "doom-hud-demo",
  "pr.state": { text: "#1234", url: null }, "loc.cwd": { text: "claude-doom-statusbar", url: null }, "loc.added": 185, "loc.removed": 62,
  "act.subagents": [["hook events", "2m13s"], ["find configs", "12s"]], "act.agents": 2,
  "act.tasklist": [
    { status: "completed", text: "scaffold project" },
    { status: "completed", text: "render engine" },
    { status: "deleted", text: "port PIL alpha" },
    { status: "in_progress", text: "statusline values" },
    { status: "pending", text: "hook bus" },
    { status: "pending", text: "installer" },
  ],
  "act.geiger": [0, 0.25, 0.5, 1, 0.75, 1, 0.5, 0.6, 0.3, 0.1, 0.4, 1, 0.8, 0.4],
  "act.tasks": "2/5", "act.errors": 0, "sys.ram": 47, "sys.cpu": 12,
  "sys.disk": 63, "sys.clock": "14:23", "sys.zombies": 3,
  "sys.cores": [0.12, 0.30, 0.08, 0.95, 0.45, 0.18, 0.62, 0.22],
  "save.leanctx": "8.3k 63%", "save.lingua": "1.2k 1.3x",
});
