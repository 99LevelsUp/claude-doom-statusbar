#!/usr/bin/env node
// Rate-based mugshot health (rateHeadroom): distance to the FIRST rate-limit wall, in 5h-budget
// units. We can't read caps/absolutes, but the ratio of how fast the two used% climb IS the cap
// ratio (k = d(p5)/d(p7) = cap7d/cap5h) — accumulated from positive per-sample deltas. Then
//   health = min( 100 - p5 , (100 - p7) * k )
// which declines with CONSUMPTION (not speed) and is flat when idle.

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

// 1. Cold start: no accumulator -> k = 1 -> health == plain min-remaining. min(80, 70) = 70.
{
  const { headroom, state } = rateHeadroom(null, { p5: 20, p7: 30 });
  ok(headroom === 70, `cold start -> plain distance-to-wall (got ${headroom}, want 70)`);
  ok(state.sum5 === 0 && state.sum7 === 0, "cold start seeds empty accumulators");
}

// 2. Ratio learning: 5h climbs 5pp while 7d climbs 1pp -> sums accumulate -> k = 5.
{
  const { headroom, state } = rateHeadroom({ p5: 0, p7: 0, sum5: 0, sum7: 0 }, { p5: 5, p7: 1 });
  ok(state.sum5 === 5 && state.sum7 === 1, `positive deltas accumulate (got sum5=${state.sum5}, sum7=${state.sum7})`);
  ok(headroom === 95, `health from rem5 while 7d far (got ${headroom}, want 95)`); // min(95, 99*5)
}

// 3. THE example: 5h used 25% (rem 75), 7d used 82% (rem 18), learned k = 5 (sum5/sum7 = 50/10).
//    Absolute: 5h has 750 left of 1000, 7d 900 left of 5000 -> 5h is the nearer wall. health = 75.
//    The old min-remaining metric would've read 18 (7d) — the cap ratio corrects that.
{
  const { headroom } = rateHeadroom({ p5: 25, p7: 82, sum5: 50, sum7: 10 }, { p5: 25, p7: 82 });
  ok(headroom === 75, `5h binds via cap ratio, not 7d by raw % (got ${headroom}, want 75)`);
}

// 4. 7d is the nearer wall: 5h rem 90, 7d rem 5, k = 5 -> (5 * 5) = 25 < 90. health = 25.
{
  const { headroom } = rateHeadroom({ p5: 10, p7: 95, sum5: 50, sum7: 10 }, { p5: 10, p7: 95 });
  ok(headroom === 25, `7d binds when its scaled runway is smaller (got ${headroom}, want 25)`);
}

// 4b. Death by the WEEKLY wall: 7d exhausted (100%) kills health even with the 5h clip totally
//     free (p5=0). (100 - 100) * k = 0 dominates the min -> health 0. You stay dead through 5h
//     resets until the 7d window itself resets — exactly "die Monday, heal Sunday".
{
  const { headroom } = rateHeadroom({ p5: 0, p7: 100, sum5: 50, sum7: 10 }, { p5: 0, p7: 100 });
  ok(headroom === 0, `7d exhausted -> dead even with 5h free (got ${headroom}, want 0)`);
}

// 5. Reset-robust: a percentage DROP (window rollover) is a negative delta that must not pollute
//    the accumulator. 5h drops 90->5; sum5 unchanged, only 7d's positive step counts.
{
  const { state } = rateHeadroom({ p5: 90, p7: 50, sum5: 50, sum7: 10 }, { p5: 5, p7: 51 });
  ok(state.sum5 === 50 && state.sum7 === 11, `reset drop skipped, positive step kept (sum5=${state.sum5}, sum7=${state.sum7})`);
}

// 6. Normal use (7d far): k = 5, 5h rem 60, 7d scaled runway 400 -> 5h clip drives. health = 60.
{
  const { headroom } = rateHeadroom({ p5: 40, p7: 20, sum5: 50, sum7: 10 }, { p5: 40, p7: 20 });
  ok(headroom === 60, `5h clip drives health when 7d is far (got ${headroom}, want 60)`);
}

// 7. Idle = flat health (the whole point): no consumption -> percentages static -> health does
//    NOT move (and never rises from merely pausing). Two idle ticks read identically.
{
  const a = rateHeadroom({ p5: 50, p7: 60, sum5: 50, sum7: 10 }, { p5: 50, p7: 60 });
  const b = rateHeadroom(a.state, { p5: 50, p7: 60 });
  ok(a.headroom === 50 && b.headroom === 50, `idle holds health steady (got ${a.headroom}, ${b.headroom}, want 50, 50)`);
  ok(b.state.sum5 === 50 && b.state.sum7 === 10, "idle does not accumulate ratio signal");
}

// 8. Before enough 7d signal (sum7 < 1pp), k = 1 -> plain min-remaining (uncorrected). 7d at 80%
//    drives health to 20 until the ratio is learned.
{
  const { headroom } = rateHeadroom({ p5: 20, p7: 80, sum5: 0.4, sum7: 0.2 }, { p5: 20, p7: 80 });
  ok(headroom === 20, `pre-signal falls back to plain level (got ${headroom}, want 20)`);
}

// 9. Integration: the live wiring (rateHealthValue -> values["health.headroom"] -> hpRow) must
//    render without crashing and persist the accumulator. Sole end-to-end coverage of the path.
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-ratewire-"));
  const sid = "ratewire-" + process.pid;
  const healthFile = path.join(os.tmpdir(), `mugshot_ratehealth_${sid}.json`);
  const env = {
    ...process.env,
    DOOMBAR_PRESET: path.join(HERE, "..", "presets", "standard.toml"),
    MUGSHOT_STATE: path.join(tmp, "state.json"),
    COLUMNS: "100",
  };
  const payload = (p5) => JSON.stringify({
    session_id: sid,
    context_window: { used_percentage: 20, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: p5 }, seven_day: { used_percentage: 30 } },
    model: { display_name: "Test" },
  });
  const run = (p5) => execFileSync(process.execPath, [STATUSLINE], { input: payload(p5), encoding: "utf8", env });
  try {
    const out1 = run(20);
    ok(out1.trim().length > 0, "render 1 produced output, no crash");
    ok(existsSync(healthFile), "accumulator file written on first render");
    const out2 = run(45); // 5h climbed -> a positive delta accumulates
    ok(out2.trim().length > 0, "render 2 produced output, no crash");
    const st = JSON.parse(readFileSync(healthFile, "utf8"));
    ok(st.p5 === 45 && typeof st.sum5 === "number" && st.sum5 > 0,
      `accumulator advanced + recorded the climb (got ${JSON.stringify(st)})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    try { rmSync(healthFile, { force: true }); } catch { /* ignore */ }
  }
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
