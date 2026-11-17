// Activity values from the folded session state: permission mode, the geiger counter, the
// subagent and task lists, errors and the MSYS bash-flood gauge. Raw, like every metric value
// (see src/metrics/catalogue.js): names and counts, no icons or colours.

import { TASK_LINGER } from "../platform/journal.js";
import { clip, _dur } from "./session.js";

const GEIGER_WINDOW = 30.0; // must match the hook's window
const GEIGER_BINS = 14;
const TASK_TEXT_CLIP = 60;

const PERM_MODES = new Set(["plan", "auto", "acceptEdits", "bypassPermissions"]);
const TASK_ORDER = { completed: 0, deleted: 0, in_progress: 1, pending: 2 };

export function activityValues(st, now) {
  const v = {};
  if (PERM_MODES.has(st.mode)) v["model.permission"] = st.mode;
  if ("spans" in st) {
    const binw = GEIGER_WINDOW / GEIGER_BINS;
    const start0 = now - GEIGER_WINDOW;
    const series = new Array(GEIGER_BINS).fill(0);
    for (const [s0, e0] of st.spans) {
      let e = e0 === null ? now : e0;
      const s = Math.max(s0, start0);
      e = Math.min(e, now);
      if (e <= s) continue;
      const i0 = Math.max(0, Math.floor((s - start0) / binw));
      const i1 = Math.min(GEIGER_BINS - 1, Math.floor((e - start0) / binw - 1e-9));
      for (let i = i0; i <= i1; i++) {
        const bs = start0 + i * binw;
        series[i] += Math.min(e, bs + binw) - Math.max(s, bs);
      }
    }
    v["act.geiger"] = series.map((c) => Math.min(1.0, c / binw));
  }
  // AGENTS + TASKS boxes (and their ACTIVITY counts) are always shown, even empty.
  const squad = st.squad || {};
  v["act.agents"] = Object.keys(squad).length;
  const agents = Object.values(squad).sort((a, b) => a.start - b.start);
  // Clip generously (not 24): the box caps width and the label marquees, so a long
  // agent description should stay long enough to be worth scrolling through.
  v["act.subagents"] = agents.map((a) => [clip(a.desc || a.type || "agent", 60), _dur(now - a.start)]);

  const tasks = st.tasks && typeof st.tasks === "object" ? Object.values(st.tasks) : [];
  // done/total: done = completed, total = done + open (pending, in_progress); deleted tasks
  // count in neither. What is left to do is total - done.
  const open = tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length;
  const done = tasks.filter((t) => t.status === "completed").length;
  v["act.tasks"] = `${done}/${done + open}`;
  // The list shows while anything is open and for TASK_LINGER seconds after the last change;
  // then it empties, but the count above still covers every task of the session.
  const anyOpen = open > 0;
  const showList = anyOpen || now - (st.tasks_ts || 0) <= TASK_LINGER;
  const ordered = (showList ? tasks.filter((t) => !t.cleaned) : [])
    .map((t) => ({ ...t }))
    .sort((a, b) => (TASK_ORDER[a.status] - TASK_ORDER[b.status]) || (a.ts - b.ts));
  v["act.tasklist"] = ordered.map((t) => ({ status: t.status, text: clip(t.title, TASK_TEXT_CLIP) }));

  if ("errors" in st) v["act.errors"] = Number(st.errors);
  // MSYS bash-flood gauge: live bash.exe count the async hook snapshotted (win32 only). The
  // preset colours it by threshold so a forming "zombie horde" reds out before add_item bites.
  if (st.msys && typeof st.msys.n === "number") v["sys.zombies"] = st.msys.n;
  return v;
}
