#!/usr/bin/env node
// MSYS "bash flood" gauge: the async hook counts live bash.exe (win32 only) and snapshots it
// into the journal as an `msys` line; statusline folds it into state.msys; activityValues
// renders it as sys.zombies. Counting never touches the render hot path (it piggybacks the
// throttled git-snapshot event), and never spawns bash — it uses tasklist, a direct exe.
//
// The fold + render path is pure and cross-platform, so it is tested unconditionally with a
// synthetic journal line. The real hook -> bashCount path is win32-only, so it is asserted
// per-platform: a line on Windows, no line elsewhere (bashCount returns null -> field hidden).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, activityValues } from "../src/statusline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "src", "hook.js");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-msys-"));
const checkpoint = path.join(tmp, "state.json");
const journal = checkpoint + ".jsonl";

try {
  // --- Pure path: synthetic msys line folds into state.msys and renders as sys.zombies. ---
  process.env.MUGSHOT_STATE = checkpoint;
  const sid = "msystest-" + process.pid;
  const now = Date.now() / 1000;
  writeFileSync(journal, JSON.stringify({ name: "msys", ev: { msys: { n: 11 } }, ts: now }) + "\n");

  const st = loadState({ session_id: sid });
  ok(st.msys?.n === 11, `loadState folded msys snapshot into state.msys (got ${JSON.stringify(st.msys)})`);
  const v = activityValues(st, now);
  ok(v["sys.zombies"] === "11", `sys.zombies rendered from snapshot (got ${JSON.stringify(v["sys.zombies"])})`);

  // A state without an msys snapshot must not invent the field (non-win32 / no data).
  const v0 = activityValues({ errors: 0 }, now);
  ok(!("sys.zombies" in v0), "sys.zombies absent when no msys snapshot in state");

  // --- Real hook path: win32 snapshots a count; other platforms emit nothing. ---
  const sid2 = "msyshook-" + process.pid;
  const env = { ...process.env, MUGSHOT_STATE: checkpoint, DOOMBAR_GIT_TTL: "0" };
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid2, cwd: tmp }),
    encoding: "utf8", env,
  });
  const lines = readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const msysLine = lines.find((l) => l.name === "msys");

  if (process.platform === "win32") {
    ok(!!msysLine, "win32: hook appended an msys snapshot line");
    ok(typeof msysLine?.ev?.msys?.n === "number" && msysLine.ev.msys.n >= 0,
      `win32: msys snapshot carries a non-negative count (got ${JSON.stringify(msysLine?.ev?.msys?.n)})`);
  } else {
    ok(!msysLine, "non-win32: hook emits no msys line (bashCount returns null)");
  }

  // Regression: the count must refresh on NON-write events too (it has its own time-based gate,
  // not git's write-tool gate). PowerShell is not a WRITE_TOOL, so before the decoupling this
  // event produced no msys line and a captured spike would stick on the HUD. MSYS_TTL=0 = no
  // throttle. Isolated in its own checkpoint/journal so only this event's output is inspected.
  const checkpoint2 = path.join(tmp, "state-rw.json");
  const journal2 = checkpoint2 + ".jsonl";
  const sid3 = "msysrw-" + process.pid;
  const env0 = { ...process.env, MUGSHOT_STATE: checkpoint2, DOOMBAR_MSYS_TTL: "0" };
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: sid3, tool_name: "PowerShell", cwd: tmp }),
    encoding: "utf8", env: env0,
  });
  const rwLines = readFileSync(journal2, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rwMsys = rwLines.find((l) => l.name === "msys");
  if (process.platform === "win32") {
    ok(!!rwMsys, "win32: msys snapshot fires on a non-write event (decoupled from git's write gate)");
  } else {
    ok(!rwMsys, "non-win32: still no msys line on a non-write event");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
