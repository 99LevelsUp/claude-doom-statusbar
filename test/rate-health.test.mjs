#!/usr/bin/env node
// Rate-based mugshot health (rateHeadroom): health = FLOOR of two lenses —
//   level (instantaneous): tightest remaining headroom now, min(100 - used%)
//   rate  (windowed):      time-to-exhaustion of the binding window, normalised to a 5h clip
// so the face warns when you're burning fast OR simply near a wall. The absolute caps cancel in
// the rate term, so no token counts / subscription info are needed.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rateHeadroom } from "../src/statusline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATUSLINE = path.join(HERE, "..", "src", "statusline.js");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const near = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;
const W = 60; // explicit window for deterministic tests

// 1. Cold start: no rate baseline -> rate non-binding -> headroom == the level metric (= old
//    snapshot behaviour). cur min remaining = min(80, 70) = 70.
{
  const { headroom, state } = rateHeadroom(null, { p5: 20, p7: 30, reset5: null, reset7: null }, 1000, W);
  ok(headroom === 70, `cold start -> level metric (got ${headroom}, want 70)`);
  ok(state.ts === 1000 && state.p5 === 20, "cold start seeds the baseline");
}

// 2. Within the window -> hold the windowed rate component, but keep the level floor fresh.
{
  const prev = { p5: 20, p7: 30, ts: 1000, rateComp: 42 };
  const { headroom } = rateHeadroom(prev, { p5: 25, p7: 31, reset5: null, reset7: null }, 1000 + 30, W);
  ok(headroom === 42, `held rate floored by fresh level (got ${headroom}, want 42)`);
}

// 3. 5h climbs 20->30 over 120s, 7d flat. Rate T5≈840s -> ≈4.67; level=min(70,80)=70 -> floor=4.67.
{
  const prev = { p5: 20, p7: 20, ts: 0 };
  const { headroom } = rateHeadroom(prev, { p5: 30, p7: 20, reset5: null, reset7: null }, 120, W);
  ok(near(headroom, 4.67), `rate binds below level (got ${headroom?.toFixed(2)}, want ≈4.67)`);
}

// 4. THE scenario: 5h lower but climbing fast vs 7d high but crawling. 5h binds (≈2.0), not 7d.
//    The old snapshot metric would've picked 7d (remaining 18%); rate correctly picks 5h.
{
  const prev = { p5: 20, p7: 80, ts: 0 };
  const { headroom } = rateHeadroom(prev, { p5: 40, p7: 82, reset5: null, reset7: null }, 120, W);
  ok(near(headroom, 2.0), `5h binds first by rate (got ${headroom?.toFixed(2)}, want ≈2.0)`);
}

// 5. THE chosen floor: idle at 95% of the weekly budget -> rate non-binding (100) but level=5,
//    so the face is critical, not falsely healthy. This is exactly the case the floor exists for.
{
  const prev = { p5: 50, p7: 95, ts: 0 };
  const { headroom } = rateHeadroom(prev, { p5: 50, p7: 95, reset5: null, reset7: null }, 120, W);
  ok(headroom === 5, `idle near the weekly wall -> floored to level (got ${headroom}, want 5)`);
}

// 6. A percentage drop = window rolled over / reset -> rate unknown this tick, but the still-high
//    other window's level floors it (not blindly healthy). 5h 90->5 (reset), 7d at 51% -> level 49.
{
  const prev = { p5: 90, p7: 50, ts: 0, rateComp: 3 };
  const { headroom } = rateHeadroom(prev, { p5: 5, p7: 51, reset5: null, reset7: null }, 120, W);
  ok(headroom === 49, `reset floored by the other window's level (got ${headroom}, want 49)`);
}

// 7. A window that resets_at before it would exhaust never binds on rate; level still applies.
//    5h would exhaust ~360s after now(120) but resets at 200 -> rate non-binding; level=min(60,80)=60.
{
  const prev = { p5: 20, p7: 20, ts: 0 };
  const { headroom } = rateHeadroom(prev, { p5: 40, p7: 20, reset5: 200, reset7: null }, 120, W);
  ok(headroom === 60, `resets before exhaustion -> level floor only (got ${headroom}, want 60)`);
}

// 8. Ample runway, low usage -> ~full health (only the tiny level draw shows).
{
  const prev = { p5: 0, p7: 0, ts: 0 };
  const { headroom } = rateHeadroom(prev, { p5: 0.1, p7: 0, reset5: null, reset7: null }, 120, W);
  ok(headroom > 99 && headroom <= 100, `ample runway -> ~full health (got ${headroom})`);
}

// 9. Integration: the live wiring (rateHealthValue -> values["health.headroom"] -> hpRow) must
//    not crash the render and must persist a numeric rate component. Every other render/smoke
//    test only hits the level path; this is the sole end-to-end coverage. DOOMBAR_RATE_WINDOW=0
//    forces the rate branch to compute on the 2nd render.
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-ratewire-"));
  const sid = "ratewire-" + process.pid;
  const healthFile = path.join(os.tmpdir(), `mugshot_ratehealth_${sid}.json`);
  const env = {
    ...process.env,
    DOOMBAR_PRESET: path.join(HERE, "..", "presets", "standard.toml"),
    DOOMBAR_RATE_WINDOW: "0",
    MUGSHOT_STATE: path.join(tmp, "state.json"),
    COLUMNS: "100",
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = (p5) => JSON.stringify({
    session_id: sid,
    context_window: { used_percentage: 20, context_window_size: 200000 },
    rate_limits: {
      five_hour: { used_percentage: p5, resets_at: nowSec + 9000 },
      seven_day: { used_percentage: 30, resets_at: nowSec + 500000 },
    },
    model: { display_name: "Test" },
  });
  const run = (p5) => execFileSync(process.execPath, [STATUSLINE], { input: payload(p5), encoding: "utf8", env });
  try {
    const out1 = run(20);
    ok(out1.trim().length > 0, "render 1 (cold start) produced output, no crash");
    ok(existsSync(healthFile), "rate-health baseline file written on first render");
    const out2 = run(45); // 5h climbed -> rate branch computes (window 0)
    ok(out2.trim().length > 0, "render 2 (rate path) produced output, no crash");
    const st = JSON.parse(readFileSync(healthFile, "utf8"));
    ok(st.p5 === 45 && typeof st.rateComp === "number",
      `rate path advanced the baseline + computed a rate component (got ${JSON.stringify(st)})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    try { rmSync(healthFile, { force: true }); } catch { /* ignore */ }
  }
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
