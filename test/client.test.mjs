#!/usr/bin/env node
// The bash statusLine client: Claude Code sources it into the bash it starts every tick, pipes
// the session JSON on stdin and prints whatever it writes to stdout. It hands the payload to the
// render daemon and prints the frame for the current moment, starting no process of its own.
//
// Every run goes through the real Git Bash (never cmd.exe) the way the statusLine command will:
//   DOOMBAR_ROOT_HASH=<hash> . "<root>/src/doombar-client.sh"
// Frames are built with the node-side reference serializer, so client and daemon agree on the format.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serializeFrame, greyLines } from "../src/frame.js";
import { sidKey, sessionPaths } from "../src/fold.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "src", "doombar-client.sh").replace(/\\/g, "/");
const WIN = process.platform === "win32";
// Claude Code runs the statusLine through Git Bash on Windows; elsewhere (CI) the system bash.
const BASH = process.env.DOOMBAR_TEST_BASH || (WIN ? "C:/Program Files/Git/bin/bash.exe" : "bash");
const HASH = "abc1234567";
const OFFLINE = "doombar: offline\n";
const FORWARDED = ["COLUMNS", "DOOMBAR_PRESET", "DOOMBAR_THEME", "DOOMBAR_TEXT_OVERFLOW",
  "DOOMBAR_INDENT", "DOOMBAR_FRAME_WINDOW", "MUGSHOT_STATE", "CLAUDE_CODE_TASK_LIST_ID", "CLAUDE_CONFIG_DIR",
  "WT_SESSION", "TERM_PROGRAM", "TMUX", "DOOMBAR_GLYPHS", "DOOMBAR_FACE_RENDERER"];

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const show = (s) => JSON.stringify(s);

const sandbox = mkdtempSync(path.join(os.tmpdir(), "doombar-client-"));

// The child sees only the sandbox as its temp dir, and none of the developer's own bar settings.
const baseEnv = { ...process.env, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox };
for (const k of FORWARDED) delete baseEnv[k];

const nowMicros = () => Date.now() * 1000;
const fileName = (sid, kind) => path.basename(sessionPaths(sid, HASH)[kind]);
const inSandbox = (sid, kind) => path.join(sandbox, fileName(sid, kind));
const putFrame = (sid, text) => writeFileSync(inSandbox(sid, "frame"), text);
const text = (lines) => lines.join("\n") + "\n";

// prefix: shell text placed in front of the source (extra assignments, test hooks).
function run({ sid, input, env = {}, prefix = "", hash = HASH } = {}) {
  const stdin = input ?? JSON.stringify({ session_id: sid, model: { id: "claude-opus-5" } });
  const cmd = `${prefix}${hash ? `DOOMBAR_ROOT_HASH=${hash} ` : ""}. "${CLIENT}"`;
  const t0 = process.hrtime.bigint();
  const r = spawnSync(BASH, ["-c", cmd], { input: stdin, env: { ...baseEnv, ...env }, encoding: "utf8" });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { out: r.stdout, err: r.stderr, status: r.status, ms, error: r.error };
}

// Body text that would trip a naive parser: ANSI colour, an empty line, lines that read like
// frame structure, glob characters, backslashes and things bash would expand if it evaluated them.
const BODY = [
  "\x1b[1;38;2;224;84;64mHP 78%\x1b[22m \x1b[48;2;96;200;104m ok \x1b[0m",
  "",
  "\x01leading and inner\x01 control byte",
  "slot 5 1",
  "grey 1",
  "  * [x] ? \\n \\ $HOME ${PATH} $(echo no) `echo no` 100%  ",
];

try {
  // --- Live single slot ----------------------------------------------------------------
  {
    const sid = "live-one";
    const now = nowMicros();
    putFrame(sid, serializeFrame({ daemon: "0.14.0", deadline: now + 60e6, slots: [{ start: now - 1e6, lines: BODY }] }));
    const r = run({ sid });
    ok(r.out === text(BODY), `live one-slot frame prints its body exactly (got ${show(r.out)})`);
    ok(r.err === "", `live run writes nothing to stderr (got ${show(r.err)})`);
  }

  // --- A full-size frame stays fast ------------------------------------------------------
  {
    // About 60 kB of truecolour half-block art. A walk that cut the frame line by line with
    // ${rest%%<LF>*} took about 200 ms on this size; the bound below only catches gross slowness.
    const sid = "large";
    const seg = "\x1b[38;2;200;100;50m██\x1b[48;2;10;20;30m▀▄";
    const lines = Array.from({ length: 8 }, (_, i) => seg.repeat(80) + " line " + i);
    const now = nowMicros();
    putFrame(sid, serializeFrame({ daemon: "0.14.0", deadline: now + 60e6, slots: [{ start: now, lines }] }));
    const r = run({ sid });
    ok(r.out === text(lines), "a full-size frame prints its body exactly");
    ok(r.ms < 1000, `one client run on a full-size frame stays well under the 1 s tick (${r.ms.toFixed(0)} ms)`);
  }

  // --- Deadline passed: the greyed copy ------------------------------------------------
  {
    const sid = "past-deadline";
    const now = nowMicros();
    putFrame(sid, serializeFrame({ daemon: "0.14.0", deadline: now - 60e6, slots: [{ start: now - 90e6, lines: BODY }] }));
    const r = run({ sid });
    ok(r.out === text(greyLines(BODY)), `a frame past its deadline prints the greyed copy (got ${show(r.out)})`);
  }

  // --- No frame file / unusable frame file -> built-in offline line ---------------------
  {
    const r = run({ sid: "never-rendered" });
    ok(r.out === OFFLINE, `no frame file prints the built-in offline line (got ${show(r.out)})`);
    ok(r.err === "", `missing frame writes nothing to stderr (got ${show(r.err)})`);

    const now = nowMicros();
    const good = serializeFrame({ daemon: "0.14.0", deadline: now + 60e6, slots: [{ start: now, lines: ["x"] }] });
    putFrame("future-contract", good.replace(" v=1 ", " v=2 "));
    ok(run({ sid: "future-contract" }).out === OFFLINE, "an unknown contract version prints the built-in offline line");
    putFrame("zero-contract", good.replace(" v=1 ", " v=0 "));
    ok(run({ sid: "zero-contract" }).out === OFFLINE, "contract version 0 prints the built-in offline line");
    putFrame("truncated", good.slice(0, good.length - 3));
    ok(run({ sid: "truncated" }).out === OFFLINE, "a truncated frame prints the built-in offline line");
    putFrame("trailing", good + "junk\n");
    ok(run({ sid: "trailing" }).out === OFFLINE, "a frame with text after the grey section prints the offline line");
    putFrame("short-body", good.replace("slot " + now + " 1", "slot " + now + " 9"));
    ok(run({ sid: "short-body" }).out === OFFLINE, "a slot claiming more lines than the file holds prints the offline line");
    putFrame("garbage", "hello\n");
    ok(run({ sid: "garbage" }).out === OFFLINE, "a file that is not a frame prints the offline line");
    putFrame("empty", "");
    ok(run({ sid: "empty" }).out === OFFLINE, "an empty frame file prints the offline line");
    putFrame("unknown-key", good.replace(" slots=1", " future=yes slots=1"));
    ok(run({ sid: "unknown-key" }).out === "x\n", "unknown header keys are ignored");

    putFrame("no-hash", good);
    const nh = run({ sid: "no-hash", hash: "" });
    ok(nh.out === OFFLINE, `without the install hash the client prints the offline line (got ${show(nh.out)})`);
  }

  // --- Three slots: the one for the current moment --------------------------------------
  {
    const now = nowMicros();
    const slots = [
      { start: now - 60e6, lines: ["first"] },
      { start: now - 30e6, lines: ["second", "two lines"] },
      { start: now + 30e6, lines: ["third"] },
    ];
    putFrame("reel", serializeFrame({ daemon: "0.14.0", deadline: now + 120e6, slots }));
    const r = run({ sid: "reel" });
    ok(r.out === "second\ntwo lines\n", `three-slot frame prints the latest slot that has started (got ${show(r.out)})`);

    const future = slots.map((s, i) => ({ ...s, start: now + (i + 1) * 30e6 }));
    putFrame("reel-early", serializeFrame({ daemon: "0.14.0", deadline: now + 120e6, slots: future }));
    const e = run({ sid: "reel-early" });
    ok(e.out === "first\n", `before any slot has started the first slot is printed (got ${show(e.out)})`);
  }

  // --- Session key: same file name as sidKey ---------------------------------------------
  {
    // Non-ASCII on purpose: sidKey counts UTF-16 units, so é is one "_" and the emoji two,
    // whatever locale the bash runs in.
    const sid = 'odd id/with:"quotes"\\back*slash?[x]é😀.' + "x".repeat(60);
    const key = sidKey(sid);
    ok(key.length === 48 && sid.length > 48, "precondition: the id is longer than the 48-character key");
    const now = nowMicros();
    putFrame(sid, serializeFrame({ daemon: "0.14.0", deadline: now + 60e6, slots: [{ start: now, lines: ["keyed"] }] }));
    const r = run({ sid });
    ok(r.out === "keyed\n", `an id with odd characters finds the frame sidKey names (got ${show(r.out)})`);
    ok(existsSync(inSandbox(sid, "payload")), `the payload lands under sidKey's name (${fileName(sid, "payload")})`);
    const cz = run({ sid, env: { LANG: "cs_CZ.UTF-8", LC_ALL: "cs_CZ.UTF-8" } });
    ok(cz.out === "keyed\n", `the same key under a Czech UTF-8 locale (got ${show(cz.out)})`);

    putFrame("", serializeFrame({ daemon: "0.14.0", deadline: now + 60e6, slots: [{ start: now, lines: ["anon"] }] }));
    ok(run({ input: JSON.stringify({ model: { id: "x" } }) }).out === "anon\n", "a payload without session_id uses the default key");
    ok(run({ input: JSON.stringify({ session_id: "" }) }).out === "anon\n", "an empty session_id uses the default key");
  }

  // --- Payload file: environment line, then the stdin JSON as-is --------------------------
  {
    const sid = "payload-env";
    const json = JSON.stringify({ session_id: sid, cwd: "C:\\work", nested: { a: [1, 2] } }, null, 2) + "\n";
    const r = run({ sid, input: json, env: { COLUMNS: "137", DOOMBAR_PRESET: "compact", DOOMBAR_THEME: "do\tom\nx", DOOMBAR_INDENT: "",
      CLAUDE_CODE_TASK_LIST_ID: "list-7", CLAUDE_CONFIG_DIR: "C:\\cfg\\claude" } });
    const payload = existsSync(inSandbox(sid, "payload")) ? readFileSync(inSandbox(sid, "payload"), "utf8") : "";
    const nl = payload.indexOf("\n");
    const envLine = payload.slice(0, nl);
    ok(envLine === "doombar-env\tCOLUMNS=137\tDOOMBAR_PRESET=compact\tDOOMBAR_THEME=doomx\tDOOMBAR_INDENT=\tCLAUDE_CODE_TASK_LIST_ID=list-7\tCLAUDE_CONFIG_DIR=C:\\cfg\\claude",
      `environment line forwards set variables, drops tabs and newlines in values (got ${show(envLine)})`);
    ok(payload.slice(nl + 1) === json, "the stdin JSON follows the environment line byte for byte");

    // The terminal's identity travels too, so the daemon picks each session's glyphs.
    const tsid = "payload-term";
    run({ sid: tsid, input: JSON.stringify({ session_id: tsid }), env: { WT_SESSION: "a1\tb2", TERM_PROGRAM: "vscode" } });
    const tline = existsSync(inSandbox(tsid, "payload")) ? readFileSync(inSandbox(tsid, "payload"), "utf8").split("\n")[0] : "";
    ok(tline === "doombar-env\tWT_SESSION=a1b2\tTERM_PROGRAM=vscode", `WT_SESSION and TERM_PROGRAM are forwarded when set (got ${show(tline)})`);
    ok(r.out === OFFLINE, "with no frame yet the payload is still written and the offline line printed");
  }

  // --- MUGSHOT_STATE does not move the daemon files ----------------------------------------
  {
    const sid = "relocated";
    const elsewhere = path.join(sandbox, "elsewhere");
    mkdirSync(elsewhere);
    const state = path.join(elsewhere, "state.json");
    const now = nowMicros();
    putFrame(sid, serializeFrame({ daemon: "0.14.0", deadline: now + 60e6, slots: [{ start: now, lines: ["temp-dir frame"] }] }));
    const r = run({ sid, env: { MUGSHOT_STATE: state } });
    ok(r.out === "temp-dir frame\n", `with MUGSHOT_STATE set the frame is still read from the temp dir (got ${show(r.out)})`);
    const p = inSandbox(sid, "payload");
    ok(existsSync(p), "with MUGSHOT_STATE set the payload is still written to the temp dir under the install hash");
    ok(!existsSync(path.join(elsewhere, fileName(sid, "payload"))), "nothing is written next to MUGSHOT_STATE");
    const envLine = existsSync(p) ? readFileSync(p, "utf8").split("\n")[0] : "";
    ok(envLine.split("\t").includes(`MUGSHOT_STATE=${state}`), `the environment line carries MUGSHOT_STATE (got ${show(envLine)})`);
  }

  // --- Windows spellings of the temp dir (Git Bash only) ----------------------------------
  const spellings = WIN ? [["backslash", sandbox.replace(/\//g, "\\")], ["forward-slash", sandbox.replace(/\\/g, "/")]] : [];
  for (const [label, dir] of spellings) {
    const sid = "spelling-" + label;
    const now = nowMicros();
    putFrame(sid, serializeFrame({ daemon: "0.14.0", deadline: now + 60e6, slots: [{ start: now, lines: [label] }] }));
    // Set inside the shell: an environment value would be converted to a POSIX path by MSYS at startup.
    const r = run({ sid, prefix: `TMPDIR='${dir}' TEMP='${dir}' TMP='${dir}' ` });
    ok(r.out === label + "\n", `temp dir spelled ${label} (${dir}) finds the frame (got ${show(r.out)})`);
    ok(existsSync(inSandbox(sid, "payload")), `temp dir spelled ${label} receives the payload`);
  }

  // --- Nothing on stderr when the payload cannot be written --------------------------------
  {
    const sid = "payload-blocked";
    mkdirSync(inSandbox(sid, "payload")); // a directory where the payload file should go
    const now = nowMicros();
    putFrame(sid, serializeFrame({ daemon: "0.14.0", deadline: now + 60e6, slots: [{ start: now, lines: ["still shown"] }] }));
    const r = run({ sid });
    ok(r.err === "", `an unwritable payload path writes nothing to stderr (got ${show(r.err)})`);
    ok(r.out === "still shown\n", `the frame is still printed when the payload cannot be written (got ${show(r.out)})`);

    const gone = path.join(sandbox, "no-such-dir");
    const g = run({ sid, env: { TMPDIR: gone, TEMP: gone, TMP: gone } });
    ok(g.err === "", `a missing temp dir writes nothing to stderr (got ${show(g.err)})`);
    ok(g.out === OFFLINE, `a missing temp dir prints the offline line (got ${show(g.out)})`);
  }

  // --- No process per tick ---------------------------------------------------------------
  {
    // Static: the script has no construct that forks or runs a pipeline.
    let src = "";
    try { src = readFileSync(CLIENT, "utf8"); } catch { /* missing script fails below */ }
    ok(src.length > 0, "the client script exists");
    ok(!src.includes("\r"), "the client script uses LF line endings only");
    const code = src.split("\n")
      .filter((l) => !/^\s*#/.test(l))            // whole-line comments
      .map((l) => l.replace(/\[\[.*?\]\]/g, "")    // [[ ... ]] tests (regex alternation is fine there)
        .replace(/\|\|/g, ""));                    // the || list operator
    const bad = (re) => code.filter((l) => re.test(l));
    ok(bad(/\$\(/).length === 0, `no command substitution (${show(bad(/\$\(/))})`);
    ok(bad(/`/).length === 0, `no backticks (${show(bad(/`/))})`);
    ok(bad(/\|/).length === 0, `no pipes (${show(bad(/\|/))})`);
    ok(bad(/[<>]\(/).length === 0, `no process substitution (${show(bad(/[<>]\(/))})`);

    // Runtime: with PATH pointing nowhere, any external command would land in the handler.
    const marker = path.join(sandbox, "external-commands.txt").replace(/\\/g, "/");
    const sid = "no-externals";
    const now = nowMicros();
    putFrame(sid, serializeFrame({ daemon: "0.14.0", deadline: now + 60e6, slots: [{ start: now, lines: ["builtins only"] }] }));
    const r = run({ sid, prefix: `command_not_found_handle() { printf '%s\\n' "$1" >> '${marker}'; }; PATH=/no-such-dir; ` });
    ok(r.out === "builtins only\n", `the client works with an empty PATH (got ${show(r.out)})`);
    ok(!existsSync(marker), `no external command was looked up (${existsSync(marker) ? show(readFileSync(marker, "utf8")) : "none"})`);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
