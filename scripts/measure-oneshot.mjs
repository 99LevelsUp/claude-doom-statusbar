#!/usr/bin/env node
// What the face costs the one-shot status line (Linux and macOS, where no render daemon runs):
// each run starts `node src/statusline.js` as Claude Code does, cold, with the richest glyph
// step, once with the built-in converter and once with chafa. Prints the median wall time of
// each and their difference. Usage: node scripts/measure-oneshot.mjs [runs]

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

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function measure(renderer) {
  const env = {
    ...process.env, TEMP: sandbox, TMP: sandbox, TMPDIR: sandbox, COLUMNS: "200",
    DOOMBAR_GLYPHS: "octant", DOOMBAR_PRESET: path.join(ROOT, "presets", "full.toml"),
    DOOMBAR_THEME: "doom", DOOMBAR_RATELIMITS_SHARE: "0", DOOMBAR_MSYS_REAP: "0",
  };
  if (renderer) env.DOOMBAR_FACE_RENDERER = renderer; else delete env.DOOMBAR_FACE_RENDERER;
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const r = spawnSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], { input: payload, env, encoding: "utf8" });
    times.push(performance.now() - t);
    if (r.status !== 0) throw new Error(`statusline exited ${r.status}: ${r.stderr}`);
  }
  return median(times);
}

const chafa = spawnSync("chafa", ["--version"], { encoding: "utf8" });
if (chafa.error) {
  console.error("chafa is not on PATH; install it first (apt-get install chafa / brew install chafa)");
  process.exit(2);
}
try {
  measure(null); // warm the file system cache for both runs
  const builtin = measure(null);
  const viaChafa = measure("chafa");
  console.log(`platform ${process.platform} ${os.arch()}, node ${process.version}, ${chafa.stdout.split("\n")[0]}`);
  console.log(`one-shot render, median of ${RUNS} cold runs at the octant step:`);
  console.log(`  built-in face: ${builtin.toFixed(1)} ms`);
  console.log(`  chafa face:    ${viaChafa.toFixed(1)} ms`);
  console.log(`  built-in minus chafa: ${(builtin - viaChafa).toFixed(1)} ms (${builtin <= viaChafa ? "within" : "OVER"} the target)`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
