#!/usr/bin/env node
// The test runner: it finds every test file, runs them all even when one fails, reports each,
// and leaves the daemon end-to-end test to its own command.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findTests, runAll, testEnv } from "../scripts/run-tests.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const dir = mkdtempSync(path.join(os.tmpdir(), "gamebar-runner-"));
try {
  const write = (rel, code) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, code);
    return file;
  };
  const failing = write("a-fails.test.mjs", "process.exit(1);\n");
  const passing = write("b-passes.test.mjs", "process.exit(0);\n");
  const nested = write(path.join("platform", "c-nested.test.mjs"), "process.exit(0);\n");
  write("daemon-e2e.test.mjs", "process.exit(1);\n");
  write("helper.mjs", "export const x = 1;\n");
  write(path.join("snapshots", "note.txt"), "not a test\n");

  const found = findTests(dir);
  ok(JSON.stringify(found) === JSON.stringify([failing, passing, nested]),
    `every *.test.mjs is found, subfolders included, in sorted order (got ${found.map((f) => path.relative(dir, f)).join(", ")})`);
  ok(!found.some((f) => path.basename(f) === "daemon-e2e.test.mjs"), "the daemon end-to-end test is left out");

  const results = runAll(found, { stdio: "ignore" });
  ok(results.length === 3, `a failing first file does not stop the run (ran ${results.length} of 3)`);
  ok(results.filter((r) => !r.passed).map((r) => r.file).join() === failing, "only the failing file is reported as failed");

  // The developer's bar settings, exported by a Claude Code session, do not reach the tests.
  const leak = write(path.join("env", "d-no-settings.test.mjs"),
    "process.exit(['DOOMBAR_PRESET', 'MUGSHOT_STATE', 'COLUMNS'].some((k) => k in process.env) ? 1 : 0);\n");
  const inherited = { ...process.env, DOOMBAR_PRESET: "/old/clone/presets/full.toml", MUGSHOT_STATE: "/x", COLUMNS: "238" };
  ok(runAll([leak], { stdio: "ignore", env: inherited })[0].passed === false,
    "a test sees settings passed to it as they are (the check below can fail)");
  ok(runAll([leak], { stdio: "ignore", env: testEnv(inherited) })[0].passed,
    "the runner's environment drops DOOMBAR_*, MUGSHOT_* and COLUMNS");
  ok(testEnv(inherited).PATH === inherited.PATH, "and keeps everything else");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
