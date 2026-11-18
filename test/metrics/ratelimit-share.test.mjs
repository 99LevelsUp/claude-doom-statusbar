#!/usr/bin/env node
// Account-wide rate limits are pooled across sessions: an idle chat shows the freshest
// reading any chat has seen, instead of its own stale one.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fresherWindow, mergeRateLimits } from "../../src/metrics/ratelimits.js";
import { sandboxEnv } from "../_sandbox-env.mjs";

const ROOT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");

const W = 2_000_000_000; // a resets_at (seconds)
const w = (p, r = W) => ({ used_percentage: p, resets_at: r });

// Pure merge rules.
ok(fresherWindow(w(12), w(16)).used_percentage === 16, "same window: the higher reading wins (usage only rises)");
ok(fresherWindow(w(16), w(12)).used_percentage === 16, "same window: a stale lower reading never wins");
ok(fresherWindow(w(16), w(30, W + 10)).used_percentage === 30, "resets_at a few seconds apart is still the same window");
ok(fresherWindow(w(90), w(2, W + 7 * 86400)).used_percentage === 2, "a later window wins even with a lower %, the old one reset");
ok(fresherWindow(w(2, W + 7 * 86400), w(90)).used_percentage === 2, "an older window's reading is ignored");
ok(fresherWindow(null, w(16)).used_percentage === 16, "no reading of my own -> take the shared one");
ok(fresherWindow(w(16), null).used_percentage === 16, "nothing shared -> keep my own");
ok(fresherWindow({ used_percentage: "x" }, null) === null, "malformed readings are ignored");
const NOW = W - 7200;
ok(fresherWindow(w(15, W - 3600), { used_percentage: 30 }, NOW).resets_at === W - 3600,
  "a reading that names its window beats a higher one without resets_at (the reset time stays)");
ok(fresherWindow({ used_percentage: 30 }, w(15, W - 3600), NOW).used_percentage === 15, "whichever side the unknown reading is on");
ok(fresherWindow(w(15, W - 3600), w(80, NOW - 60), NOW).used_percentage === 15, "a window that has already reset is stale, whatever its percentage");
ok(fresherWindow(w(80, NOW - 60), w(15, W - 3600), NOW).used_percentage === 15, "also when it is the session's own");
ok(fresherWindow({ used_percentage: 12 }, { used_percentage: 16 }, NOW).used_percentage === 16, "two unknown windows: the higher reading wins");
const m = mergeRateLimits({ five_hour: w(40, W - 3600), seven_day: w(12) }, { seven_day: w(16) });
ok(m.five_hour.used_percentage === 40 && m.seven_day.used_percentage === 16, "windows merge independently");

// End to end: two chats on one account, through the shared file.
const tmp = mkdtempSync(path.join(os.tmpdir(), "gamebar-rl-"));
try {
  const env = { ...process.env, GAMEBAR_THEME: "minecraft", COLUMNS: "120",
    GAMEBAR_RATELIMITS: path.join(tmp, "shared.json"), GAMEBAR_STATE: path.join(tmp, "state.json"),
    ...sandboxEnv(tmp), GAMEBAR_MSYS_REAP: "0" }; // state files stay in tmp
  delete env.GAMEBAR_RATELIMITS_SHARE;
  const render = (sid, rl, extraEnv = {}) => strip(execFileSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
    env: { ...env, ...extraEnv }, encoding: "utf8",
    input: JSON.stringify({ session_id: sid, cwd: tmp, model: { display_name: "Opus 5.5" }, ...(rl ? { rate_limits: rl } : {}) }),
  }));
  const level = (out) => (/━ (\d+) ━/.exec(out) || [])[1];

  ok(level(render("busy", { five_hour: w(40, W - 3600), seven_day: w(16) })) === "16", "the active chat shows its fresh 16");
  ok(level(render("idle", { five_hour: w(30, W - 3600), seven_day: w(12) })) === "16", "the idle chat (stale 12) shows 16 too");
  ok(level(render("new", null)) === "16", "a brand-new chat with no limits yet shows 16");
  ok(level(render("idle", { five_hour: w(30, W - 3600), seven_day: w(12) }, { GAMEBAR_RATELIMITS_SHARE: "0" })) === "12",
    "GAMEBAR_RATELIMITS_SHARE=0 keeps each chat's own numbers");
  ok(level(render("idle", { five_hour: w(30, W - 3600), seven_day: w(12) }, { DOOMBAR_RATELIMITS_SHARE: "0" })) === "12",
    "the old name, DOOMBAR_RATELIMITS_SHARE=0, still keeps each chat's own numbers");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// The pool a release before 1.0.0 kept, mugshot_ratelimits_global.json in the old runtime
// directory, is read while the new file is missing; the merge is written under the new name.
const old = mkdtempSync(path.join(os.tmpdir(), "gamebar-rl-old-"));
try {
  const env = { ...process.env, GAMEBAR_THEME: "minecraft", COLUMNS: "120", GAMEBAR_STATE: path.join(old, "state.json"),
    ...sandboxEnv(old), GAMEBAR_MSYS_REAP: "0" };
  for (const k of ["GAMEBAR_RATELIMITS", "DOOMBAR_RATELIMITS", "GAMEBAR_RATELIMITS_SHARE", "DOOMBAR_RATELIMITS_SHARE"]) delete env[k];
  writeFileSync(path.join(old, "mugshot_ratelimits_global.json"), JSON.stringify({ five_hour: w(40, W - 3600), seven_day: w(16) }));
  const out = strip(execFileSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
    env, encoding: "utf8", input: JSON.stringify({ session_id: "fresh", cwd: old, model: { display_name: "Opus 5.5" } }),
  }));
  ok((/━ (\d+) ━/.exec(out) || [])[1] === "16", "with only mugshot_ratelimits_global.json present, the shared rate limits load");
  let pooled = null;
  try { pooled = JSON.parse(readFileSync(path.join(old, "gamebar_ratelimits_global.json"), "utf8")); } catch {}
  ok(pooled?.seven_day?.used_percentage === 16, "and they are written to gamebar_ratelimits_global.json");
} finally {
  rmSync(old, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
