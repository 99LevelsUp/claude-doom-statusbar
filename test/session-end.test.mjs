#!/usr/bin/env node
// End-of-session cleanup: the SessionEnd hook deletes the session's scratch files right away,
// instead of leaving them for a later session's sweep a week from now.
//
// Kept: the savings file. A resumed session keeps its id and its lean-ctx savings total lives
// only there; the checkpoint is not kept, because a resume resets it anyway (SessionStart
// truncates the journal), and a stale offset in it could misread the resumed session's journal.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "src", "hook.js");
const STATUSLINE = path.join(HERE, "..", "src", "statusline.js");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const sessionFiles = (sid) => [
  `mugshot_${sid}.json`, `mugshot_${sid}.json.jsonl`, `mugshot_${sid}.json.4242.tmp`,
  `mugshot_git_${sid}.json`, `mugshot_msys_${sid}.json`, `mugshot_adv_${sid}.json`, `savings_${sid}.json`,
];
const plant = (dir, sid) => sessionFiles(sid).forEach((n) => writeFileSync(path.join(dir, n), "{}"));
const hook = (event, env) => {
  try {
    execFileSync(process.execPath, [HOOK], { input: JSON.stringify(event), encoding: "utf8",
      env: { ...process.env, DOOMBAR_MSYS_REAP: "0", ...env } });
    return 0;
  } catch (e) { return e.status ?? 1; }
};

// --- One session ends: its scratch goes, its savings stay, other sessions are untouched -------
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-end-"));
  const env = { TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  delete process.env.MUGSHOT_STATE;
  plant(tmp, "ending");
  plant(tmp, "other");
  writeFileSync(path.join(tmp, "unrelated.txt"), "x");

  const code = hook({ hook_event_name: "SessionEnd", session_id: "ending", reason: "prompt_input_exit" }, env);
  const left = readdirSync(tmp);
  ok(code === 0, "SessionEnd exits 0");
  ok(["mugshot_ending.json", "mugshot_ending.json.jsonl", "mugshot_ending.json.4242.tmp",
    "mugshot_git_ending.json", "mugshot_msys_ending.json", "mugshot_adv_ending.json"]
    .every((n) => !left.includes(n)),
    `the ending session's checkpoint, journal, .tmp, markers and advisor cache are gone (left: ${left.join(", ")})`);
  ok(left.includes("savings_ending.json"), "the ending session's savings file is kept");
  ok(sessionFiles("other").every((n) => left.includes(n)), "another session's files are untouched");
  ok(left.includes("unrelated.txt"), "files that are not ours are untouched");
  ok(!existsSync(path.join(tmp, "mugshot_ending.json.jsonl")), "SessionEnd does not write a journal line back");

  // No session id (malformed event): exit 0, and nobody else's files go.
  ok(hook({ hook_event_name: "SessionEnd" }, env) === 0, "SessionEnd without a session id exits 0");
  ok(sessionFiles("other").every((n) => readdirSync(tmp).includes(n)), "...and deletes no other session's files");
  // A session with no files at all: nothing to do, still exit 0.
  ok(hook({ hook_event_name: "SessionEnd", session_id: "ghost" }, env) === 0, "SessionEnd for a session with no files exits 0");
  rmSync(tmp, { recursive: true, force: true });
}

// --- The render daemon's payload and frame go too, under every install hash --------------------
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-end-frames-"));
  const env = { TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  const frames = (key) => ["0123456789", "abcdef0123"].flatMap((h) => [
    `mugshot_payload_${h}_${key}.json`, `mugshot_frame_${h}_${key}.json`, `mugshot_frame_${h}_${key}.json.4242.tmp`]);
  const daemon = ["mugshot_daemon_0123456789.json", "mugshot_daemon_0123456789.claim"];
  [...frames("ending"), ...frames("x_ending"), ...frames("other"), ...daemon, "savings_ending.json"]
    .forEach((n) => writeFileSync(path.join(tmp, n), "{}"));

  ok(hook({ hook_event_name: "SessionEnd", session_id: "ending" }, env) === 0, "SessionEnd exits 0");
  const left = readdirSync(tmp);
  ok(frames("ending").every((n) => !left.includes(n)),
    `the ending session's payload, frame and frame temp files are gone under both hashes (left: ${left.join(", ")})`);
  ok(left.includes("savings_ending.json"), "the ending session's savings file is kept");
  ok(frames("x_ending").every((n) => left.includes(n)) && frames("other").every((n) => left.includes(n)),
    "other sessions' payloads and frames are untouched, including one whose key ends the same way");
  ok(daemon.every((n) => left.includes(n)), "the daemon heartbeat and claim are untouched");
  rmSync(tmp, { recursive: true, force: true });
}

// --- MUGSHOT_STATE relocates the cleanup with the files ----------------------------------------
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "doombar-end-sandbox-"));
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "doombar-end-elsewhere-"));
  plant(sandbox, "boxed");
  plant(elsewhere, "boxed"); // same names in the system temp dir: not this run's files
  hook({ hook_event_name: "SessionEnd", session_id: "boxed" },
    { TEMP: elsewhere, TMP: elsewhere, TMPDIR: elsewhere, MUGSHOT_STATE: path.join(sandbox, "mugshot_boxed.json") });
  ok(!existsSync(path.join(sandbox, "mugshot_boxed.json.jsonl")) && !existsSync(path.join(sandbox, "mugshot_git_boxed.json")),
    "cleans the directory MUGSHOT_STATE points at");
  ok(sessionFiles("boxed").every((n) => existsSync(path.join(elsewhere, n))),
    "leaves the system temp dir alone when the state lives elsewhere");
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
}

// --- A resumed session starts from a fresh state and keeps its savings total -------------------
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-end-resume-"));
  const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, DOOMBAR_MSYS_REAP: "0",
    DOOMBAR_THEME: "doom", DOOMBAR_RATELIMITS_SHARE: "0", COLUMNS: "120" };
  delete env.MUGSHOT_STATE;
  delete env.DOOMBAR_SAVINGS_STATE;
  const events = path.join(tmp, "events.jsonl");
  writeFileSync(events, "");
  env.DOOMBAR_EVENTS = events;
  const sid = "resumed";
  const render = () => execFileSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify({ session_id: sid, cwd: tmp }), encoding: "utf8", env });

  const tmpEnv = { TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  hook({ hook_event_name: "SessionStart", session_id: sid, cwd: tmp }, tmpEnv);
  render();                                    // first render: savings start at the log's end
  writeFileSync(events, JSON.stringify({ kind: { type: "ToolCall", path: path.join(tmp, "a.js").replace(/\\/g, "/"),
    tokens_saved: 700, tokens_original: 1000 } }) + "\n");
  render();                                    // counts the new event
  const before = JSON.parse(readFileSync(path.join(tmp, `savings_${sid}.json`), "utf8")).saved;
  ok(existsSync(path.join(tmp, `mugshot_${sid}.json`)), "a running session has a checkpoint");

  hook({ hook_event_name: "SessionEnd", session_id: sid }, tmpEnv);
  ok(!existsSync(path.join(tmp, `mugshot_${sid}.json`)), "the checkpoint is gone after SessionEnd");

  hook({ hook_event_name: "SessionStart", session_id: sid, source: "resume", cwd: tmp }, tmpEnv);
  render();
  const after = JSON.parse(readFileSync(path.join(tmp, `savings_${sid}.json`), "utf8")).saved;
  ok(before === 700 && after === 700, `the savings total survives end and resume (before ${before}, after ${after})`);
  ok(existsSync(path.join(tmp, `mugshot_${sid}.json`)), "the resumed session renders and writes a fresh checkpoint");
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
