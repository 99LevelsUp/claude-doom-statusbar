#!/usr/bin/env node
// Every per-session file lives next to the checkpoint, so MUGSHOT_STATE relocates all of them.
//
// The probe markers, the advisor cache and the savings file used to go straight to the system
// temp dir whatever MUGSHOT_STATE said, so a sandboxed run (this test suite, for one) still
// wrote into the machine's real temp directory, where nothing could find or sweep them.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
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

  // --- A failed atomic write leaves no .tmp behind --------------------------------------------
  // Make the rename target a directory, so writing the .tmp succeeds and the rename fails (on
  // Windows a target held open by another process fails the same way).
  {
    const dir = mkdtempSync(path.join(os.tmpdir(), "doombar-files-rename-"));
    const checkpoint = path.join(dir, "mugshot_blocked.json");
    const shared = path.join(dir, "shared-limits.json");
    mkdirSync(checkpoint);
    mkdirSync(shared);
    // A journal line to fold, so the render reaches the checkpoint write.
    writeFileSync(checkpoint + ".jsonl", JSON.stringify({ name: "Stop", ev: {}, ts: 1 }) + "\n");
    const renderBlocked = () => execFileSync(process.execPath, [STATUSLINE], {
      input: JSON.stringify({ session_id: "blocked", cwd: dir,
        rate_limits: { five_hour: { used_percentage: 20, resets_at: 1793500000 } } }),
      encoding: "utf8",
      env: { ...env, MUGSHOT_STATE: checkpoint, DOOMBAR_RATELIMITS: shared,
        DOOMBAR_RATELIMITS_SHARE: "1", COLUMNS: "120" },
    });
    const out = renderBlocked();
    ok(out.trim().length > 0, "a render whose state writes fail still prints the HUD");
    const tmps = readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    ok(tmps.length === 0, `failed checkpoint and rate-limit renames leave no .tmp (found: ${tmps.join(", ") || "none"})`);
    rmSync(dir, { recursive: true, force: true });
  }

  // --- Nothing per-session reached the system temp dir --------------------------------------
  const leaked = ours(elsewhere).filter((n) => /_(filestest)/.test(n));
  ok(leaked.length === 0, `no per-session file in the system temp dir (found: ${leaked.join(", ") || "none"})`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
