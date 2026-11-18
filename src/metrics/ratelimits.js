// Rate limits: the rate-based mugshot health, and the account-wide rate limits pooled across
// sessions.

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runtimeDir, writeAtomic, readLearned, oldStateFile, FILE_PREFIX, OLD_FILE_PREFIX } from "../platform/runtime.js";
import { envGet } from "../platform/env.js";
import { accountKey } from "../platform/account.js";

// The account-wide files, one per Claude account (src/platform/account.js): <name>_<key>.json, or
// <name>_global.json, the one file every account shared before accounts were told apart, when the
// account is not known.
export const accountFileName = (name, key) => `${FILE_PREFIX}${name}_${key || "global"}.json`;

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
export function rateHealthValue(data, env = process.env) {
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
  // it captures movement that happened while any given session wasn't sampling. One file per
  // Claude account, since k is a property of the account's plan.
  // An account's first file starts from the shared one (the k learned before accounts were told
  // apart), and a release before 1.0.0 kept that under the old name; each is read until the newer
  // one exists.
  const key = accountKey(env);
  const file = path.join(runtimeDir(), accountFileName("ratehealth", key));
  const globalFile = path.join(runtimeDir(), accountFileName("ratehealth", null));
  const oldGlobal = () => oldStateFile(`${OLD_FILE_PREFIX}ratehealth_global.json`);
  const { text: raw, old } = readLearned(file, () => (key && existsSync(globalFile) ? globalFile : oldGlobal()));
  let prev = null;
  try { prev = JSON.parse(raw); } catch { /* no accumulator yet */ }
  const { headroom, state } = rateHeadroom(prev, cur);
  const text = JSON.stringify(state);
  if (old || text !== raw) {
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
//
// A reading whose window has already reset (resets_at in the past) is stale whatever its
// percentage, and a reading that names its window beats one that does not: a reading without
// resets_at cannot be placed, and once it was pooled with a higher percentage it used to win
// every later merge, hiding the live window's reset time.
const SAME_WINDOW_S = 60; // resets_at readings this close are the same window (rounding jitter)

// Pure: the fresher of two readings of one window, { used_percentage, resets_at } | null.
// `now` is in seconds, like resets_at.
export function fresherWindow(a, b, now = Date.now() / 1000) {
  const ok = (w) => w && typeof w === "object" && typeof w.used_percentage === "number";
  if (!ok(a)) return ok(b) ? b : null;
  if (!ok(b)) return a;
  const ra = typeof a.resets_at === "number" ? a.resets_at : null;
  const rb = typeof b.resets_at === "number" ? b.resets_at : null;
  const overA = ra !== null && ra <= now, overB = rb !== null && rb <= now;
  if (overA !== overB) return overA ? b : a; // a window that has reset is stale
  if ((ra === null) !== (rb === null)) return ra === null ? b : a; // a known window beats an unknown one
  if (ra !== null && rb !== null && Math.abs(ra - rb) > SAME_WINDOW_S) return ra > rb ? a : b; // newer window
  return b.used_percentage > a.used_percentage ? b : a; // same window (or both unknown): usage only rises
}

// Pure: merge this session's rate_limits with the shared ones; returns the merged object.
export function mergeRateLimits(mine, shared, now = Date.now() / 1000) {
  const out = { ...(mine && typeof mine === "object" ? mine : {}) };
  for (const k of ["five_hour", "seven_day"]) {
    const w = fresherWindow(out[k], shared && shared[k], now);
    if (w) out[k] = w; else delete out[k];
  }
  return out;
}

// The pool: one file per Claude account. An account's pool starts empty rather than from the shared
// file, which may hold another account's readings. Without a known account it is the shared file,
// and where a release before 1.0.0 kept that. GAMEBAR_RATELIMITS names one file for every account.
function rateLimitsFiles(env) {
  const set = envGet("RATELIMITS", env);
  if (set) return { file: set, oldFileOf: null };
  const key = accountKey(env);
  const file = path.join(runtimeDir(), accountFileName("ratelimits", key));
  return { file, oldFileOf: key ? null : () => oldStateFile(`${OLD_FILE_PREFIX}ratelimits_global.json`) };
}

// I/O wrapper: read the shared snapshot, merge, write it back if anything got fresher.
// Throw-proof: the render path has no top-level catch, so failures keep the session's own.
export function syncRateLimits(mine, env) {
  const { file, oldFileOf } = rateLimitsFiles(env);
  const { text, old } = readLearned(file, oldFileOf);
  let shared = null;
  try { shared = JSON.parse(text); } catch { /* first reading */ }
  const merged = mergeRateLimits(mine, shared);
  const pick = (o) => ({ five_hour: o && o.five_hour, seven_day: o && o.seven_day });
  if (old || JSON.stringify(pick(merged)) !== JSON.stringify(pick(shared))) {
    try { // atomic: concurrent sessions never read a half-written file
      writeAtomic(file, JSON.stringify(pick(merged)));
    } catch { /* ignore: next render retries */ }
  }
  return merged;
}
