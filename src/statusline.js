#!/usr/bin/env node
// Claude Code statusLine — the live DOOM HUD wired to real session data.
// Port of statusline.py. Reads the statusline JSON on stdin, fills metric values
// (+ git via shell, system metrics, the hook state file, the advisor transcript),
// picks the mugshot, and renders a preset.
//
// settings.json:
//   "statusLine": { "type": "command",
//       "command": "node /abs/path/src/statusline.js", "refreshInterval": 1 }
// Config: $DOOMBAR_PRESET (default presets/standard.toml), or the theme picked with
// `claude-doom-statusbar theme` (see theme.js)  State: $MUGSHOT_STATE

import {
  readFileSync, writeFileSync, openSync, fstatSync, readSync, closeSync, statfsSync, statSync, readdirSync,
} from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import { pyround, sgrFg } from "./ansi.js";
import { buildBar, setValues, resolvePreset, rgbOf, OK, TEXT, CRIT } from "./render.js";
import { setFaceOptions } from "./face.js";
import { effectiveStep } from "./glyph-level.js";
import { foldBatch, statePaths, sessionPaths, writeAtomic, TASK_LINGER } from "./fold.js";
import { currentTheme, themePreset } from "./theme.js";
import { buildHotbar } from "./hotbar.js";

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
// + fold.js); buildValues reads the folded snapshot from state.git. The render path stays free of
// blocking spawns, so this process adds nothing to the Windows MSYS "bash flood".
//
// It does NOT make the flood impossible: on Windows Claude Code wraps this very command in
// Git Bash (statusLine has no exec form), so each render costs two MSYS inits before node even
// starts. That half is handled by the reaper — see maybeReap below and reapStaleShells in hook.js.

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

// Transcript path -> { key, info }: the result depends only on the file's content.
const advisorCache = new Map();

function advisorInfo(p) {
  let chunk, key;
  try {
    const fd = openSync(p, "r");
    const st = fstatSync(fd);
    key = `${st.size}:${st.mtimeMs}`;
    const hit = advisorCache.get(p);
    if (hit && hit.key === key) { closeSync(fd); return hit.info; }
    const size = st.size;
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
  const info = [model ? _prettyModel(model) : null, resTs];
  advisorCache.set(p, { key, info });
  return info;
}

function godFlash(data, advTs, now, env) {
  const cache = sessionPaths(data.session_id, undefined, env).adv;
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

export function buildValues(data, git, now = Date.now() / 1000) {
  const v = {};
  const cw = data.context_window || {};
  if ("used_percentage" in cw) v["context.hp"] = pyround(cw.used_percentage);
  const rl = data.rate_limits || {};
  if (rl.five_hour) v["ratelimit.5h"] = pyround(rl.five_hour.used_percentage);
  if (rl.seven_day) v["ratelimit.7d"] = pyround(rl.seven_day.used_percentage);
  if (rl.five_hour && rl.five_hour.resets_at) v["usage.reset5h"] = _dur(rl.five_hour.resets_at - now);
  if (rl.seven_day && rl.seven_day.resets_at) v["usage.reset7d"] = _dur(rl.seven_day.resets_at - now);
  const cost = data.cost || {};
  if ("total_cost_usd" in cost) v["cost.total"] = "$" + cost.total_cost_usd.toFixed(2);
  if ("total_duration_ms" in cost) v["sys.session"] = _dur(cost.total_duration_ms / 1000);
  if ("total_lines_added" in cost || "total_lines_removed" in cost) {
    const a = cost.total_lines_added || 0, r = cost.total_lines_removed || 0;
    v["loc.churn"] = `${f(OK)}+${a}${f(TEXT)} / ${f(CRIT)}-${r}`;
    v["loc.added"] = String(a); // plain number: fits (and centres in) a hotbar slot
  }

  const m = data.model || {};
  if (m.display_name) v["model.name"] = m.display_name.split(" (")[0];
  const eff = (data.effort || {}).level;
  if (eff) {
    const icon = { low: "🌒", medium: "🌓", high: "🌔", xhigh: "🌕", max: "🌞" };
    v["model.effort"] = icon[eff] || "🌓";
    v["model.effort_level"] = eff; // raw level: the hotbar chat colours the model name by it
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
  if (data.session_name) v["session.title"] = clip(data.session_name, 60); // a real name only, never the id

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

// Claude Code keeps each session's task list on disk (~/.claude/tasks/<list id>/<task id>.json),
// and that survives a reboot and `claude --resume`; our journal in the temp dir doesn't. The
// list id is CLAUDE_CODE_TASK_LIST_ID when set, otherwise the session id. DOOMBAR_TASKS_DIR
// overrides the whole directory (tests). Returns null when there is no list directory.
export function tasksDir(sessionId, env = process.env) {
  if (env.DOOMBAR_TASKS_DIR) return env.DOOMBAR_TASKS_DIR;
  const listId = env.CLAUDE_CODE_TASK_LIST_ID || sessionId;
  if (!listId) return null;
  const home = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(home, "tasks", String(listId));
}

export function readDiskTasks(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const out = {};
  for (const n of names) {
    if (!n.endsWith(".json") || n.startsWith(".")) continue;
    const f = path.join(dir, n);
    try {
      const t = JSON.parse(readFileSync(f, "utf8"));
      if (!t || typeof t !== "object") continue;
      const id = String(t.id ?? n.slice(0, -5));
      out[id] = { title: t.subject || t.title || "task", status: t.status || "pending", ts: statSync(f).mtimeMs / 1000 };
    } catch { /* half-written or foreign file: skip */ }
  }
  // Once every task is done, Claude Code deletes the task files and records the highest id it
  // handed out in .highwatermark (new tasks continue above it). Ids up to that mark with no
  // file were cleaned up as finished, so count them as completed; `cleaned` keeps them out of
  // the list, since their titles are gone. (A task deleted before the cleanup counts as done.)
  try {
    const f = path.join(dir, ".highwatermark");
    const hwm = Math.min(parseInt(readFileSync(f, "utf8").trim(), 10) || 0, 10000);
    const ts = statSync(f).mtimeMs / 1000;
    for (let i = 1; i <= hwm; i++) {
      if (!(String(i) in out)) out[String(i)] = { title: "task", status: "completed", ts, cleaned: true };
    }
  } catch { /* no cleanup yet */ }
  return out;
}

// Overlay the on-disk task list onto the folded state (a copy; the checkpoint is untouched).
// A task file's status wins. A task the journal saw deleted stays deleted. A cleaned-up task
// (see readDiskTasks) takes its title from the journal when the journal still has it, and
// shows in the list again. Journal tasks with no file are kept as the journal last saw them.
// From the journal we also keep the creation time, for a stable order. Settled tasks stay, so
// the count keeps them; activityValues hides the list itself.
export function mergeDiskTasks(st, disk) {
  if (!disk) return st;
  const seen = st.tasks || {};
  const tasks = {};
  let latest = st.tasks_ts || 0;
  for (const [id, t] of Object.entries(disk)) {
    const j = seen[id];
    if (j && j.status === "deleted") tasks[id] = { ...j };
    else if (j && t.cleaned) tasks[id] = { ...j, status: "completed" };
    else tasks[id] = { ...t, ts: j ? j.ts : t.ts };
    latest = Math.max(latest, t.ts);
  }
  for (const [id, j] of Object.entries(seen)) if (!(id in tasks)) tasks[id] = { ...j };
  return { ...st, tasks, tasks_ts: latest };
}

// Fold the per-session journal into the checkpoint and return the folded state.
//
// Read cost is O(events since last render): we read only journal bytes past the stored
// offset, so a multi-hour session never re-reads old events. Invariant: checkpoint.state
// always equals fold(journal[0..offset]); state + offset are persisted together atomically,
// so the reducer's push/increment ops never double-count across renders.
export function loadState(data, env = process.env) {
  const { checkpoint, journal } = statePaths(data.session_id, env);

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
    writeAtomic(checkpoint, JSON.stringify(st));
  } catch { /* ignore: next render retries */ }
  return st;
}

function ramPercent() {
  try { return pyround((1 - os.freemem() / os.totalmem()) * 100); } catch { return null; }
}

// Minimum interval between CPU snapshots; below this, per-core deltas are tick-quantised noise.
// DOOMBAR_COLLECT_MS (a positive number of ms) in the render's environment overrides it.
const CPU_MIN_MS = 1000;
const collectMs = (env) => {
  const n = Number(env.DOOMBAR_COLLECT_MS);
  return env.DOOMBAR_COLLECT_MS && Number.isFinite(n) && n > 0 ? n : CPU_MIN_MS;
};

// Pure: should cpuMetrics recompute, or hold the cached result? Recompute on cold start,
// a legacy snapshot without `ts`, a missing cached result, or once `minMs` has elapsed.
// Holding in between keeps a burst of fast refreshes from sampling a sub-tick interval.
export function shouldSampleCpu(prev, now, minMs = CPU_MIN_MS) {
  return !(prev && typeof prev.ts === "number" && now - prev.ts < minMs && prev.result);
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

function cpuMetrics(env) {
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
  // apart -- so only recompute when >= the collect interval has elapsed, holding the last result
  // (and the old snapshot) in between. The interval keeps growing until it's wide
  // enough to be stable, even under a burst of fast refreshes.
  if (!shouldSampleCpu(prev, now, collectMs(env))) return prev.result;
  const result = cpuDeltas(prev, cur);
  try { writeFileSync(cache, JSON.stringify({ ...cur, result })); } catch { /* ignore */ }
  return result;
}

function sysValues(cwd, now, env) {
  const v = {};
  const ram = ramPercent();
  if (ram !== null) v["sys.ram"] = ram;
  const { cpu, cores } = cpuMetrics(env);
  if (cpu !== null) v["sys.cpu"] = `${cpu}%`;
  if (cores) v["sys.cores"] = cores;
  try {
    const stat = statfsSync(cwd || process.cwd());
    v["sys.disk"] = pyround(((stat.blocks - stat.bfree) / stat.blocks) * 100);
  } catch { /* ignore */ }
  const d = new Date(now * 1000);
  v["sys.clock"] = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return v;
}

// --- Token-savings rows -----------------------------------------------------
// Read from what context-optimization tools already persist on disk. No plugin
// patching, no binary spawn. Paths are env-overridable (DOOMBAR_*) for tests.
const eventsPath = (env) => env.DOOMBAR_EVENTS || path.join(os.homedir(), ".lean-ctx", "events.jsonl");
const llmlinguaPath = (env) => env.DOOMBAR_LLMLINGUA || path.join(os.homedir(), ".llmlingua-stats.json");

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

const savingsStatePath = (sid, env) =>
  env.DOOMBAR_SAVINGS_STATE || sessionPaths(sid, undefined, env).savings;

// Per-session lean-ctx savings. lean-ctx's mcp-live.json is a single global file clobbered
// by every concurrent session, so it can't be per-session. events.jsonl is append-only and
// each ToolCall carries the file path it compressed — so we sum tokens_saved over NEW events
// (tracked by byte offset) whose path is under the current cwd, accumulated across refreshes
// in a per-session state file keyed by session_id. The accumulator follows cwd changes (it
// keeps adding wherever you currently work) and stays cheap — it reads only the bytes appended
// since the last refresh, never the whole log. Residual: two sessions concurrently in the SAME
// project share events and both count them — unsplittable from disk, accepted.
function leanCtxSavings(cwd, sid, env) {
  if (!cwd) return null;
  const cwdN = normPath(cwd).replace(/\/+$/, "") + "/"; // match on a path boundary, not a prefix
  const sp = savingsStatePath(sid, env);
  const events = eventsPath(env);
  let st = { offset: null, saved: 0, original: 0 };
  try { st = { ...st, ...JSON.parse(readFileSync(sp, "utf8")) }; } catch { /* fresh session */ }
  const before = JSON.stringify(st);

  let size = -1;
  try { size = statSync(events).size; } catch { /* no log */ }
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
      const fd = openSync(events, "r");
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
  const after = JSON.stringify(st);
  if (after !== before) {
    try { writeFileSync(sp, after); } catch { /* ignore */ }
  }
  return st.saved > 0 ? fmtSaved(st) : null;
}

// Per-session llmlingua. smart-read keys its sessions map by CLAUDE_CODE_SESSION_ID — the same
// id the statusbar gets on stdin — so we read sessions[sid] (not a single global block).
// Prefer last_saved_pct; else show the ratio. Flat lifetime-only writers expose no session -> absent.
function linguaSavings(sid, env) {
  const d = readJson(llmlinguaPath(env));
  const s = d && d.sessions && d.sessions[sid];
  if (!s || !(s.tokens_saved > 0)) return null;
  if (s.last_saved_pct != null) return `${k(s.tokens_saved)} ${Math.round(s.last_saved_pct)}%`;
  if (s.last_ratio != null) return `${k(s.tokens_saved)} ${Number(s.last_ratio).toFixed(1)}x`;
  return k(s.tokens_saved);
}

export function statsValues(data, cwd, env = process.env) {
  const v = {};
  const rawSid = String((data && data.session_id) || "default");
  const sid = rawSid.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48); // filesystem-safe state-file key
  const lean = leanCtxSavings(cwd, sid, env);
  if (lean) v["save.leanctx"] = lean;
  // smart-read keys sessions[] by the RAW CLAUDE_CODE_SESSION_ID -> look up with the unsanitized id.
  const ling = linguaSavings(rawSid, env);
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
// Health = distance to the FIRST rate-limit wall, in units of the 5h budget. Anthropic exposes
// only used_percentage per window (no caps, no absolutes), but we don't need them: the ratio of
// how fast the two percentages climb IS the ratio of their caps.
//
//   the same usage is a bigger %-step of the smaller cap, so   k = d(p5)/d(p7) = cap7d / cap5h
//
// k is a stable property of the plan (not of how hard you're working), so summing positive
// per-sample deltas converges on it within a few measurements — and summing only positive steps
// is reset-robust (a window rollover is a negative step we skip; the positive climbs already sum
// to total consumption). With cap5h normalised to 100 "health points", the 7d window holds
// k*100, so remaining 7d budget in 5h-units is (100 - p7) * k. Health is the nearer wall:
//
//   rem5 = 100 - p5 ,  rem7 = 100 - p7
//   health = rem5 === 0 || rem7 === 0  ? 0                      // either wall hit -> death
//          : k known                   ? min( rem7 * k , rem5 ) // nearer wall in 5h-units
//          :                             rem5                   // k unknown -> 5h only
//
// This DECLINES as you consume (p rises) and is flat when idle — it depends on how much budget
// is gone, not how fast it went, which is the intuitive "distance to the wall". Until enough 7d
// signal is seen, k is UNKNOWN and we fall back to the 5h clip alone: guessing k=1 would wrongly
// penalise the long window during cold start. The one exception is death — if 7d (or 5h) is fully
// exhausted (rem == 0) you're dead regardless of k: "die Monday, heal Sunday".
const K_MIN_SIGNAL = 1.0;        // percentage-points of 7d movement before the cap ratio is trusted
// k = cap7d / cap5h is physically >= 1: the weekly allowance must exceed a single 5h session's,
// else the 7d cap would never bind. So K_LO is a HARD physical floor, not just noise-clamping.
// Enforcing it also masks a structural flaw in the gross-sum estimator: 5h resets ~33x more often
// than 7d, and each reset that straddles two samples drops the new window's initial climb as a
// skipped negative delta -> sum5 is systematically deflated -> raw ratio can fall below 1 (observed
// 489/1469 = 0.33), which the floor corrects back to a conservative min(rem7, rem5).
// See docs/ideation/2026-07-11-cap-ratio-accumulator-fix.md for the estimator redesign (paired
// instantaneous deltas + EWMA/median, decay/TTL, atomic writes).
const K_LO = 1.0, K_HI = 100;    // clamp the cap-ratio estimate; K_LO is a physical floor (k >= 1)

// Pure: prev { p5, p7, sum5, sum7 } | null (last percents + accumulated positive deltas),
// cur { p5, p7 } (percents 0..100 or null). Returns headroom (0..100) + the state to persist.
export function rateHeadroom(prev, cur) {
  // Accumulate positive per-sample deltas of each window's used%. Their ratio is the cap ratio.
  let sum5 = (prev && prev.sum5) || 0;
  let sum7 = (prev && prev.sum7) || 0;
  if (prev && prev.p5 != null && cur.p5 != null) { const d = cur.p5 - prev.p5; if (d > 0) sum5 += d; }
  if (prev && prev.p7 != null && cur.p7 != null) { const d = cur.p7 - prev.p7; if (d > 0) sum7 += d; }

  // Plain distance-to-wall per window (cap5h normalised to 100 health points).
  const rem5 = cur.p5 != null ? 100 - cur.p5 : 100;
  const rem7 = cur.p7 != null ? 100 - cur.p7 : 100;

  // k = how many times faster 5h% climbs than 7d% = cap7d / cap5h. "Known" only once there's
  // enough 7d signal AND some 5h movement; clamp the estimate against early-sample noise.
  const known = sum7 >= K_MIN_SIGNAL && sum5 > 0;
  const k = known ? Math.max(K_LO, Math.min(K_HI, sum5 / sum7)) : 1;

  // Either wall exhausted -> death. Else: ratio known -> nearer wall in 5h-units; ratio unknown
  // -> 5h clip alone (don't penalise the long window before k is measured).
  let headroom;
  if (rem5 === 0 || rem7 === 0) headroom = 0;
  else if (known) headroom = Math.min(rem7 * k, rem5);
  else headroom = rem5;
  headroom = Math.max(0, Math.min(100, headroom));

  return { headroom, state: { p5: cur.p5, p7: cur.p7, sum5, sum7 } };
}

// I/O wrapper: pull the rate-limit percentages from the payload, fold the persisted accumulator
// through rateHeadroom, persist it, return the headroom (or null when there are no rate limits
// -> hpRow uses its context fallback).
function rateHealthValue(data) {
  const rl = data.rate_limits || {};
  // Throw-proof extraction: this runs on the render hot path and main() has no top-level catch,
  // so a malformed payload (e.g. a non-object window) must never blank the HUD. Numbers only.
  const num = (o, k) => (o && typeof o === "object" && typeof o[k] === "number") ? o[k] : null;
  const cur = { p5: num(rl.five_hour, "used_percentage"), p7: num(rl.seven_day, "used_percentage") };
  if (cur.p5 == null && cur.p7 == null) return null; // no rate limits -> context fallback
  // Rate limits (and therefore the cap ratio k) are ACCOUNT-wide, not per-session: every session
  // samples the same used_percentage. A per-session accumulator made each session re-learn k from
  // scratch and almost always stall at k=1 (7d moves <1pp per session), so identical accounts
  // showed different health. One global file -> one shared k -> identical health everywhere, and
  // it captures movement that happened while any given session wasn't sampling.
  const file = path.join(TMP, "mugshot_ratehealth_global.json");
  let raw, prev = null;
  try { raw = readFileSync(file, "utf8"); prev = JSON.parse(raw); } catch { /* no accumulator yet */ }
  const { headroom, state } = rateHeadroom(prev, cur);
  const text = JSON.stringify(state);
  if (text !== raw) {
    try { writeFileSync(file, text); } catch { /* ignore */ }
  }
  return headroom;
}

// --- Account-wide rate limits, shared across sessions --------------------------------------
// Rate limits belong to the ACCOUNT, but Claude Code only refreshes a session's copy when that
// session itself talks to the API. An idle chat kept showing its last numbers (12% on the 7-day
// bar) while another chat was already at 16%. So every render pools what it sees into one
// shared file and renders the freshest reading any session has seen.
//
// "Freshest" needs no timestamps: a window is identified by its resets_at, and within one
// window used_percentage only ever rises. So per window: a later resets_at wins (a new window
// started), the same resets_at takes the higher percentage, an earlier one is stale.
const SAME_WINDOW_S = 60; // resets_at readings this close are the same window (rounding jitter)

// Pure: the fresher of two readings of one window, { used_percentage, resets_at } | null.
export function fresherWindow(a, b) {
  const ok = (w) => w && typeof w === "object" && typeof w.used_percentage === "number";
  if (!ok(a)) return ok(b) ? b : null;
  if (!ok(b)) return a;
  const ra = typeof a.resets_at === "number" ? a.resets_at : null;
  const rb = typeof b.resets_at === "number" ? b.resets_at : null;
  if (ra !== null && rb !== null && Math.abs(ra - rb) > SAME_WINDOW_S) return ra > rb ? a : b; // newer window
  return b.used_percentage > a.used_percentage ? b : a; // same window (or unknown): usage only rises
}

// Pure: merge this session's rate_limits with the shared ones; returns the merged object.
export function mergeRateLimits(mine, shared) {
  const out = { ...(mine && typeof mine === "object" ? mine : {}) };
  for (const k of ["five_hour", "seven_day"]) {
    const w = fresherWindow(out[k], shared && shared[k]);
    if (w) out[k] = w; else delete out[k];
  }
  return out;
}

const rateLimitsFile = (env) => env.DOOMBAR_RATELIMITS || path.join(TMP, "mugshot_ratelimits_global.json");

// I/O wrapper: read the shared snapshot, merge, write it back if anything got fresher.
// Throw-proof: the render path has no top-level catch, so failures keep the session's own.
function syncRateLimits(mine, env) {
  const file = rateLimitsFile(env);
  let shared = null;
  try { shared = JSON.parse(readFileSync(file, "utf8")); } catch { /* first reading */ }
  const merged = mergeRateLimits(mine, shared);
  const pick = (o) => ({ five_hour: o && o.five_hour, seven_day: o && o.seven_day });
  if (JSON.stringify(pick(merged)) !== JSON.stringify(pick(shared))) {
    try { // atomic: concurrent sessions never read a half-written file
      writeAtomic(file, JSON.stringify(pick(merged)));
    } catch { /* ignore: next render retries */ }
  }
  return merged;
}

// --- Idle-time MSYS reaping -----------------------------------------------------------------
// The hook reaps hung Git Bash wrappers on every event, but while the session sits idle no events
// arrive — and idle is precisely when the 1 s refresh timer is the ONLY thing spawning shells. So
// the render kicks the reaper too. Two rules keep this off the hot path:
//
//   * detached + unref'd + stdio ignored — we never wait for it, so a render costs one ~1 ms
//     spawn call regardless of how long the reap takes;
//   * throttled by a marker file, so at 1 Hz this fires once per REAP_TICK, not 60× a minute.
//
// This is the one spawn on the render path, and it is the cure rather than a cause: it launches
// node directly (never a shell), and only when the throttle has elapsed.
const REAP_TICK = Number.isFinite(Number(process.env.DOOMBAR_REAP_TICK))
  ? Number(process.env.DOOMBAR_REAP_TICK)
  : 15000; // ms

function maybeReap() {
  if (process.platform !== "win32") return;
  if (process.env.DOOMBAR_MSYS_REAP === "0") return;
  const marker = path.join(os.tmpdir(), "mugshot_reap_tick.json");
  try {
    const m = JSON.parse(readFileSync(marker, "utf8"));
    if (Date.now() - (m.ts || 0) < REAP_TICK) return;
  } catch { /* no marker yet -> reap now */ }
  try { writeFileSync(marker, JSON.stringify({ ts: Date.now() })); } catch { return; }
  try {
    const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "hook.js");
    const child = spawn(process.execPath, [hook, "--reap"],
      { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch { /* the HUD is already rendered; a failed reap is not worth a crash */ }
}

// Parsed presets by file path, re-parsed when the file's mtime or size changes. The builders
// never modify a preset, so one parse serves every render.
const presetCache = new Map();
function loadPreset(file) {
  let st;
  try { st = statSync(file); } catch { return parseToml(readFileSync(file, "utf8")); }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = presetCache.get(file);
  if (hit && hit.key === key) return hit.cfg;
  const cfg = parseToml(readFileSync(file, "utf8"));
  presetCache.set(file, { key, cfg });
  return cfg;
}

// Returns the bar's lines, without trailing newlines. Sessions must render one at a time:
// render.js keeps the values in one module-level slot (setValues).
export function renderSession({ data, env = process.env, now = Date.now() / 1000 }) {
  // A shallow copy: the rate-limit merge below rewrites data.rate_limits, and a caller that
  // keeps the payload between renders must not see it change.
  if (data && typeof data === "object" && !Array.isArray(data)) data = { ...data };

  // A non-DOOM theme (see theme.js) swaps in its own preset; doom keeps DOOMBAR_PRESET.
  const preset = themePreset(currentTheme(env))
    || env.DOOMBAR_PRESET || path.join(REPO, "presets", "standard.toml");
  const cfg = loadPreset(preset);

  // Account-wide limits: use the freshest reading any session has seen (see syncRateLimits).
  // A brand-new chat that hasn't called the API yet gets them too. DOOMBAR_RATELIMITS_SHARE=0
  // turns it off.
  if (env.DOOMBAR_RATELIMITS_SHARE !== "0") {
    try { data.rate_limits = syncRateLimits(data.rate_limits, env); } catch { /* keep the session's own */ }
    if (!Object.keys(data.rate_limits || {}).length) delete data.rate_limits;
  }
  const st = mergeDiskTasks(loadState(data, env), readDiskTasks(tasksDir(data.session_id, env)));
  const cwd = data.cwd || (data.workspace || {}).current_dir;
  const values = {
    ...buildValues(data, st.git, now), ...activityValues(st, now), ...sysValues(cwd, now, env), ...statsValues(data, cwd, env),
  };
  const [advModel, advTs] = advisorInfo(data.transcript_path || "");
  if (advModel) values["advisor.model"] = advModel;
  const god_until = godFlash(data, advTs, now, env);
  // Rate-based mugshot health: when present, hpRow prefers it over the snapshot headroom.
  const headroom = rateHealthValue(data);
  if (headroom !== null) values["health.headroom"] = headroom;
  // Right before the builders, which read these values: no other session's render may come
  // between this call and the bar it feeds. The face options are the same kind of slot: the glyph
  // step this session's terminal allows for the mugshot, and the renderer that draws it.
  setValues(values);
  const mugshot = cfg.mugshot || {};
  setFaceOptions({
    step: effectiveStep(env, mugshot.glyphs),
    renderer: env.DOOMBAR_FACE_RENDERER,
    background: rgbOf(mugshot.background ?? "#000000"),
  });

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

  const target = parseInt(env.COLUMNS || "100", 10);
  // The in-game HUD layout (minecraft theme) draws its own screen instead of boxes.
  if ((cfg.bar || {}).layout === "hotbar") {
    const { lines } = buildHotbar(cfg, target, values, {
      sprite: spriteFor(0), exhausted, now, expr: st.expr, exprAge: now - (st.ts || 0),
      indent: Number(env.DOOMBAR_INDENT ?? 2), // Claude Code draws the status line 2 cols in
    });
    return lines;
  }
  const tick = Math.floor(now); // one marquee step per refresh (~1s); pure fn of time
  // Pick the preset that fits the terminal: the chosen preset is the ceiling; if it
  // (at its minimum scale) overflows COLUMNS, fall back down its [bar].fallback chain.
  // Sibling presets resolve relative to the chosen preset's directory.
  const presetDir = path.dirname(preset);
  const loadByName = (name) => {
    try { return loadPreset(path.join(presetDir, `${name}.toml`)); }
    catch { return null; }
  };
  const selected = resolvePreset(cfg, target, loadByName, spriteFor);
  // Text overflow behavior: env wins, then the preset's text_overflow, default "scroll".
  const overflow = env.DOOMBAR_TEXT_OVERFLOW || selected.text_overflow || cfg.text_overflow || "scroll";
  return buildBar(selected, target, spriteFor, tick, overflow).lines;
}

function main() {
  let data = {};
  try { data = JSON.parse(readFileSync(0, "utf8")); } catch { data = {}; }
  const lines = renderSession({ data, env: process.env, now: Date.now() / 1000 });
  process.stdout.write(lines.join("\n") + "\n");
  maybeReap(); // after the write: the HUD is already out, this only cleans up behind it
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
