#!/usr/bin/env node
// Every per-session file lives next to the checkpoint, so MUGSHOT_STATE relocates all of them.
//
// The probe markers, the advisor cache and the savings file used to go straight to the system
// temp dir whatever MUGSHOT_STATE said, so a sandboxed run (this test suite, for one) still
// wrote into the machine's real temp directory, where nothing could find or sweep them.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "src", "hook.js");
const STATUSLINE = path.join(HERE, "..", "src", "statusline.js");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const sandbox = mkdtempSync(path.join(os.tmpdir(), "doombar-files-"));
const elsewhere = mkdtempSync(path.join(os.tmpdir(), "doombar-files-elsewhere-"));
const sid = "filestest";

// The system temp dir points at `elsewhere` (TEMP/TMP on Windows, TMPDIR elsewhere);
// MUGSHOT_STATE puts the checkpoint in `sandbox`.
const env = {
  ...process.env,
  TEMP: elsewhere, TMP: elsewhere, TMPDIR: elsewhere,
  MUGSHOT_STATE: path.join(sandbox, `mugshot_${sid}.json`),
  DOOMBAR_MSYS_REAP: "0", DOOMBAR_THEME: "doom", DOOMBAR_RATELIMITS_SHARE: "0",
};
delete env.DOOMBAR_SAVINGS_STATE;
const ours = (dir) => readdirSync(dir).filter((n) => /^(mugshot_|savings_)/.test(n));

try {
  // --- Hook: SessionStart writes the git and msys probe markers ------------------------------
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid, cwd: sandbox }),
    encoding: "utf8", env,
  });
  ok(existsSync(path.join(sandbox, `mugshot_git_${sid}.json`)), "git marker lands next to the checkpoint");
  if (process.platform === "win32") {
    ok(existsSync(path.join(sandbox, `mugshot_msys_${sid}.json`)), "msys marker lands next to the checkpoint");
  }

  // --- Statusline: a render writes the advisor cache and the savings file --------------------
  const events = path.join(sandbox, "events.jsonl");
  writeFileSync(events, "");
  const transcript = path.join(sandbox, "transcript.jsonl");
  writeFileSync(transcript, JSON.stringify({
    timestamp: "2026-10-31T12:00:00.000Z",
    message: { content: [{ type: "advisor_tool_result" }] },
  }) + "\n");
  execFileSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify({ session_id: sid, cwd: sandbox, transcript_path: transcript }),
    encoding: "utf8",
    env: { ...env, DOOMBAR_EVENTS: events, COLUMNS: "120" },
  });
  ok(existsSync(path.join(sandbox, `mugshot_adv_${sid}.json`)), "advisor cache lands next to the checkpoint");
  ok(existsSync(path.join(sandbox, `savings_${sid}.json`)), "savings file lands next to the checkpoint");

  // DOOMBAR_SAVINGS_STATE still overrides the savings location.
  const explicit = path.join(sandbox, "explicit-savings.json");
  execFileSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify({ session_id: sid + "2", cwd: sandbox }),
    encoding: "utf8",
    env: { ...env, DOOMBAR_EVENTS: events, DOOMBAR_SAVINGS_STATE: explicit, COLUMNS: "120",
      MUGSHOT_STATE: path.join(sandbox, `mugshot_${sid}2.json`) },
  });
  ok(existsSync(explicit), "DOOMBAR_SAVINGS_STATE wins over the checkpoint's directory");

  // --- Nothing per-session reached the system temp dir --------------------------------------
  const leaked = ours(elsewhere).filter((n) => /_(filestest)/.test(n));
  ok(leaked.length === 0, `no per-session file in the system temp dir (found: ${leaked.join(", ") || "none"})`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
