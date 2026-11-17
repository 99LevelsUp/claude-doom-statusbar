// Session values from the statusline payload (buildValues), and the advisor reading from the
// session transcript (advisorInfo, godFlash).

import { readFileSync, writeFileSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pyround } from "../kit/ansi.js";
import { sessionPaths } from "../platform/runtime.js";

const GOD_FLASH = 3.0; // seconds the mugshot stays god after an advisor consult lands

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

// git is no longer spawned here. The async hook snapshots it into the journal (see hook.js
// + src/platform/journal.js); buildValues reads the folded snapshot from state.git. The render path stays free of
// blocking spawns, so this process adds nothing to the Windows MSYS "bash flood".
//
// It does NOT make the flood impossible: on Windows Claude Code wraps this very command in
// Git Bash (statusLine has no exec form), so each render costs two MSYS inits before node even
// starts. That half is handled by the reaper — see maybeReap in src/statusline.js and reapStaleShells in src/platform/reap.js.

// Clip a display label to at most `n` code points, ending with … when truncated,
// so an oversized repo or branch name can't blow up the PROJECT box width.
export const clip = (s, n) => ([...String(s)].length > n ? [...String(s)].slice(0, n - 1).join("") + "…" : String(s));

export function _dur(secsF) {
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

// Text that links somewhere travels as { text, url }; whatever draws it makes the link.
const linked = (text, url) => ({ text, url: url || null });

function _prettyModel(mid) {
  mid = mid.replace(/\[.*?\]$/, "").replace("claude-", "");
  const parts = mid.split("-");
  return parts.length ? `${parts[0][0].toUpperCase()}${parts[0].slice(1)} ${parts.slice(1).join(".")}`.trim() : mid;
}

// Transcript path -> { key, info }: the result depends only on the file's content.
const advisorCache = new Map();

export function advisorInfo(p) {
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

export function godFlash(data, advTs, now, env) {
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

// The session's values, raw: numbers, plain text, { text, url } for links, lists without icons
// (see the catalogue, src/metrics/catalogue.js).
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
    v["loc.churn"] = `+${a} / -${r}`;
    v["loc.added"] = a;
  }

  const m = data.model || {};
  if (m.display_name) v["model.name"] = m.display_name.split(" (")[0];
  const eff = (data.effort || {}).level;
  if (eff) v["model.effort"] = eff;
  const cwm = (data.context_window || {}).context_window_size;
  if (cwm) v["model.window"] = cwm >= 1000000 ? `${Math.floor(cwm / 1000000)}M` : `${Math.floor(cwm / 1000)}K`;
  const th = data.thinking || {};
  const mode = [];
  if ("enabled" in th) mode.push(["thinking", th.enabled ? "on" : "off"]);
  if ("fast_mode" in data) mode.push(["fast", data.fast_mode ? "on" : "off"]);
  if (mode.length) v["model.mode"] = mode;
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
    let url = null;
    try { url = pathToFileURL(cwd).href; } catch { /* no link */ }
    v["loc.cwd"] = linked(name, url);
    // git fields come from the folded snapshot the async hook wrote, not a live spawn.
    const { br = null, lr = null, st = null } = git || {};
    if (br) v["git.branch"] = linked(clip(br, 60), repoUrl && `${repoUrl}/tree/${br}`);
    if (lr && lr.includes("\t")) {
      const [behind, ahead] = lr.split("\t");
      v["git.behind"] = Number(behind); v["git.ahead"] = Number(ahead);
    }
    if (st !== null) v["git.status"] = st.split("\n").filter((l) => l.trim()).length;
    // The changed-file count and pull/push on one line: files first, then pull/push.
    const work = [];
    if (v["git.status"] !== undefined) work.push(["changed", v["git.status"]]);
    if (v["git.behind"] !== undefined) work.push(["behind", v["git.behind"]], ["ahead", v["git.ahead"]]);
    if (work.length) v["git.work"] = work;
  }

  const pr = data.pr || {};
  if (pr.number || pr.url) {
    const label = pr.number ? `#${pr.number}` : pr.review_state || "PR";
    v["pr.state"] = linked(label, pr.url);
  }
  return v;
}
