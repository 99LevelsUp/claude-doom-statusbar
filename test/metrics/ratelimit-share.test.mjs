#!/usr/bin/env node
// Account-wide rate limits are pooled across sessions: an idle chat shows the freshest
// reading any chat has seen, instead of its own stale one.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fresherWindow, mergeRateLimits } from "../src/statusline.js";
import { sandboxEnv } from "./_sandbox-env.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const m = mergeRateLimits({ five_hour: w(40, W - 3600), seven_day: w(12) }, { seven_day: w(16) });
ok(m.five_hour.used_percentage === 40 && m.seven_day.used_percentage === 16, "windows merge independently");

// End to end: two chats on one account, through the shared file.
const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-rl-"));
try {
  const env = { ...process.env, DOOMBAR_THEME: "minecraft", COLUMNS: "120",
    DOOMBAR_RATELIMITS: path.join(tmp, "shared.json"), MUGSHOT_STATE: path.join(tmp, "state.json"),
    ...sandboxEnv(tmp), DOOMBAR_MSYS_REAP: "0" }; // state files stay in tmp
  delete env.DOOMBAR_RATELIMITS_SHARE;
  const render = (sid, rl, extraEnv = {}) => strip(execFileSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
    env: { ...env, ...extraEnv }, encoding: "utf8",
    input: JSON.stringify({ session_id: sid, cwd: tmp, model: { display_name: "Opus 5.5" }, ...(rl ? { rate_limits: rl } : {}) }),
  }));
  const level = (out) => (/━ (\d+) ━/.exec(out) || [])[1];

  ok(level(render("busy", { five_hour: w(40, W - 3600), seven_day: w(16) })) === "16", "the active chat shows its fresh 16");
  ok(level(render("idle", { five_hour: w(30, W - 3600), seven_day: w(12) })) === "16", "the idle chat (stale 12) shows 16 too");
  ok(level(render("new", null)) === "16", "a brand-new chat with no limits yet shows 16");
  ok(level(render("idle", { five_hour: w(30, W - 3600), seven_day: w(12) }, { DOOMBAR_RATELIMITS_SHARE: "0" })) === "12",
    "DOOMBAR_RATELIMITS_SHARE=0 keeps each chat's own numbers");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
