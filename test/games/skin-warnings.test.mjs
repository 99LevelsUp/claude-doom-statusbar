#!/usr/bin/env node
// The warning line under the bar in the one-shot status line (src/statusline.js). Each render is a
// new process, so when a warning first appeared is kept in a file in the runtime directory: the
// line shows while the warning is younger than WARNING_SECONDS, then goes, and a new process does
// not show it again while the cause lasts; a cause that ended and came back shows again.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";
import { WARNING_SECONDS } from "../../src/kit/skin/warnings.js";
import { WARNINGS_FILE } from "../../src/statusline.js";
import { staleStateFiles } from "../../src/platform/sweep.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");

const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-skin-warnings-"));
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GAMEBAR|DOOMBAR|MUGSHOT)_/i.test(k)));
  Object.assign(env, sandboxEnv(SB), { GAMEBAR_MSYS_REAP: "0", GAMEBAR_RATELIMITS_SHARE: "0", COLUMNS: "120",
    GAMEBAR_THEME_FILE: path.join(SB, "theme.json"), GAMEBAR_STATE: path.join(SB, "state.json"), GAMEBAR_SKIN: "warned" });
  // A user skin whose root container has a parameter no descriptor knows: one warning.
  const dir = path.join(env.GAMEBAR_USER_DIR, "skins", "warned");
  mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(ROOT, "test", "fixtures", "skins", "unknown-root-param.toml"), path.join(dir, "warned.toml"));
  const seen = path.join(SB, WARNINGS_FILE);
  const render = () => strip(execFileSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
    env, encoding: "utf8", input: JSON.stringify({ session_id: "warned", model: { display_name: "Opus 5.5" } }),
  })).trimEnd().split("\n");

  const first = render();
  ok(first.some((l) => l.startsWith("gamebar: ") && l.includes("glow")), `the first render shows the warning line (${JSON.stringify(first)})`);
  ok(existsSync(seen), `and keeps when it first appeared in the runtime directory (${WARNINGS_FILE})`);
  const second = render();
  ok(second.some((l) => l.startsWith("gamebar: ")), "a render right after it, in a new process, still shows it");

  // The same file, as it would read WARNING_SECONDS later, the cause there on every render since.
  const times = JSON.parse(readFileSync(seen, "utf8"));
  const shifted = (back) => Object.fromEntries(Object.entries(times).map(([k, t]) => [k, back(t)]));
  writeFileSync(seen, JSON.stringify(shifted((t) => ({ first: t.first - WARNING_SECONDS, last: t.last }))));
  const later = render();
  ok(!later.some((l) => l.startsWith("gamebar: ")) && later.length === first.length - 1,
    `${WARNING_SECONDS} s after it first appeared, the warning line is gone (${JSON.stringify(later)})`);

  // The cause ended (not seen for more than WARNING_SECONDS) and is back: it shows again.
  writeFileSync(seen, JSON.stringify(shifted((t) => ({ first: t.first - 10 * WARNING_SECONDS, last: t.last - WARNING_SECONDS - 1 }))));
  const back = render();
  ok(back.some((l) => l.startsWith("gamebar: ") && l.includes("glow")), `a cause that ended and came back shows again (${JSON.stringify(back)})`);

  ok(staleStateFiles([WARNINGS_FILE], () => 1e12).length === 0, "the stale-state sweep never takes the file");
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
