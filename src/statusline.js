#!/usr/bin/env node
// Claude Code statusLine — the live DOOM HUD wired to real session data.
// Port of statusline.py. Reads the statusline JSON on stdin and prints the bar that
// renderSession (src/render.js) builds from it.
//
// settings.json:
//   "statusLine": { "type": "command",
//       "command": "node /abs/path/src/statusline.js", "refreshInterval": 1 }
// Config: $DOOMBAR_PRESET (default presets/standard.toml), or the theme picked with
// `claude-doom-statusbar theme` (see theme.js)  State: $MUGSHOT_STATE

import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRuntimeDir } from "./platform/runtime.js";
import { SRC_DIR } from "./package-root.js";
import { renderSession } from "./render.js";

// --- Idle-time MSYS reaping -----------------------------------------------------------------
// The hook reaps hung Git Bash wrappers on every event, but while the session sits idle no events
// arrive — and idle is precisely when the 1 s refresh timer is the ONLY thing spawning shells. So
// the render kicks the reaper too. Two rules keep this off the hot path:
//
//   * detached + unref'd + stdio ignored — we never wait for it, so a render costs one ~1 ms
//     spawn call regardless of how long the reap takes;
//   * throttled by a marker file, so at 1 Hz this fires once per REAP_TICK, not 60× a minute.
//
// This is the one spawn on the render path, and it is the cure rather than a cause: it launches
// node directly (never a shell), and only when the throttle has elapsed.
const REAP_TICK = Number.isFinite(Number(process.env.DOOMBAR_REAP_TICK))
  ? Number(process.env.DOOMBAR_REAP_TICK)
  : 15000; // ms

function maybeReap() {
  if (process.platform !== "win32") return;
  if (process.env.DOOMBAR_MSYS_REAP === "0") return;
  const marker = path.join(os.tmpdir(), "mugshot_reap_tick.json");
  try {
    const m = JSON.parse(readFileSync(marker, "utf8"));
    if (Date.now() - (m.ts || 0) < REAP_TICK) return;
  } catch { /* no marker yet -> reap now */ }
  try { writeFileSync(marker, JSON.stringify({ ts: Date.now() })); } catch { return; }
  try {
    const hook = path.join(SRC_DIR, "hook.js");
    const child = spawn(process.execPath, [hook, "--reap"],
      { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch { /* the HUD is already rendered; a failed reap is not worth a crash */ }
}

function main() {
  // The render reads and writes its state in the runtime directory. One that is not private
  // (another user created it, or it is a link) may hold planted files, so nothing is read from it.
  if (!ensureRuntimeDir()) { process.stdout.write("doombar: offline\n"); return; }
  let data = {};
  try { data = JSON.parse(readFileSync(0, "utf8")); } catch { data = {}; }
  const lines = renderSession({ data, env: process.env, now: Date.now() / 1000 });
  process.stdout.write(lines.join("\n") + "\n");
  maybeReap(); // after the write: the HUD is already out, this only cleans up behind it
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
