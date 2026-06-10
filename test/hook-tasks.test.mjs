#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "hook.js");
let fails = 0;
const ok = (c, m) => { console.log((c?"  ok   ":"  FAIL ")+m); if(!c) fails++; };

// Malformed event must not crash the hook (would block tools in a live session).
function runHook(input, env = {}) {
  try {
    execFileSync(process.execPath, [HOOK], { input, encoding: "utf8", env: { ...process.env, ...env } });
    return 0;
  } catch (e) { return e.status ?? 1; }
}
ok(runHook("not json at all") === 0, "garbage stdin -> exit 0");
ok(runHook(JSON.stringify({ hook_event_name: "PostToolUse" /* no tool_input */ })) === 0, "missing tool_input -> exit 0");

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
