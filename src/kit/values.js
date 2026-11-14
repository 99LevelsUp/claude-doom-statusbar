// SAMPLE, the preview data: the metric values a render context carries when it is given none
// (the preview CLI, tests). A real render passes the session's own values (src/kit/context.js).

import { OK, CRIT } from "./ansi.js";

// Simulated metric values + availability (no live Claude Code data here).
export const SAMPLE = {
  "model.name": "Opus 4.8", "model.effort": "🌔", "advisor.model": "Opus 4.8",
  "model.window": "1M", "model.mode": "💭 on  🚀 off", "model.permission": "⏩ auto", "model.style": "default",
  "usage.reset5h": "2h13m", "usage.reset7d": "3d4h", "sys.session": "5h55m", "loc.churn": "+185 / -62",
  "context.hp": 78, "ratelimit.5h": 64, "ratelimit.7d": 31, "cost.total": "$1.83",
  "git.branch": "main", "git.behind": "↓2", "git.ahead": "↑3", "git.status": "3",
  "git.work": "✎ 3  ⇅ ↓2 ↑3", "session.name": "doom-hud-demo",
  "pr.state": "#1234", "loc.cwd": "claude-doom-statusbar",
  "act.subagents": [["hook events", "2m13s"], ["find configs", "12s"]], "act.agents": "2",
  "act.tasklist": [
    { mark:"✅", markRgb: OK, text:"scaffold project" },
    { mark:"✅", markRgb: OK, text:"render engine" },
    { mark:"❌", markRgb: CRIT, text:"port PIL alpha" },
    { mark:"⏩", markRgb: null, text:"statusline values" },
    { mark:"🎯", markRgb: null, text:"hook bus" },
    { mark:"🎯", markRgb: null, text:"installer" },
  ],
  "act.geiger": [0, .25, .5, 1, .75, 1, .5, .6, .3, .1, .4, 1, .8, .4],
  "act.tasks": "2/5", "act.errors": "0", "sys.ram": 47, "sys.cpu": "12%",
  "sys.disk": 63, "sys.clock": "14:23", "sys.zombies": "3",
  "sys.cores": [0.12, 0.30, 0.08, 0.95, 0.45, 0.18, 0.62, 0.22],

  "save.leanctx": "8.3k 63%", "save.lingua": "1.2k 1.3x",
};
