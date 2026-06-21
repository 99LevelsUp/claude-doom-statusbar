#!/usr/bin/env node
// Unit tests for sys.cores per-core CPU utilisation (cpuDeltas).
//
// cpuDeltas is the pure core of cpuMetrics: it turns two cumulative CPU snapshots
// into the aggregate sys.cpu (0..100) and the per-core sys.cores array (0..1 each),
// without touching os.cpus() or the disk cache. The I/O wrapper cpuMetrics is left
// to integration; the delta arithmetic and cold-start/mismatch handling live here.
import { cpuDeltas, shouldSampleCpu } from "../src/statusline.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

// 1. Known deltas -> per-core utilisation and aggregate percent.
{
  const prev = { total: 200, idle: 200, cores: [{ total: 100, idle: 100 }, { total: 100, idle: 100 }] };
  const cur = { total: 400, idle: 250, cores: [{ total: 200, idle: 150 }, { total: 200, idle: 100 }] };
  const { cpu, cores } = cpuDeltas(prev, cur);
  ok(Array.isArray(cores) && cores.length === 2, `cores has one entry per core (got ${cores && cores.length})`);
  ok(Math.abs(cores[0] - 0.5) < 1e-9, `core0: dt100/di50 -> 0.5 (got ${cores[0]})`);
  ok(Math.abs(cores[1] - 1.0) < 1e-9, `core1: dt100/di0 -> 1.0 (got ${cores[1]})`);
  ok(cpu === 75, `aggregate sys.cpu still computed: dt200/di50 -> 75 (got ${cpu})`);
  ok(cores.every((c) => c >= 0 && c <= 1), "every core value is within 0..1");
}

// 2. Cold start: no prior snapshot -> both null, metric doesn't render.
{
  const cur = { total: 100, idle: 50, cores: [{ total: 100, idle: 50 }] };
  const { cpu, cores } = cpuDeltas(null, cur);
  ok(cpu === null && cores === null, "cold start (prev=null) -> { cpu: null, cores: null }");
}

// 3. A core with zero elapsed time -> 0, no NaN/Infinity.
{
  const prev = { total: 100, idle: 50, cores: [{ total: 100, idle: 50 }] };
  const cur = { total: 100, idle: 50, cores: [{ total: 100, idle: 50 }] };
  const { cores } = cpuDeltas(prev, cur);
  ok(cores[0] === 0 && Number.isFinite(cores[0]), `dt=0 core -> 0, finite (got ${cores[0]})`);
}

// 4. Old cache without per-core data (core-count mismatch) -> cores null, cpu still works.
{
  const prev = { total: 200, idle: 200 };                 // legacy aggregate-only snapshot
  const cur = { total: 400, idle: 250, cores: [{ total: 200, idle: 125 }, { total: 200, idle: 125 }] };
  const { cpu, cores } = cpuDeltas(prev, cur);
  ok(cores === null, "missing prev.cores -> cores null (graceful, no throw)");
  ok(cpu === 75, `aggregate still produced from total/idle (got ${cpu})`);
}

// 5. Sampling guard: recompute only after CPU_MIN_MS (1s); hold the result in between.
{
  const now = 10000;
  ok(shouldSampleCpu(null, now) === true, "cold start -> recompute");
  ok(shouldSampleCpu({ ts: now - 500, result: { cpu: 1 } }, now) === false, "fresh snapshot (<1s) with result -> hold");
  ok(shouldSampleCpu({ ts: now - 2000, result: { cpu: 1 } }, now) === true, "stale snapshot (>=1s) -> recompute");
  ok(shouldSampleCpu({ ts: now - 500, result: null }, now) === true, "no cached result -> recompute (nothing to hold)");
  ok(shouldSampleCpu({ total: 1, idle: 1, cores: [] }, now) === true, "legacy snapshot without ts -> recompute");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
