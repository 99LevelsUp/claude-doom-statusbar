#!/usr/bin/env node
// End-to-end smoke test: module byte-parity proves each piece in isolation, but only the
// installer makes the HUD run live. This installs into a temp project, then runs the EXACT
// statusLine command the installer wrote into settings.json — through a shell, with the
// DOOMBAR_PRESET it set — and asserts a non-empty HUD comes out. This is the check that
// catches "`node` not on PATH" and any wiring drift the structural test can't see.

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "cli.js");

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { console.log(`  FAIL ${msg}`); failures++; }
};

const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-smoke-"));
try {
  execFileSync(process.execPath, [CLI, "install", "--project", "--preset", "full"], { cwd: tmp });
  const cfg = JSON.parse(readFileSync(path.join(tmp, ".claude", "settings.json"), "utf-8"));
  const cmd = cfg.statusLine.command; // e.g.  node "<root>/src/statusline.js"
  const preset = cfg.env.DOOMBAR_PRESET;

  const sample = JSON.stringify({
    cwd: tmp,
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    workspace: { current_dir: tmp },
  });

  // Run it the way Claude Code does: through a shell, command verbatim from settings.json.
  const out = execSync(cmd, {
    input: sample,
    encoding: "utf-8",
    env: { ...process.env, DOOMBAR_PRESET: preset, COLUMNS: "100", FORCE_HYPERLINK: "1" },
  });

  ok(out.length > 0, `wired command produced output (${out.length} bytes)`);
  ok(out.split("\n").some((l) => l.trim().length > 0), "at least one non-empty HUD line");
  ok(/\x1b\[/.test(out), "output contains ANSI styling (a real HUD, not plain text)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nSMOKE PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
