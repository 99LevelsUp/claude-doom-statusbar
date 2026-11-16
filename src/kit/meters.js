// Colours the bar's visuals share: colour stops and interpolation, "#rrggbb" specs, and the
// background escape of a surface.

import { TERM_RGB, TEXT, OK, CRIT, sgrFg, sgrBg } from "./ansi.js";

const WARN = [224, 184, 64];

const f = sgrFg;

// Default heat gradient: green (0) -> yellow (50) -> red (100). Higher = hotter,
// the orientation every caller wants (context usage, rate limits, CPU, disk, RAM).
const DEFAULT_STOPS = [[0, OK], [50, WARN], [100, CRIT]];

const lerp1 = (a, b, t) => Math.round(a + (b - a) * t);

// Interpolate an RGB colour at `pct` (0..100) across sorted [value, rgb] stops.
// Below the first stop / above the last it clamps to that stop. A single stop is a
// solid colour; adjacent stops (e.g. 50 then 51) make a near-hard transition.
function interpStops(stops, pct) {
  if (pct <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (pct >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [v0, c0] = stops[i - 1], [v1, c1] = stops[i];
    if (pct <= v1) {
      const t = v1 === v0 ? 0 : (pct - v0) / (v1 - v0);
      return [0, 1, 2].map((j) => lerp1(c0[j], c1[j], t));
    }
  }
  return last[1];
}

// Resolve a metric's `color` spec to an RGB at `pct` (0..100):
//   "threshold"        -> the default green->yellow->red gradient
//   [[v, "#hex"], ...] -> a custom gradient (a single pair = a solid colour)
//   "#rrggbb"          -> a solid colour
//   unset / unknown    -> null, so the caller can pick its own default
export function colorFor(spec, pct) {
  if (spec === "threshold") return interpStops(DEFAULT_STOPS, pct);
  if (Array.isArray(spec) && spec.length) {
    const stops = spec.map(([v, c]) => [v, rgbOf(c)]).sort((a, b) => a[0] - b[0]);
    return interpStops(stops, pct);
  }
  if (typeof spec === "string" && spec.startsWith("#")) return rgbOf(spec);
  return null;
}

export function rgbOf(spec) {
  if (typeof spec === "string" && spec.startsWith("#")) {
    return [1, 3, 5].map((i) => parseInt(spec.slice(i, i + 2), 16));
  }
  return TERM_RGB; // term-bg / term-fg approximated for blends
}

export const isTerm = (rgb) => rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0;

export function bgsgrBox(boxRgb) {
  return isTerm(boxRgb) ? "\x1b[49m" : sgrBg(boxRgb);
}

// --- the presented form the old hotbar layout draws (temporary) ---------------------------------
// Metric values are raw (src/metrics/catalogue.js). The hotbar layout was written for values that
// carried their own presentation: hyperlink escapes, icons, colours and numbers as strings.
// legacyValues gives them that form back, so it draws exactly as before until a skin replaces it;
// it goes with it. A value already in the presented form passes unchanged,
// except plain churn text ("+185 / -62"), which gains its colours.

const EFFORT_ICON = { low: "🌒", medium: "🌓", high: "🌔", xhigh: "🌕", max: "🌞" };
const MOONS = new Set(Object.values(EFFORT_ICON));
const PERM_LABEL = { plan: "📋 plan", auto: "⏩ auto", acceptEdits: "⏩ auto", bypassPermissions: "⏩ bypass" };
const MODE_ICON = { thinking: "💭", fast: "🚀" };
const TASK_MARK = { completed: ["✅", OK], deleted: ["❌", CRIT], in_progress: ["⏩", null], pending: ["🎯", null] };
const COUNTS = ["act.agents", "act.errors", "git.status", "loc.added", "sys.zombies"];
const LINKS = ["loc.cwd", "git.branch", "pr.state"];

const osc8 = ({ text, url }) => (url ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text);

export function legacyValues(values) {
  const v = { ...values };
  const isNum = (id) => typeof v[id] === "number";
  for (const id of LINKS) if (v[id] && typeof v[id] === "object" && typeof v[id].text === "string") v[id] = osc8(v[id]);
  for (const id of COUNTS) if (isNum(id)) v[id] = String(v[id]);
  if (isNum("sys.cpu")) v["sys.cpu"] = `${v["sys.cpu"]}%`;
  if (isNum("git.behind")) v["git.behind"] = `↓${v["git.behind"]}`;
  if (isNum("git.ahead")) v["git.ahead"] = `↑${v["git.ahead"]}`;

  const eff = v["model.effort"];
  if (typeof eff === "string" && !MOONS.has(eff)) {
    v["model.effort"] = EFFORT_ICON[eff] || "🌓";
    v["model.effort_level"] ??= eff; // the hotbar chat colours the model name by the level
  }
  if (PERM_LABEL[v["model.permission"]]) v["model.permission"] = PERM_LABEL[v["model.permission"]];
  if (Array.isArray(v["model.mode"])) {
    v["model.mode"] = v["model.mode"].map(([flag, state]) => `${MODE_ICON[flag] || flag} ${state}`).join("  ");
  }
  if (Array.isArray(v["git.work"])) {
    const w = Object.fromEntries(v["git.work"]);
    const parts = [];
    if ("changed" in w) parts.push(`✎ ${w.changed}`);
    if ("behind" in w) parts.push(`⇅ ↓${w.behind} ↑${w.ahead}`);
    v["git.work"] = parts.join("  ");
  }
  const churn = /^\+(\d+) \/ -(\d+)$/.exec(typeof v["loc.churn"] === "string" ? v["loc.churn"] : "");
  if (churn) v["loc.churn"] = `${f(OK)}+${churn[1]}${f(TEXT)} / ${f(CRIT)}-${churn[2]}`;
  if (Array.isArray(v["act.tasklist"])) {
    v["act.tasklist"] = v["act.tasklist"].map((t) => {
      if (!t || "mark" in t) return t;
      const [mark, markRgb] = TASK_MARK[t.status] || ["🎯", null];
      return { mark, markRgb, text: t.text };
    });
  }
  return v;
}
