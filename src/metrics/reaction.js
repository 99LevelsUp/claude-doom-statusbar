// The game-neutral reaction a render hands to the layouts: what just happened in the session
// and how hurt the player is. Games turn it into their own look (a face, heart colours).
//
//   expr     the last folded expression (EXPRESSIONS in src/platform/journal.js) or null
//   exprAge  seconds since that expression
//   flash    the one reaction showing right now, with this precedence:
//              "dead"   out of usage
//              "god"    the advisor's god flash is active
//              expr     one of the expressions above, for DECAY seconds
//              "other"  any other expression string, for DECAY seconds
//              null     nothing to show
//   hp       the health row, 0 (healthy) .. 4 (nearly dead)
//   god, dead  the god flash and exhaustion on their own

import { EXPRESSIONS } from "../platform/journal.js";

export const DECAY = 1.5; // seconds a reaction holds before relaxing to idle

// The expressions the hook fold produces.
const KNOWN = new Set(EXPRESSIONS);

const HP_THRESHOLDS = [20, 40, 60, 80];

// How many health thresholds the remaining headroom has dropped below.
export function hpRow(values, thresholds = HP_THRESHOLDS) {
  let headroom;
  if ("health.headroom" in values) {
    // Rate-limit health (src/metrics/ratelimits.js): distance to the first wall in 5h-budget units, where
    // the binding window is weighted by the learned cap ratio (k = how much faster 5h% climbs
    // than 7d%). Declines with consumption, flat when idle. Already in 0..100.
    headroom = values["health.headroom"];
  } else if ("ratelimit.5h" in values || "ratelimit.7d" in values) {
    // Defensive fallback (only if health.headroom is somehow absent): tightest remaining budget.
    const rem5 = 100 - (values["ratelimit.5h"] ?? 0);
    const rem7 = "ratelimit.7d" in values ? 100 - values["ratelimit.7d"] : 100;
    headroom = Math.min(rem5, rem7);
  } else {
    headroom = 100 - (values["context.hp"] ?? 0);
  }
  return thresholds.filter((t) => headroom < t).length;
}

// The reaction from the folded hook state, the metric values, the time the god flash ends,
// whether usage is exhausted, and the current time in seconds.
export function buildReaction({ st = {}, values, godUntil, exhausted, now }) {
  const expr = st.expr || null;
  const exprAge = now - (st.ts || 0);
  const dead = Boolean(exhausted);
  const god = now < godUntil;
  let flash = null;
  if (dead) flash = "dead";
  else if (god) flash = "god";
  else if (expr && exprAge < DECAY) flash = KNOWN.has(expr) ? expr : "other";
  return { expr, exprAge, flash, hp: hpRow(values), god, dead };
}

// The reaction when nothing happened: no expression, no flash, the health row of `values`.
// Layouts fall back to it when a caller (the preview, a test) passes no reaction.
export function calmReaction(values = {}) {
  return { expr: null, exprAge: Infinity, flash: null, hp: hpRow(values), god: false, dead: false };
}
