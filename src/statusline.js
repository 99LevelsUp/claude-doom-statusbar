#!/usr/bin/env node
// Claude Code statusLine — the live DOOM HUD wired to real session data.
// Port of statusline.py. Reads the statusline JSON on stdin, fills metric values
// (+ git via shell, system metrics, the hook state file, the advisor transcript),
// picks the mugshot, and renders a preset.
//
// settings.json:
//   "statusLine": { "type": "command",
//       "command": "node /abs/path/src/statusline.js", "refreshInterval": 1 }
// Config: $DOOMBAR_PRESET (default presets/default.toml)  State: $MUGSHOT_STATE

import {
  readFileSync, writeFileSync, openSync, fstatSync, readSync, closeSync, statfsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { pyround, sgrFg } from "./ansi.js";
import { buildBar, setValues, OK, TEXT, CRIT } from "./render.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const TMP = os.tmpdir();

const DECAY = 1.5; // seconds a reaction holds before relaxing to idle
const IDLE_CYCLE = 2; // seconds per idle glance
const GOD_FLASH = 3.0; // seconds the mugshot stays god after an advisor consult lands
const GEIGER_WINDOW = 30.0; // must match the hook's window
const GEIGER_BINS = 14;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

function git(cwd, ...args) {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1000 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

// Clip a display label to at most `n` code points, ending with … when truncated,
// so an oversized repo or branch name can't blow up the PROJECT box width.
const clip = (s, n) => ([...String(s)].length > n ? [...String(s)].slice(0, n - 1).join("") + "…" : String(s));

// Human-readable token count: 8263 -> "8.3k", 1200000 -> "1.2M", 512 -> "512".
// Lowercase k/M — the savings rows read softer than model.window's uppercase K/M.
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);

function _dur(secsF) {
  let secs = Math.max(0, Math.trunc(secsF));
  const d = Math.floor(secs / 86400); secs %= 86400;
  const h = Math.floor(secs / 3600); secs %= 3600;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

function _link(text, url) {
  return url ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

function _prettyModel(mid) {
  mid = mid.replace(/\[.*?\]$/, "").replace("claude-", "");
  const parts = mid.split("-");
  return parts.length ? `${parts[0][0].toUpperCase()}${parts[0].slice(1)} ${parts.slice(1).join(".")}`.trim() : mid;
}

function advisorInfo(p) {
  let chunk;
  try {
    const fd = openSync(p, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 65536);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    chunk = buf.toString("utf8");
  } catch {
    return [null, null];
  }
  let model = null, resTs = null;
  for (const ln of chunk.split("\n")) {
    if (!ln.includes("advisorModel") && !ln.includes("advisor_tool_result")) continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; }
    if (o.advisorModel) model = o.advisorModel; // last wins
    const c = (o.message || {}).content;
    if (Array.isArray(c) && c.some((b) => b.type === "advisor_tool_result")) resTs = o.timestamp || resTs;
  }
  return [model ? _prettyModel(model) : null, resTs];
}

function godFlash(data, advTs, now) {
  const sid = String(data.session_id || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  const cache = path.join(TMP, `mugshot_adv_${sid}.json`);
  let c = {};
  try { c = JSON.parse(readFileSync(cache, "utf8")); } catch { c = {}; }
  if (advTs && advTs !== c.seen) {
    if ("seen" in c) c.god_until = now + GOD_FLASH; // not the first scan -> a fresh consult
    c.seen = advTs;
    try { writeFileSync(cache, JSON.stringify(c)); } catch { /* ignore */ }
  }
  return c.god_until || 0;
}

const f = sgrFg;

export function buildValues(data) {
  const v = {};
  const cw = data.context_window || {};
  if ("used_percentage" in cw) v["context.hp"] = pyround(cw.used_percentage);
  const rl = data.rate_limits || {};
  if (rl.five_hour) v["ratelimit.5h"] = pyround(rl.five_hour.used_percentage);
  if (rl.seven_day) v["ratelimit.7d"] = pyround(rl.seven_day.used_percentage);
  if (rl.five_hour && rl.five_hour.resets_at) v["usage.reset5h"] = _dur(rl.five_hour.resets_at - Date.now() / 1000);
  if (rl.seven_day && rl.seven_day.resets_at) v["usage.reset7d"] = _dur(rl.seven_day.resets_at - Date.now() / 1000);
  const cost = data.cost || {};
  if ("total_cost_usd" in cost) v["cost.total"] = "$" + cost.total_cost_usd.toFixed(2);
  if ("total_duration_ms" in cost) v["sys.session"] = _dur(cost.total_duration_ms / 1000);
  if ("total_lines_added" in cost || "total_lines_removed" in cost) {
    const a = cost.total_lines_added || 0, r = cost.total_lines_removed || 0;
    v["loc.churn"] = `${f(OK)}+${a}${f(TEXT)} / ${f(CRIT)}-${r}`;
  }

  const m = data.model || {};
  if (m.display_name) v["model.name"] = m.display_name.split(" (")[0];
  const eff = (data.effort || {}).level;
  if (eff) {
    const icon = { low: "🌒", medium: "🌓", high: "🌔", xhigh: "🌕", max: "🌞" };
    v["model.effort"] = icon[eff] || "🌓";
  }
  const cwm = (data.context_window || {}).context_window_size;
  if (cwm) v["model.window"] = cwm >= 1000000 ? `${Math.floor(cwm / 1000000)}M` : `${Math.floor(cwm / 1000)}K`;
  const th = data.thinking || {};
  const mode = [];
  if ("enabled" in th) mode.push(`💭 ${th.enabled ? "on" : "off"}`);
  if ("fast_mode" in data) mode.push(`🚀 ${data.fast_mode ? "on" : "off"}`);
  if (mode.length) v["model.mode"] = mode.join("  ");
  const style = (data.output_style || {}).name;
  if (style) v["model.style"] = style;

  const repo = (data.workspace || {}).repo || {};
  let repoUrl = "";
  if (repo.host && repo.owner && repo.name) repoUrl = `https://${repo.host}/${repo.owner}/${repo.name}`;

  const sname = data.session_name || data.session_id; // session_name only set via /rename or --name
  if (sname) v["session.name"] = clip(sname, 24);

  const cwd = data.cwd || (data.workspace || {}).current_dir;
  if (cwd) {
    const name = clip(path.basename(cwd.replace(/[/\\]+$/, "")) || cwd, 24);
    try { v["loc.cwd"] = _link(name, pathToFileURL(cwd).href); } catch { v["loc.cwd"] = name; }
    const br = git(cwd, "branch", "--show-current");
    if (br) { const brLbl = clip(br, 24); v["git.branch"] = repoUrl ? _link(brLbl, `${repoUrl}/tree/${br}`) : brLbl; }
    const lr = git(cwd, "rev-list", "--count", "--left-right", "@{u}...HEAD");
    if (lr && lr.includes("\t")) {
      const [behind, ahead] = lr.split("\t");
      v["git.behind"] = `↓${behind}`; v["git.ahead"] = `↑${ahead}`;
    }
    const st = git(cwd, "status", "--porcelain");
    if (st !== null) v["git.status"] = String(st.split("\n").filter((l) => l.trim()).length);
    // Merge changed-file count + pull/push onto one line (icons baked in, like model.mode):
    // "✎ <files>  ⇅ ↓<behind> ↑<ahead>" — files first, then pull/push.
    const work = [];
    if (v["git.status"] !== undefined) work.push(`✎ ${v["git.status"]}`);
    if (v["git.behind"] !== undefined) work.push(`⇅ ${v["git.behind"]} ${v["git.ahead"]}`);
    if (work.length) v["git.work"] = work.join("  ");
  }

  const pr = data.pr || {};
  if (pr.number || pr.url) {
    const label = pr.number ? `#${pr.number}` : pr.review_state || "PR";
    v["pr.state"] = _link(label, pr.url);
  }
  return v;
}

function _pick(bucket) {
  let x = Math.imul(bucket, 0x9e3779b1) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x85ebca77) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return x % 3;
}

function statePath(data) {
  if (process.env.MUGSHOT_STATE) return process.env.MUGSHOT_STATE;
  const sid = String(data.session_id || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  return path.join(TMP, `mugshot_${sid}.json`);
}

function readState(data) {
  try { return JSON.parse(readFileSync(statePath(data), "utf8")); } catch { return {}; }
}

function ramPercent() {
  try { return pyround((1 - os.freemem() / os.totalmem()) * 100); } catch { return null; }
}

function cpuPercent() {
  let total = 0, idle = 0;
  try {
    for (const c of os.cpus()) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
  } catch { return null; }
  const cache = path.join(TMP, "mugshot_cpu.json");
  let prev = null;
  try { prev = JSON.parse(readFileSync(cache, "utf8")); } catch { /* none */ }
  try { writeFileSync(cache, JSON.stringify({ total, idle })); } catch { /* ignore */ }
  if (!prev) return null;
  const dt = total - prev.total, di = idle - prev.idle;
  return dt > 0 ? pyround(Math.max(0, Math.min(100, 100 * (1 - di / dt)))) : null;
}

function sysValues(cwd) {
  const v = {};
  const ram = ramPercent();
  if (ram !== null) v["sys.ram"] = ram;
  const cpu = cpuPercent();
  if (cpu !== null) v["sys.cpu"] = `${cpu}%`;
  try {
    const stat = statfsSync(cwd || process.cwd());
    v["sys.disk"] = pyround(((stat.blocks - stat.bfree) / stat.blocks) * 100);
  } catch { /* ignore */ }
  const d = new Date();
  v["sys.clock"] = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return v;
}

// Token-savings rows read from the small JSON files context-optimization tools already
// persist. No plugin patching, no binary spawn — just a cheap read each refresh. Paths are
// env-overridable (DOOMBAR_*) so tests can point at fixtures, mirroring statePath/MUGSHOT_STATE.
const leanCtxPath = () => process.env.DOOMBAR_LEANCTX || path.join(os.homedir(), ".lean-ctx", "mcp-live.json");
const llmlinguaPath = () => process.env.DOOMBAR_LLMLINGUA || path.join(os.homedir(), ".llmlingua-stats.json");

// Defensive read: missing file or malformed JSON -> null (the row simply never appears).
function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// One entry per savings source; extract returns the display string or null (omit the row).
// Adding a source later is one entry here plus one preset line — not an adapter framework.
const SAVINGS_SOURCES = [
  {
    key: "save.leanctx",
    path: leanCtxPath,
    extract: (d) => {
      if (!(d.tokens_saved > 0)) return null;
      // compression_rate is a 0-100 percentage (verified against historical data).
      // Round it — a fractional value would render "63.45%" and shift the box width.
      return typeof d.compression_rate === "number"
        ? `${k(d.tokens_saved)} ${Math.round(d.compression_rate)}%`
        : k(d.tokens_saved);
    },
  },
  {
    key: "save.lingua",
    path: llmlinguaPath,
    extract: (d) => {
      // Prefer the nested session schema (smart-read). The flat lifetime-only shape
      // (llmlingua_logged.py: tokens_saved_total, no session) is absent for the session view.
      const s = d.session;
      if (!s || !(s.tokens_saved > 0)) return null;
      // Round/clamp the secondary figure so a many-decimal value can't shift box width.
      if (s.last_saved_pct != null) return `${k(s.tokens_saved)} ${Math.round(s.last_saved_pct)}%`;
      // No original-token count in the session block, so a percent isn't derivable; show the ratio.
      if (s.last_ratio != null) return `${k(s.tokens_saved)} ${Number(s.last_ratio).toFixed(1)}x`;
      return k(s.tokens_saved);
    },
  },
];

export function statsValues() {
  const v = {};
  for (const src of SAVINGS_SOURCES) {
    const data = readJson(src.path());
    if (!data) continue;
    const out = src.extract(data);
    if (out) v[src.key] = out; // omit on null/zero -> render.js available() drops the row
  }
  return v;
}

const PERM = { plan: "📋 plan", auto: "⏩ auto", acceptEdits: "⏩ auto", bypassPermissions: "⏩ bypass" };
const OK_RGB = [96, 200, 104];   // matches render.js OK (done, green)
const CRIT_RGB = [224, 84, 64];  // matches render.js CRIT (deleted, red)
const TASK_MARK = { completed: ["✅", OK_RGB], deleted: ["❌", CRIT_RGB], in_progress: ["⏩", null], pending: ["🎯", null] };
const TASK_ORDER = { completed: 0, deleted: 0, in_progress: 1, pending: 2 }; // settled (done+deleted, by time) first, then open

export function activityValues(st, now) {
  const v = {};
  if (PERM[st.mode]) v["model.permission"] = PERM[st.mode];
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
  v["act.agents"] = String(Object.keys(squad).length);
  const agents = Object.values(squad).sort((a, b) => a.start - b.start);
  v["act.subagents"] = agents.map((a) => [clip(a.desc || a.type || "agent", 24), _dur(now - a.start)]);

  const tasks = st.tasks && typeof st.tasks === "object" ? Object.values(st.tasks) : [];
  const live = tasks.filter((t) => t.status !== "deleted");
  const done = live.filter((t) => t.status === "completed").length;
  v["act.tasks"] = `${done}/${live.length}`;
  const ordered = tasks
    .map((t) => ({ ...t }))
    .sort((a, b) => (TASK_ORDER[a.status] - TASK_ORDER[b.status]) || (a.ts - b.ts));
  v["act.tasklist"] = ordered.map((t) => {
    const [mark, markRgb] = TASK_MARK[t.status] || ["🎯", null];
    return { mark, markRgb, text: clip(t.title, 24) };
  });

  if ("errors" in st) v["act.errors"] = String(st.errors);
  return v;
}

function main() {
  let data = {};
  try { data = JSON.parse(readFileSync(0, "utf8")); } catch { data = {}; }

  const preset = process.env.DOOMBAR_PRESET || path.join(REPO, "presets", "default.toml");
  const cfg = parseToml(readFileSync(preset, "utf8"));

  const now = Date.now() / 1000;
  const st = readState(data);
  const cwd = data.cwd || (data.workspace || {}).current_dir;
  const values = { ...buildValues(data), ...activityValues(st, now), ...sysValues(cwd), ...statsValues() };
  const [advModel, advTs] = advisorInfo(data.transcript_path || "");
  if (advModel) values["advisor.model"] = advModel;
  const god_until = godFlash(data, advTs, now);
  setValues(values);

  let exhausted;
  if ("ratelimit.5h" in values || "ratelimit.7d" in values) {
    const rem = Math.min(
      100 - (values["ratelimit.5h"] || 0),
      "ratelimit.7d" in values ? 100 - values["ratelimit.7d"] : 100,
    );
    exhausted = rem <= 0;
  } else {
    exhausted = (values["context.hp"] || 0) >= 99;
  }

  const spriteFor = (hp) => {
    if (exhausted) return "STFDEAD0";
    if (now < god_until) return "STFGOD0";
    if (st.expr && now - (st.ts || 0) < DECAY) {
      const map = {
        ouch: `STFOUCH${hp}`, kill: `STFKILL${hp}`, evl: `STFEVL${hp}`,
        tl: `STFTL${hp}0`, tr: `STFTR${hp}0`,
      };
      return map[st.expr] || `STFST${hp}1`;
    }
    return `STFST${hp}${_pick(Math.floor(now / IDLE_CYCLE))}`;
  };

  const target = parseInt(process.env.COLUMNS || "100", 10);
  const res = buildBar(cfg, target, spriteFor);
  process.stdout.write(res.lines.join("\n") + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
