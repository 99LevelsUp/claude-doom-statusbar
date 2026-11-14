#!/usr/bin/env node
// Runs every test file under test/ (subfolders included), one after another, each in its own
// node process, and prints a summary. A failing file does not stop the files after it; the exit
// code is 1 when any file failed. The daemon end-to-end test is left out: it starts real
// daemons and must run on its own (`npm run test:e2e`).
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_SEPARATELY = new Set(["daemon-e2e.test.mjs"]);

// Every *.test.mjs under `dir`, in a stable order (names sorted per directory, depth first).
export function findTests(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return findTests(p);
      return e.name.endsWith(".test.mjs") && !RUN_SEPARATELY.has(e.name) ? [p] : [];
    });
}

// The environment the tests run in: `env` without the developer's own bar settings. Inside a
// Claude Code session the settings' env (DOOMBAR_PRESET and the like) is exported to every
// child, and a test that spawns the bar would render with it instead of its own setup. The same
// list the daemon end-to-end test scrubs.
export function testEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (/^(DOOMBAR_|MUGSHOT_)/i.test(k) || /^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_TASK_LIST_ID|COLUMNS)$/i.test(k)) delete out[k];
  }
  return out;
}

// Runs each file and returns [{ file, passed }] for all of them.
export function runAll(files, { stdio = "inherit", cwd = ROOT, env = testEnv() } = {}) {
  return files.map((file) => {
    if (stdio === "inherit") console.log(`\n=== ${path.relative(cwd, file)}`);
    const r = spawnSync(process.execPath, [file], { stdio, cwd, env });
    return { file, passed: r.status === 0 };
  });
}

function main() {
  const results = runAll(findTests(path.join(ROOT, "test")));
  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length} of ${results.length} test files passed.`);
  for (const r of failed) console.log(`  FAILED ${path.relative(ROOT, r.file)}`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
