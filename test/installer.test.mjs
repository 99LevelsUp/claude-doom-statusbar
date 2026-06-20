#!/usr/bin/env node
// Behavioral round-trip test for bin/cli.js. The output settings.json cannot match the
// Python installer byte-for-byte (we write `node "…/src/*.js"`, not `"<python>" "…/*.py"`),
// so we assert behavior on a temp settings.json instead of diffing.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
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

function run(tmp, ...args) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: tmp, encoding: "utf-8" });
}
const settingsPath = (tmp) => path.join(tmp, ".claude", "settings.json");
const read = (tmp) => JSON.parse(readFileSync(settingsPath(tmp), "utf-8"));
const tmpdir = () => mkdtempSync(path.join(os.tmpdir(), "doombar-test-"));

// 1. empty {} -> install -> full structure present
{
  const tmp = tmpdir();
  run(tmp, "install", "--project", "--preset", "full");
  const cfg = read(tmp);
  ok(cfg.statusLine?.command?.includes("src/statusline.js".replace(/\//g, path.sep === "\\" ? "/" : "/")) ||
     cfg.statusLine?.command?.includes("src/statusline.js"), "statusLine points at src/statusline.js");
  ok(cfg.statusLine?.refreshInterval === 1, "statusLine refreshInterval is 1");
  ok(cfg.env?.DOOMBAR_PRESET?.includes("full.toml"), "DOOMBAR_PRESET -> full.toml");
  ok(cfg.env?.FORCE_HYPERLINK === "1", "FORCE_HYPERLINK = 1");
  const EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied",
    "Stop", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted"];
  ok(EVENTS.every((e) => Array.isArray(cfg.hooks?.[e]) && cfg.hooks[e].length === 1),
     "all 10 hook events present (incl. SessionStart) with one entry each");
  ok(EVENTS.every((e) => cfg.hooks[e][0].hooks[0].async === true),
     "every hook entry is async:true (off the blocking path)");
  rmSync(tmp, { recursive: true, force: true });
}

// 2. install twice -> arrays do NOT grow (THE idempotency assertion)
{
  const tmp = tmpdir();
  run(tmp, "install", "--project");
  run(tmp, "install", "--project");
  const cfg = read(tmp);
  const sizes = Object.values(cfg.hooks).map((a) => a.length);
  ok(sizes.every((n) => n === 1), `re-install did not double-add (hook sizes = ${sizes.join(",")})`);
  rmSync(tmp, { recursive: true, force: true });
}

// 3. foreign existing statusLine -> backup note + .bak written, user content preserved in .bak
{
  const tmp = tmpdir();
  mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  const foreign = { statusLine: { type: "command", command: "my-own-statusline" }, env: { MY_VAR: "keep" } };
  writeFileSync(settingsPath(tmp), JSON.stringify(foreign, null, 2));
  const out = run(tmp, "install", "--project");
  ok(/replaced your existing statusLine/.test(out), "emits 'replaced existing statusLine' note");
  ok(existsSync(settingsPath(tmp) + ".bak"), ".bak backup written");
  const bak = JSON.parse(readFileSync(settingsPath(tmp) + ".bak", "utf-8"));
  ok(bak.statusLine?.command === "my-own-statusline", ".bak contains the user's original statusLine");
  const cfg = read(tmp);
  ok(cfg.env?.MY_VAR === "keep", "unrelated env var preserved across install");
  rmSync(tmp, { recursive: true, force: true });
}

// 4. uninstall -> returns to pre-install state (clean removal of all our keys)
{
  const tmp = tmpdir();
  run(tmp, "install", "--project");
  run(tmp, "uninstall", "--project");
  const cfg = read(tmp);
  ok(cfg.statusLine === undefined, "statusLine removed");
  ok(cfg.hooks === undefined, "hooks removed (was empty after pruning)");
  ok(cfg.env === undefined, "env removed (was empty after pruning)");
  ok(Object.keys(cfg).length === 0, "settings.json is back to empty {}");
  rmSync(tmp, { recursive: true, force: true });
}

// 5. uninstall cleans up LEGACY Python entries too (a user who ran install.py earlier)
{
  const tmp = tmpdir();
  mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  const legacy = {
    statusLine: { type: "command", command: '"python" "/x/statusline.py"' },
    env: { DOOMBAR_PRESET: "/x/presets/full.toml", FORCE_HYPERLINK: "1" },
    hooks: { Stop: [{ hooks: [{ type: "command", command: '"python" "/x/hooks/mugshot_hook.py"' }] }] },
  };
  writeFileSync(settingsPath(tmp), JSON.stringify(legacy, null, 2));
  run(tmp, "uninstall", "--project");
  const cfg = read(tmp);
  ok(Object.keys(cfg).length === 0, "legacy Python install fully removed by JS uninstall");
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
