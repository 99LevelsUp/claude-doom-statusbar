#!/usr/bin/env node
// End-to-end: verify the TASKS box actually appears in the rendered statusline
// when the state file contains tasks. Mirrors smoke.test.mjs patterns.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\][0-9;]*[^\x07\x1b]*(?:\x07|\x1b\\)?/g, "");

const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-e2e-"));
try {
  const stateFile = path.join(tmp, "state.json");
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      a: { title: "scaffold project", status: "completed", ts: 1 },
      b: { title: "wire the box", status: "pending", ts: 2 },
    },
    tasks_ts: Math.floor(Date.now() / 1000), // recent -> always visible
  }));

  const sample = JSON.stringify({
    cwd: tmp,
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    workspace: { current_dir: tmp },
  });

  const out = strip(execFileSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
    input: sample,
    encoding: "utf8",
    env: {
      ...process.env,
      MUGSHOT_STATE: stateFile,
      DOOMBAR_PRESET: path.join(ROOT, "presets", "full.toml"),
      COLUMNS: "140",
    },
  }));

  ok(/TASKS/.test(out), "TASKS header present");
  ok(out.includes("scaffold project"), "completed task title rendered");
  ok(out.includes("wire the box"), "pending task title rendered");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
