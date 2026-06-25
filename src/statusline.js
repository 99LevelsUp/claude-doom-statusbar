#!/usr/bin/env node
// Claude Code statusLine — the live DOOM HUD wired to real session data.
// Port of statusline.py. Reads the statusline JSON on stdin, fills metric values
// (+ git via shell, system metrics, the hook state file, the advisor transcript),
// picks the mugshot, and renders a preset.
//
// settings.json:
//   "statusLine": { "type": "command",
//       "command": "node /abs/path/src/statusline.js", "refreshInterval": 1 }
// Config: $DOOMBAR_PRESET (default presets/standard.toml)  State: $MUGSHOT_STATE

import {
  readFileSync, writeFileSync, renameSync, openSync, fstatSync, readSync, closeSync, statfsSync, statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import { pyround, sgrFg } from "./ansi.js";
import { buildBar, setValues, resolvePreset, OK, TEXT, CRIT } from "./render.js";
import { foldBatch, statePaths, sidKey } from "./fold.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const TMP = os.tmpdir();

const DECAY = 1.5; // seconds a reaction holds before relaxing to idle
const IDLE_CYCLE = 2; // seconds per idle glance
const GOD_FLASH = 3.0; // seconds the mugshot stays god after an advisor consult lands
const GEIGER_WINDOW = 30.0; // must match the hook's window
const GEIGER_BINS = 14;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

// git is no longer spawned here. The async hook snapshots it into the journal (see hook.js
// + fold.js); buildValues reads the folded snapshot from state.git. This keeps the render
// hot path spawn-free — the Windows MSYS "bash flood" cannot happen by construction.

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

export function buildValues(data, git) {
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
  // Clip generously, not to box width: the renderer fits each field to its box (marquee or
  // clip per text_overflow). A tight clip here would truncate before the renderer ever sees it.
  if (sname) v["session.name"] = clip(sname, 60);

  const cwd = data.cwd || (data.workspace || {}).current_dir;
  if (cwd) {
    const name = clip(path.basename(cwd.replace(/[/\\]+$/, "")) || cwd, 60);
    try { v["loc.cwd"] = _link(name, pathToFileURL(cwd).href); } catch { v["loc.cwd"] = name; }
    // git fields come from the folded snapshot the async hook wrote, not a live spawn.
    const { br = null, lr = null, st = null } = git || {};
    if (br) { const brLbl = clip(br, 60); v["git.branch"] = repoUrl ? _link(brLbl, `${repoUrl}/tree/${br}`) : brLbl; }
    if (lr && lr.includes("\t")) {
      const [behind, ahead] = lr.split("\t");
      v["git.behind"] = `↓${behind}`; v["git.ahead"] = `↑${ahead}`;
    }
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

// Fold the per-session journal into the checkpoint and return the folded state.
//
// Read cost is O(events since last render): we read only journal bytes past the stored
// offset, so a multi-hour session never re-reads old events. Invariant: checkpoint.state
// always equals fold(journal[0..offset]); state + offset are persisted together atomically,
// so the reducer's push/increment ops never double-count across renders.
export function loadState(data) {
  const { checkpoint, journal } = statePaths(data.session_id);

  let size = -1;
  try { size = statSync(journal).size; } catch { /* no journal yet */ }

  let raw = null;
  try { raw = readFileSync(checkpoint, "utf8"); } catch { /* no checkpoint */ }
  let st;
  if (raw === null) {
    st = { offset: 0 };                          // no checkpoint -> recompute from journal start
  } else {
    try { st = JSON.parse(raw); } catch { st = null; }
    if (!st || typeof st !== "object") st = { offset: 0 }; // corrupt -> full recompute (journal has full history)
    else if (typeof st.offset !== "number") st.offset = Math.max(0, size); // externally-supplied state is current
  }

  if (size < 0) return st;                        // no journal -> state stands as-is
  if (st.offset > size) st = { offset: 0 };       // journal truncated/reset -> recompute from 0

  if (size > st.offset) {
    let chunk = "";
    try {
      const fd = openSync(journal, "r");
      const buf = Buffer.alloc(size - st.offset);
      readSync(fd, buf, 0, buf.length, st.offset);
      closeSync(fd);
      chunk = buf.toString("utf8");
    } catch { chunk = ""; }
    const lastNl = chunk.lastIndexOf("\n");       // consume complete lines only; keep any partial tail
    if (lastNl >= 0) {
      foldBatch(st, chunk.slice(0, lastNl).split("\n"));
      st.offset += Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8");
    }
  }

  try { // persist state + offset together, atomically
    const tmp = `${checkpoint}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(st));
    renameSync(tmp, checkpoint);
  } catch { /* ignore: next render retries */ }
  return st;
}

function ramPercent() {
  try { return pyround((1 - os.freemem() / os.totalmem()) * 100); } catch { return null; }
}

// Minimum interval between CPU snapshots; below this, per-core deltas are tick-quantised noise.
const CPU_MIN_MS = 1000;

// Pure: should cpuMetrics recompute, or hold the cached result? Recompute on cold start,
// a legacy snapshot without `ts`, a missing cached result, or once CPU_MIN_MS has elapsed.
// Holding in between keeps a burst of fast refreshes from sampling a sub-tick interval.
export function shouldSampleCpu(prev, now) {
  return !(prev && typeof prev.ts === "number" && now - prev.ts < CPU_MIN_MS && prev.result);
}

// Per-core idle fraction over a cumulative-time delta; null when no time elapsed.
const cpuUtil = (dt, di) => (dt > 0 ? Math.max(0, Math.min(1, 1 - di / dt)) : null);

// Pure: turn two cumulative CPU snapshots into the aggregate percent (sys.cpu, 0..100)
// and the per-core utilisation array (sys.cores, 0..1 each). Cold start (no prev) or a
// core-count mismatch (e.g. an old cache without `cores`) yields null for that field, so
// the metric simply doesn't render that refresh. A core with no elapsed time reads 0.
export function cpuDeltas(prev, cur) {
  if (!prev) return { cpu: null, cores: null };
  const cpu = cpuUtil(cur.total - prev.total, cur.idle - prev.idle);
  let cores = null;
  if (Array.isArray(prev.cores) && Array.isArray(cur.cores) && prev.cores.length === cur.cores.length) {
    cores = cur.cores.map((c, i) => {
      const u = cpuUtil(c.total - prev.cores[i].total, c.idle - prev.cores[i].idle);
      return u === null ? 0 : u;
    });
  }
  return { cpu: cpu === null ? null : pyround(cpu * 100), cores };
}

function cpuMetrics() {
  let cores;
  try {
    cores = os.cpus().map((c) => {
      let total = 0; for (const k in c.times) total += c.times[k];
      return { total, idle: c.times.idle };
    });
  } catch { return { cpu: null, cores: null }; }
  const agg = cores.reduce((a, c) => ({ total: a.total + c.total, idle: a.idle + c.idle }), { total: 0, idle: 0 });
  const now = Date.now();
  const cur = { ts: now, total: agg.total, idle: agg.idle, cores };
  const cache = path.join(TMP, "mugshot_cpu.json");
  let prev = null;
  try { prev = JSON.parse(readFileSync(cache, "utf8")); } catch { /* none */ }
  // Windows updates os.cpus() times only on the ~15.6ms scheduler tick, so a per-core
  // delta over a sub-second interval is dominated by tick quantisation and explodes
  // into 0/100 noise. The status bar refreshes on every action, often milliseconds
  // apart -- so only recompute when >= CPU_MIN_MS has elapsed, holding the last result
  // (and the old snapshot) in between. The interval keeps growing until it's wide
  // enough to be stable, even under a burst of fast refreshes.
  if (!shouldSampleCpu(prev, now)) return prev.result;
  const result = cpuDeltas(prev, cur);
  try { writeFileSync(cache, JSON.stringify({ ...cur, result })); } catch { /* ignore */ }
  return result;
}

function sysValues(cwd) {
  const v = {};
  const ram = ramPercent();
  if (ram !== null) v["sys.ram"] = ram;
  const { cpu, cores } = cpuMetrics();
  if (cpu !== null) v["sys.cpu"] = `${cpu}%`;
  if (cores) v["sys.cores"] = cores;
  try {
    const stat = statfsSync(cwd || process.cwd());
    v["sys.disk"] = pyround(((stat.blocks - stat.bfree) / stat.blocks) * 100);
  } catch { /* ignore */ }
  const d = new Date();
  v["sys.clock"] = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return v;
}

// --- Token-savings rows -----------------------------------------------------
// Read from what context-optimization tools already persist on disk. No plugin
// patching, no binary spawn. Paths are env-overridable (DOOMBAR_*) for tests.
const eventsPath = () => process.env.DOOMBAR_EVENTS || path.join(os.homedir(), ".lean-ctx", "events.jsonl");
const llmlinguaPath = () => process.env.DOOMBAR_LLMLINGUA || path.join(os.homedir(), ".llmlingua-stats.json");

// Defensive read: missing file or malformed JSON -> null (the row simply never appears).
function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// Windows FS is case-insensitive, POSIX is not — only fold case on win32 to avoid
// false path matches (e.g. /home/User vs /home/user) on the platforms the npm package also runs on.
const normPath = (p) => {
  const s = String(p).replace(/\\/g, "/");
  return process.platform === "win32" ? s.toLowerCase() : s;
};

// "8.3k 63%" — saved + a per-session compression rate derived from accumulated totals.
function fmtSaved(st) {
  return st.original > 0 ? `${k(st.saved)} ${Math.round(100 * st.saved / st.original)}%` : k(st.saved);
}

const savingsStatePath = (sid) =>
  process.env.DOOMBAR_SAVINGS_STATE || path.join(TMP, `savings_${sid}.json`);

// Per-session lean-ctx savings. lean-ctx's mcp-live.json is a single global file clobbered
// by every concurrent session, so it can't be per-session. events.jsonl is append-only and
// each ToolCall carries the file path it compressed — so we sum tokens_saved over NEW events
// (tracked by byte offset) whose path is under the current cwd, accumulated across refreshes
// in a per-session state file keyed by session_id. The accumulator follows cwd changes (it
// keeps adding wherever you currently work) and stays cheap — it reads only the bytes appended
// since the last refresh, never the whole log. Residual: two sessions concurrently in the SAME
// project share events and both count them — unsplittable from disk, accepted.
function leanCtxSavings(cwd, sid) {
  if (!cwd) return null;
  const cwdN = normPath(cwd).replace(/\/+$/, "") + "/"; // match on a path boundary, not a prefix
  const sp = savingsStatePath(sid);
  let st = { offset: null, saved: 0, original: 0 };
  try { st = { ...st, ...JSON.parse(readFileSync(sp, "utf8")) }; } catch { /* fresh session */ }

  let size = -1;
  try { size = statSync(eventsPath()).size; } catch { /* no log */ }
  if (size < 0) return st.saved > 0 ? fmtSaved(st) : null; // log gone -> keep prior total

  if (st.offset === null) st.offset = size; // first sight of this session: count from now on
  // Log shrank -> lean-ctx rotated it (old events go to archives/, the restarted log holds only
  // NEW events). Keep the running total and re-read from 0: prior total + new events = correct.
  // (An in-place truncate-and-rewrite retaining old content would double-count, but an append-only
  // log doesn't do that.)
  if (st.offset > size) st.offset = 0;

  if (size > st.offset) {
    let chunk = "";
    try {
      const fd = openSync(eventsPath(), "r");
      const buf = Buffer.alloc(size - st.offset);
      readSync(fd, buf, 0, buf.length, st.offset);
      closeSync(fd);
      chunk = buf.toString("utf8");
    } catch { chunk = ""; }
    const lastNl = chunk.lastIndexOf("\n"); // consume complete lines only; keep any partial tail
    if (lastNl >= 0) {
      for (const ln of chunk.slice(0, lastNl).split("\n")) {
        if (!ln) continue;
        let o; try { o = JSON.parse(ln); } catch { continue; }
        const ev = o.kind;
        if (!ev || ev.type !== "ToolCall" || !ev.path) continue;
        if (!normPath(ev.path).startsWith(cwdN)) continue; // cwdN ends in "/" -> boundary-safe
        st.saved += ev.tokens_saved || 0;
        st.original += ev.tokens_original || 0;
      }
      st.offset += Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8");
    }
  }
  try { writeFileSync(sp, JSON.stringify(st)); } catch { /* ignore */ }
  return st.saved > 0 ? fmtSaved(st) : null;
}

// Per-session llmlingua. smart-read keys its sessions map by CLAUDE_CODE_SESSION_ID — the same
// id the statusbar gets on stdin — so we read sessions[sid] (not a single global block).
// Prefer last_saved_pct; else show the ratio. Flat lifetime-only writers expose no session -> absent.
function linguaSavings(sid) {
  const d = readJson(llmlinguaPath());
  const s = d && d.sessions && d.sessions[sid];
  if (!s || !(s.tokens_saved > 0)) return null;
  if (s.last_saved_pct != null) return `${k(s.tokens_saved)} ${Math.round(s.last_saved_pct)}%`;
  if (s.last_ratio != null) return `${k(s.tokens_saved)} ${Number(s.last_ratio).toFixed(1)}x`;
  return k(s.tokens_saved);
}

export function statsValues(data, cwd) {
  const v = {};
  const rawSid = String((data && data.session_id) || "default");
  const sid = rawSid.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48); // filesystem-safe state-file key
  const lean = leanCtxSavings(cwd, sid);
  if (lean) v["save.leanctx"] = lean;
  // smart-read keys sessions[] by the RAW CLAUDE_CODE_SESSION_ID -> look up with the unsanitized id.
  const ling = linguaSavings(rawSid);
  if (ling) v["save.lingua"] = ling;
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
  // Clip generously (not 24): the box caps width and the label marquees, so a long
  // agent description should stay long enough to be worth scrolling through.
  v["act.subagents"] = agents.map((a) => [clip(a.desc || a.type || "agent", 60), _dur(now - a.start)]);

  const tasks = st.tasks && typeof st.tasks === "object" ? Object.values(st.tasks) : [];
  const live = tasks.filter((t) => t.status !== "deleted");
  const done = live.filter((t) => t.status === "completed").length;
  v["act.tasks"] = `${done}/${live.length}`;
  const ordered = tasks
    .map((t) => ({ ...t }))
    .sort((a, b) => (TASK_ORDER[a.status] - TASK_ORDER[b.status]) || (a.ts - b.ts));
  v["act.tasklist"] = ordered.map((t) => {
    const [mark, markRgb] = TASK_MARK[t.status] || ["🎯", null];
    return { mark, markRgb, text: clip(t.title, 60) }; // generous clip: box width caps it, title marquees
  });

  if ("errors" in st) v["act.errors"] = String(st.errors);
  // MSYS bash-flood gauge: live bash.exe count the async hook snapshotted (win32 only). The
  // preset colours it by threshold so a forming "zombie horde" reds out before add_item bites.
  if (st.msys && typeof st.msys.n === "number") v["sys.zombies"] = String(st.msys.n);
  return v;
}

// --- Rate-based mugshot health -------------------------------------------------------------
// The face should track which rate-limit window you hit FIRST, not which is proportionally
// fullest. Anthropic exposes only used_percentage per window (no caps, no absolutes), so we
// derive time-to-exhaustion from the RATE at which each percentage climbs:
//
//   T_window = (100 - used%) / d(used%)/dt        // seconds until this window hits 100
//
// The absolute cap cancels — numerator and denominator are both in % of the SAME cap — so this
// needs no token counts and no knowledge of the subscription tier. The binding window is the
// smaller T; health is that runway normalised to one 5-hour clip (>= 5h runway reads as full
// health). A percentage DROP means the window rolled over / reset -> fresh budget -> healthy. A
// window that resets_at before it would exhaust never binds. Rate is averaged over RATE_WINDOW
// (cheap smoothing against per-response steps); below that we hold the last value, and with no
// baseline yet we return null so hpRow falls back to the snapshot metric.
const FIVE_HOURS_SEC = 5 * 3600;
const RATE_EPS = 1e-9;
const RATE_WINDOW = Number.isFinite(Number(process.env.DOOMBAR_RATE_WINDOW))
  ? Number(process.env.DOOMBAR_RATE_WINDOW)
  : 60; // seconds of consumption history per rate estimate

// Pure: prev baseline { p5, p7, ts, headroom } | null, cur { p5, p7, reset5, reset7 } (percents
// 0..100 or null; resets epoch seconds or null), now (epoch seconds). Returns the headroom
// (0..100, or null on cold start -> caller falls back) plus the baseline to persist.
export function rateHeadroom(prev, cur, now, window = RATE_WINDOW) {
  const fresh = { p5: cur.p5, p7: cur.p7, ts: now, headroom: null };
  if (!prev || typeof prev.ts !== "number") return { headroom: null, state: fresh };

  const dt = now - prev.ts;
  if (dt < window) return { headroom: prev.headroom ?? null, state: { ...prev } }; // hold

  // A percentage drop = the window rolled over / reset -> you just got fresh budget.
  const dropped = (cur.p5 != null && prev.p5 != null && cur.p5 < prev.p5) ||
                  (cur.p7 != null && prev.p7 != null && cur.p7 < prev.p7);
  if (dropped) return { headroom: 100, state: { p5: cur.p5, p7: cur.p7, ts: now, headroom: 100 } };

  const tte = (p, p0, resets) => {
    if (p == null || p0 == null) return Infinity;       // window absent -> not binding
    const r = (p - p0) / dt;                            // percentage-points per second (>= 0 here)
    if (r <= RATE_EPS) return Infinity;                 // not consuming -> not binding
    const t = (100 - p) / r;                            // seconds until this window hits 100%
    if (resets != null) {                               // resets before exhaustion -> never binds
      const untilReset = resets - now;
      if (untilReset > 0 && untilReset <= t) return Infinity;
    }
    return t;
  };

  const t = Math.min(tte(cur.p5, prev.p5, cur.reset5), tte(cur.p7, prev.p7, cur.reset7));
  const headroom = Number.isFinite(t) ? Math.max(0, Math.min(100, 100 * t / FIVE_HOURS_SEC)) : 100;
  return { headroom, state: { p5: cur.p5, p7: cur.p7, ts: now, headroom } };
}

// I/O wrapper: pull the rate-limit percentages from the statusline payload, fold the persisted
// baseline through rateHeadroom, persist the new baseline, and return the headroom (or null when
// there are no rate limits / still cold -> hpRow uses its snapshot fallback).
function rateHealthValue(data, now) {
  const rl = data.rate_limits || {};
  const f = rl.five_hour, s = rl.seven_day;
  const cur = {
    p5: f && "used_percentage" in f ? f.used_percentage : null,
    p7: s && "used_percentage" in s ? s.used_percentage : null,
    reset5: f && f.resets_at != null ? f.resets_at : null,
    reset7: s && s.resets_at != null ? s.resets_at : null,
  };
  if (cur.p5 == null && cur.p7 == null) return null; // no rate limits -> context fallback
  const file = path.join(TMP, `mugshot_ratehealth_${sidKey(data.session_id)}.json`);
  let prev = null;
  try { prev = JSON.parse(readFileSync(file, "utf8")); } catch { /* no baseline yet */ }
  const { headroom, state } = rateHeadroom(prev, cur, now);
  try { writeFileSync(file, JSON.stringify(state)); } catch { /* ignore */ }
  return headroom;
}

function main() {
  let data = {};
  try { data = JSON.parse(readFileSync(0, "utf8")); } catch { data = {}; }

  const preset = process.env.DOOMBAR_PRESET || path.join(REPO, "presets", "standard.toml");
  const cfg = parseToml(readFileSync(preset, "utf8"));

  const now = Date.now() / 1000;
  const st = loadState(data);
  const cwd = data.cwd || (data.workspace || {}).current_dir;
  const values = { ...buildValues(data, st.git), ...activityValues(st, now), ...sysValues(cwd), ...statsValues(data, cwd) };
  const [advModel, advTs] = advisorInfo(data.transcript_path || "");
  if (advModel) values["advisor.model"] = advModel;
  const god_until = godFlash(data, advTs, now);
  // Rate-based mugshot health: when present, hpRow prefers it over the snapshot headroom.
  const headroom = rateHealthValue(data, now);
  if (headroom !== null) values["health.headroom"] = headroom;
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
  const tick = Math.floor(now); // one marquee step per refresh (~1s); pure fn of time
  // Pick the preset that fits the terminal: the chosen preset is the ceiling; if it
  // (at its minimum scale) overflows COLUMNS, fall back down its [bar].fallback chain.
  // Sibling presets resolve relative to the chosen preset's directory.
  const presetDir = path.dirname(preset);
  const loadByName = (name) => {
    try { return parseToml(readFileSync(path.join(presetDir, `${name}.toml`), "utf8")); }
    catch { return null; }
  };
  const selected = resolvePreset(cfg, target, loadByName, spriteFor);
  // Text overflow behavior: env wins, then the preset's text_overflow, default "scroll".
  const overflow = process.env.DOOMBAR_TEXT_OVERFLOW || selected.text_overflow || cfg.text_overflow || "scroll";
  const res = buildBar(selected, target, spriteFor, tick, overflow);
  process.stdout.write(res.lines.join("\n") + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
