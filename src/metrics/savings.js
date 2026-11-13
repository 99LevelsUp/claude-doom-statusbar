// --- Token-savings rows -----------------------------------------------------
// Read from what context-optimization tools already persist on disk. No plugin
// patching, no binary spawn. Paths are env-overridable (DOOMBAR_*) for tests.

import { readFileSync, writeFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionPaths } from "../platform/runtime.js";

// Human-readable token count: 8263 -> "8.3k", 1200000 -> "1.2M", 512 -> "512".
// Lowercase k/M — the savings rows read softer than model.window's uppercase K/M.
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);

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
