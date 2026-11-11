#!/usr/bin/env node
// What the one-shot status line costs (Linux and macOS, where no render daemon runs): each run
// starts `node src/statusline.js` as Claude Code does, with the richest glyph step. The first run
// converts the face; later runs read it from the disk cache. Prints both.
//
// For reference, before the built-in converter replaced chafa, the median of 21 runs on the
// GitHub Actions runners was 81.0 ms with chafa against 62.8 ms built-in on ubuntu-latest, and
// 130.1 ms against 98.2 ms on macos-latest (11.11.2026).
//
// Usage: node scripts/measure-oneshot.mjs [runs]

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = Math.max(3, Number(process.argv[2]) || 15);
const sandbox = mkdtempSync(path.join(os.tmpdir(), "doombar-oneshot-"));

const payload = JSON.stringify({
  session_id: "oneshot-cost", cwd: ROOT, workspace: { current_dir: ROOT, project_dir: ROOT },
  model: { id: "claude-opus-5-5", display_name: "Opus" }, transcript_path: "",
  context_window: { used_percentage: 42, context_window_size: 200000 },
  cost: { total_cost_usd: 0.42, total_duration_ms: 120000, total_api_duration_ms: 30000 },
});

const env = {
  ...process.env, TEMP: sandbox, TMP: sandbox, TMPDIR: sandbox, COLUMNS: "200",
  DOOMBAR_GLYPHS: "octant", DOOMBAR_PRESET: path.join(ROOT, "presets", "full.toml"),
  DOOMBAR_THEME: "doom", DOOMBAR_RATELIMITS_SHARE: "0", DOOMBAR_MSYS_REAP: "0",
};

function run() {
  const t = performance.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], { input: payload, env, encoding: "utf8" });
  const ms = performance.now() - t;
  if (r.status !== 0) throw new Error(`statusline exited ${r.status}: ${r.stderr}`);
  return ms;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

try {
  const first = run();
  const cached = median(Array.from({ length: RUNS }, run));
  console.log(`platform ${process.platform} ${os.arch()}, node ${process.version}`);
  console.log("one-shot render at the octant step:");
  console.log(`  first run, converts the face:     ${first.toFixed(1)} ms`);
  console.log(`  median of ${RUNS}, face from the cache: ${cached.toFixed(1)} ms`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
