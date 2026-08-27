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
import { stalePids, parseBashShells } from "../src/hook.js";

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
  // DOOMBAR_MSYS_REAP=0 throughout: these subprocesses are real hooks, and on a Windows dev box
  // with a pile already forming they would reap the developer's own live statusLine wrappers.
  // The reaper's selection rule is covered purely below instead.
  const env = { ...process.env, MUGSHOT_STATE: checkpoint, DOOMBAR_GIT_TTL: "0", DOOMBAR_MSYS_REAP: "0" };
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
  const env0 = { ...process.env, MUGSHOT_STATE: checkpoint2, DOOMBAR_MSYS_TTL: "0", DOOMBAR_MSYS_REAP: "0" };
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
  // --- Reaper selection: pure and cross-platform, so it is tested everywhere. ------------
  // The reaper is the only thing in this package that kills a process, so its selection rule
  // has to be provably narrow: OUR statusline wrapper, and only once it has outlived a healthy
  // render (~300 ms) many times over. Everything else must survive untouched.
  const procs = [
    { pid: 101, ageMs: 30000, cmd: 'C:\\Program Files\\Git\\bin\\bash.exe -c "node \\"C:/x/claude-doom-statusbar/src/statusline.js\\""' },
    { pid: 102, ageMs: 30000, cmd: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe -c "node \\"C:/x/claude-doom-statusbar/src/statusline.js\\""' },
    { pid: 103, ageMs: 200, cmd: 'C:\\Program Files\\Git\\bin\\bash.exe -c "node \\"C:/x/src/statusline.js\\""' },
    { pid: 104, ageMs: 99999, cmd: 'C:\\Program Files\\Git\\bin\\bash.exe -c "npm test"' },
    { pid: 105, ageMs: 99999, cmd: "" },
  ];
  const picked = stalePids(procs, 10000);
  ok(picked.length === 2 && picked.includes(101) && picked.includes(102),
    `reaper picks both hung statusline wrappers, nothing else (got ${JSON.stringify(picked)})`);
  ok(!stalePids(procs, 10000).includes(103), "a young statusline wrapper is left alone (still rendering)");
  ok(!stalePids(procs, 10000).includes(104), "an unrelated long-running bash is never killed");
  ok(stalePids([], 10000).length === 0 && stalePids(null, 10000).length === 0,
    "empty / missing process list yields nothing to reap");
  ok(stalePids([{ pid: 0, ageMs: 99999, cmd: "statusline.js" }], 10000).length === 0,
    "pid 0 is rejected (never taskkill a bogus pid)");
  ok(stalePids([{ pid: 106, ageMs: NaN, cmd: "statusline.js" }], 10000).length === 0,
    "an unparsable age is treated as not-yet-stale");

  // --- Enumerator parse: only the first two "|" are structural. -------------------------
  // The wrapper we reap is literally `bash -c "node …"`, so a piped inner command is normal
  // and must not truncate the command line we match `statusline.js` against.
  const rows = parseBashShells([
    '1234|45678|"C:\\Program Files\\Git\\bin\\bash.exe" -c "node statusline.js | grep foo"',
    "5678|10|C:\\x\\bash.exe -c \"npm test\"",
    "not-a-row",
    "",
  ].join("\r\n"));
  ok(rows.length === 2, `parses 2 rows, skips garbage and blanks (got ${rows.length})`);
  ok(rows[0].cmd.endsWith('| grep foo"'), "a pipe inside the command line survives the split");
  ok(rows[0].pid === 1234 && rows[0].ageMs === 45678, "pid and age parsed as numbers");
  ok(stalePids(rows, 10000).length === 1 && stalePids(rows, 10000)[0] === 1234,
    "the piped statusline wrapper is still recognised as reapable");

  // --- Render-side reaping must never slow the 1 Hz tick down. -------------------------
  // The refresh interval is 1 s on every platform, so idle sessions rely on the RENDER to reap
  // (no hook events arrive when idle). That kick has to be detached and throttled: if a render
  // ever waited on the reaper, a 1 s tick would be impossible on Windows.
  const renderOnce = (extraEnv) => {
    const t0 = Date.now();
    const r = execFileSync(process.execPath,
      [path.join(HERE, "..", "src", "statusline.js")], {
      input: JSON.stringify({ session_id: "reaptick-" + process.pid, cwd: tmp,
        model: { id: "claude-opus-5" }, context_window: { context_window_size: 1000000, used_tokens: 1000 } }),
      encoding: "utf8",
      env: { ...process.env, MUGSHOT_STATE: path.join(tmp, "rt.json"), COLUMNS: "120", ...extraEnv },
    });
    return { ms: Date.now() - t0, out: r };
  };

  const first = renderOnce({ DOOMBAR_REAP_TICK: "0" }); // throttle open -> a reap IS kicked off
  ok(first.out.trim().length > 0, "render still produces output with the reaper armed");
  ok(first.ms < 3000, `render did not wait for the reaper (${first.ms} ms, must stay well under 1 s tick)`);

  // Throttled: a huge tick means the second render must skip the kick entirely.
  const second = renderOnce({ DOOMBAR_REAP_TICK: "999999" });
  ok(second.out.trim().length > 0, "render output unaffected when the reap throttle is closed");

  // And it must be switchable off outright.
  const off = renderOnce({ DOOMBAR_MSYS_REAP: "0", DOOMBAR_REAP_TICK: "0" });
  ok(off.out.trim().length > 0, "DOOMBAR_MSYS_REAP=0 leaves rendering intact");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
