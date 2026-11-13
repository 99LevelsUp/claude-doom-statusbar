#!/usr/bin/env node
// What a status line tick costs through the bash client, against a running render daemon: the
// command the installer writes, run through the shell Claude Code uses (/bin/sh on Linux and
// macOS, Git Bash on Windows). Compare with scripts/measure-oneshot.mjs, which times the one-shot
// renderer the client replaces.
//
// Everything runs in a sandbox runtime directory with its own daemon. On Windows the daemon's
// pipe is one per installation, so a live daemon of this checkout makes the sandboxed one exit;
// the script then reports that it never saw a live frame.
//
// Usage: node scripts/measure-client.mjs [runs]

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, chmodSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootHash } from "../src/fold.js";
import { OFFLINE_MARKER } from "../src/platform/frame.js";
import { sandboxEnv } from "../test/_sandbox-env.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = Math.max(3, Number(process.argv[2]) || 21);
const WIN = process.platform === "win32";

const bashMajor = (bash) => {
  const r = spawnSync(bash, ["--norc", "--noprofile", "-c", 'echo "${BASH_VERSINFO[0]}"'], { encoding: "utf8" });
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
};
const bash = process.env.DOOMBAR_TEST_BASH || (WIN ? "C:/Program Files/Git/bin/bash.exe"
  : ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"].find((b) => existsSync(b) && bashMajor(b) >= 5));
if (!bash || !existsSync(bash)) {
  console.log(`platform ${process.platform} ${os.arch()}: no bash 5, so the installer keeps the one-shot renderer here`);
  process.exit(0);
}

const hash = rootHash(ROOT);
const client = path.join(ROOT, "src", "doombar-client.sh").replace(/\\/g, "/");
const cmd = WIN
  ? `DOOMBAR_ROOT_HASH=${hash}; f="${client}"; if [ -r "$f" ]; then . "$f"; else echo 'doombar: offline'; fi`
  : `b='${bash}'; f='${client}'; if [ -r "$f" ] && [ -x "$b" ]; then unset BASH_ENV; ` +
    `exec "$b" --norc --noprofile "$f" ${hash}; else echo 'doombar: offline'; fi`;
const shell = WIN ? bash : "/bin/sh";

const sandbox = mkdtempSync(path.join(os.tmpdir(), "doombar-client-cost-"));
if (!WIN) chmodSync(sandbox, 0o700);
const env = {
  ...process.env, ...sandboxEnv(sandbox), COLUMNS: "200",
  DOOMBAR_GLYPHS: "octant", DOOMBAR_PRESET: path.join(ROOT, "presets", "full.toml"),
  DOOMBAR_THEME: "doom", DOOMBAR_RATELIMITS_SHARE: "0", DOOMBAR_MSYS_REAP: "0",
};
const payload = JSON.stringify({
  session_id: "client-cost", cwd: ROOT, workspace: { current_dir: ROOT, project_dir: ROOT },
  model: { id: "claude-opus-5-5", display_name: "Opus" }, transcript_path: "",
  context_window: { used_percentage: 42, context_window_size: 200000 },
  cost: { total_cost_usd: 0.42, total_duration_ms: 120000, total_api_duration_ms: 30000 },
});

const tick = () => {
  const t = performance.now();
  const r = spawnSync(shell, ["-c", cmd], { input: payload, env, encoding: "utf8" });
  const out = String(r.stdout || "");
  const kind = out === "doombar: offline\n" ? "offline" : out.includes(OFFLINE_MARKER) ? "grey" : out.trim() ? "live" : "empty";
  return { ms: performance.now() - t, kind };
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let daemon;
try {
  tick(); // writes the session's payload, as the first tick of a session does
  daemon = spawn(process.execPath, [path.join(ROOT, "src", "daemon.js")], { env, stdio: "ignore" });
  let live = false;
  for (const end = Date.now() + 30000; Date.now() < end && !live; await sleep(300)) live = tick().kind === "live";
  if (!live) {
    console.log("the sandboxed daemon never served a live frame (on Windows: is this checkout's daemon running?)");
    process.exitCode = 1;
  } else {
    const runs = [];
    for (let i = 0; i < RUNS; i++) { runs.push(tick()); await sleep(50); }
    const notLive = runs.filter((r) => r.kind !== "live").length;
    console.log(`platform ${process.platform} ${os.arch()}, node ${process.version}, shell ${shell}, bash ${bash}`);
    console.log("status line tick through the bash client, against a running daemon:");
    console.log(`  median of ${RUNS}: ${median(runs.map((r) => r.ms)).toFixed(1)} ms (${notLive} not live)`);
  }
} finally {
  if (daemon) daemon.kill();
  await sleep(300);
  rmSync(sandbox, { recursive: true, force: true });
}
