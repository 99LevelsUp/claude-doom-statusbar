#!/usr/bin/env node
// Rate-based mugshot health (rateHeadroom): derive time-to-exhaustion per rate-limit window
// from the RATE its used_percentage climbs, pick the window that binds first, normalise to a
// 5h clip. The absolute caps cancel, so this needs no token counts or subscription info.

import { rateHeadroom } from "../src/statusline.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const near = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;
const W = 60; // explicit window for deterministic tests

// 1. Cold start: no baseline -> null (caller falls back to the snapshot metric).
{
  const { headroom, state } = rateHeadroom(null, { p5: 20, p7: 30, reset5: null, reset7: null }, 1000, W);
  ok(headroom === null, "cold start -> headroom null (fallback)");
  ok(state.ts === 1000 && state.p5 === 20, "cold start seeds the baseline");
}

// 2. Within the window -> hold the previous headroom, don't recompute.
{
  const prev = { p5: 20, p7: 30, ts: 1000, headroom: 42 };
  const { headroom } = rateHeadroom(prev, { p5: 25, p7: 31, reset5: null, reset7: null }, 1000 + 30, W);
  ok(headroom === 42, `held within window (got ${headroom})`);
}

// 3. Basic: 5h climbs 20->30 over 120s, 7d flat. T5=(100-30)/(10/120)=840s -> 840/18000*100≈4.67.
{
  const prev = { p5: 20, p7: 20, ts: 0, headroom: null };
  const { headroom } = rateHeadroom(prev, { p5: 30, p7: 20, reset5: null, reset7: null }, 120, W);
  ok(near(headroom, 4.67), `runway normalised to a 5h clip (got ${headroom?.toFixed(2)}, want ≈4.67)`);
}

// 4. THE scenario: 5h lower but climbing fast vs 7d high but crawling. 5h must win.
//    r5=20/120 -> T5=60/0.1667≈360s -> ≈2.0 ; r7=2/120 -> T7=18/0.01667≈1080s -> ≈6.0.
//    Snapshot metric would pick 7d (min remaining% = 18); the rate metric correctly picks 5h.
{
  const prev = { p5: 20, p7: 80, ts: 0, headroom: null };
  const { headroom } = rateHeadroom(prev, { p5: 40, p7: 82, reset5: null, reset7: null }, 120, W);
  ok(near(headroom, 2.0), `5h binds first by rate, not 7d by level (got ${headroom?.toFixed(2)}, want ≈2.0)`);
}

// 5. A percentage drop = window rolled over / reset -> fresh budget -> full health.
{
  const prev = { p5: 90, p7: 50, ts: 0, headroom: 3 };
  const { headroom } = rateHeadroom(prev, { p5: 5, p7: 51, reset5: null, reset7: null }, 120, W);
  ok(headroom === 100, `reset (percentage drop) -> healthy (got ${headroom})`);
}

// 6. A window that resets_at before it would exhaust never binds.
{
  const prev = { p5: 20, p7: 20, ts: 0, headroom: null };
  // 5h would exhaust ~360s after now(120); but it resets at 200 (in 80s) -> not binding; 7d flat.
  const { headroom } = rateHeadroom(prev, { p5: 40, p7: 20, reset5: 200, reset7: null }, 120, W);
  ok(headroom === 100, `resets before exhaustion -> never binds (got ${headroom})`);
}

// 7. No consumption across the window (rate 0) -> nothing binds -> full health.
{
  const prev = { p5: 50, p7: 60, ts: 0, headroom: null };
  const { headroom } = rateHeadroom(prev, { p5: 50, p7: 60, reset5: null, reset7: null }, 120, W);
  ok(headroom === 100, `idle (no climb) -> healthy (got ${headroom})`);
}

// 8. Plenty of runway (slow climb) clamps to 100, not an unbounded number.
{
  const prev = { p5: 0, p7: 0, ts: 0, headroom: null };
  const { headroom } = rateHeadroom(prev, { p5: 0.1, p7: 0, reset5: null, reset7: null }, 120, W);
  ok(headroom === 100, `>5h runway clamps to full health (got ${headroom})`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
