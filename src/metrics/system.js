// System values: RAM, CPU (aggregate and per core), disk use and the clock.

import { readFileSync, writeFileSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pyround } from "../kit/ansi.js";
import { runtimeDir } from "../platform/runtime.js";

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
  const cache = path.join(runtimeDir(), "mugshot_cpu.json");
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

export function sysValues(cwd, now, env) {
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
