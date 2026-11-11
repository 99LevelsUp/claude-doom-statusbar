#!/usr/bin/env node
// End-to-end smoke test: module byte-parity proves each piece in isolation, but only the
// installer makes the HUD run live. This installs into a temp project, then runs the EXACT
// statusLine command the installer wrote into settings.json — through a shell, with the
// DOOMBAR_PRESET it set — and asserts a non-empty HUD comes out. This is the check that
// catches "`node` not on PATH" and any wiring drift the structural test can't see.

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./_sandbox-env.mjs";

// Pin the DOOM theme so a theme saved on this machine (`theme minecraft`) can't change
// what the statusline renders under test. Child processes inherit it via process.env.
process.env.DOOMBAR_THEME = "doom";
// Likewise keep the rate limits other live sessions shared on this machine out of the test.
process.env.DOOMBAR_RATELIMITS_SHARE = "0";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "cli.js");

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { console.log(`  FAIL ${msg}`); failures++; }
};

const ROOT = path.resolve(HERE, "..");
const OLD_CMD = `node "${ROOT.replace(/\\/g, "/")}/src/statusline.js"`;

// The Git Bash Claude Code would use for the statusLine on Windows (the places the installer looks).
const gitBash = () => [process.env.CLAUDE_CODE_GIT_BASH_PATH,
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
  process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  "C:/Program Files/Git/bin/bash.exe",
].find((p) => p && existsSync(p));

const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-smoke-"));
// TEMP/TMP/TMPDIR -> tmp: the render's state files and the client's payload land here, not in
// the real temp dir (where this checkout's live daemon may be reading).
const tmpEnv = { ...sandboxEnv(tmp) };
try {
  execFileSync(process.execPath, [CLI, "install", "--project", "--preset", "full"],
    { cwd: tmp, env: { ...process.env, ...tmpEnv } });
  const cfg = JSON.parse(readFileSync(path.join(tmp, ".claude", "settings.json"), "utf-8"));
  const cmd = cfg.statusLine.command;
  const preset = cfg.env.DOOMBAR_PRESET;
  const env = { ...process.env, DOOMBAR_PRESET: preset, COLUMNS: "100", FORCE_HYPERLINK: "1",
    ...tmpEnv, DOOMBAR_MSYS_REAP: "0" };

  const sample = JSON.stringify({
    session_id: "smoke-1",
    cwd: tmp,
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    workspace: { current_dir: tmp },
  });

  const client = cmd.includes("doombar-client.sh");
  if (client) {
    // Windows with Git Bash: Claude Code runs the command as `bash -c '<command>'`. No daemon
    // serves this sandbox temp dir, so the client prints the offline line.
    const bash = gitBash();
    ok(Boolean(bash), "found the Git Bash the installer chose the client for");
    const out = execFileSync(bash, ["-c", cmd], { input: sample, encoding: "utf-8", env });
    ok(out === "doombar: offline\n", `client command prints the offline line with no daemon (got: ${JSON.stringify(out)})`);
    const hash = /^DOOMBAR_ROOT_HASH=([0-9a-f]+);/.exec(cmd)?.[1];
    ok(Boolean(hash) && existsSync(path.join(tmp, `mugshot_payload_${hash}_smoke-1.json`)),
      "the install hash reached the sourced client (payload written under it)");
    const missing = cmd.replace("src/doombar-client.sh", "src/no-such-client.sh");
    const out2 = execFileSync(bash, ["-c", missing], { input: sample, encoding: "utf-8", env });
    ok(out2 === "doombar: offline\n", `a missing client prints the offline line (got: ${JSON.stringify(out2)})`);
  }

  // The one-shot renderer, run the way Claude Code does: through a shell, command verbatim.
  const out = execSync(client ? OLD_CMD : cmd, { input: sample, encoding: "utf-8", env });

  ok(out.length > 0, `wired command produced output (${out.length} bytes)`);
  ok(out.split("\n").some((l) => l.trim().length > 0), "at least one non-empty HUD line");
  ok(/\x1b\[/.test(out), "output contains ANSI styling (a real HUD, not plain text)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nSMOKE PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
