#!/usr/bin/env node
// Two installations of the bar can both have hooks registered: a checkout wired with
// `install --local` over a global install (D-16). Claude Code runs both sets. The hooks of the
// installation whose client does not draw the session step aside, so each event reaches the
// journal once. This pins servedElsewhere (src/platform/runtime.js) and the hook's use of it.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";
import { servedElsewhere, rootHash, payloadPrefix, sidKey, statePaths, daemonPaths } from "../../src/platform/runtime.js";

const ROOT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..");
const HOOK = path.join(ROOT, "src", "hook.js");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-stepaside-"));
process.on("exit", () => rmSync(SB, { recursive: true, force: true }));

const OWN = rootHash();
const OTHER = OWN === "0123456789" ? "9876543210" : "0123456789";
const NOW = Date.now();

// A fresh runtime directory per case, and a payload written by some installation's client.
let n = 0;
function rt() {
  const dir = path.join(SB, `rt${++n}`);
  mkdirSync(dir, { mode: 0o700 });
  return { dir, env: { ...process.env, ...sandboxEnv(dir) } };
}
function payload(dir, hash, sid, ageMs = 0) {
  const f = path.join(dir, `${payloadPrefix(hash)}${sidKey(sid)}.json`);
  writeFileSync(f, "gamebar-env\n{}");
  const t = new Date(NOW - ageMs);
  utimesSync(f, t, t);
}

// --- servedElsewhere ----------------------------------------------------------------------------
{
  const { dir, env } = rt();
  ok(servedElsewhere("s1", { env, now: NOW }) === false, "no payload at all: nobody steps aside");

  payload(dir, OTHER, "s1");
  ok(servedElsewhere("s1", { env, now: NOW }) === true, "another installation's fresh payload, none of ours: step aside");

  payload(dir, OWN, "s1");
  ok(servedElsewhere("s1", { env, now: NOW }) === false, "our own payload exists too: this installation draws the session");
}
{
  const { dir, env } = rt();
  payload(dir, OTHER, "s2", 11 * 60 * 1000);
  ok(servedElsewhere("s2", { env, now: NOW }) === false, "another installation's payload older than the idle period does not count");
  payload(dir, OTHER, "s2-x");
  ok(servedElsewhere("s2", { env, now: NOW }) === false, "a payload of another session whose key starts the same does not count");
  payload(dir, OTHER, "s2", 0);
  ok(servedElsewhere("s2", { env, now: NOW, hash: OTHER }) === false,
    "seen from the other installation, its own payload means it draws the session");
}
{
  const { dir, env } = rt();
  writeFileSync(path.join(dir, `${payloadPrefix("nothex!!!!")}s3.json`), "x");
  writeFileSync(path.join(dir, `mugshot_payload_${OTHER}_s3.json`), "x");
  ok(servedElsewhere("s3", { env, now: NOW }) === false, "names that are not another installation's payload do not count");
}
{
  const env = { ...process.env, ...sandboxEnv(path.join(SB, "missing-dir")) };
  ok(servedElsewhere("s4", { env, now: NOW }) === false, "a runtime directory that does not exist: nobody steps aside");
}

// --- The hook -----------------------------------------------------------------------------------
function runHook(env, ev) {
  execFileSync(process.execPath, [HOOK], { input: JSON.stringify(ev), encoding: "utf8",
    env: { ...env, GAMEBAR_MSYS_REAP: "0" } });
}
const journalOf = (sid, env) => statePaths(sid, env).journal;
// The event's own lines; on Windows the hook may add an `msys` line of its own.
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [])
  .filter((l) => JSON.parse(l).name === "PostToolUse");
{
  const { dir, env } = rt();
  // A fresh start claim: the drawing installation's hook finds no daemon and would start one;
  // the claim makes it leave that to the claimer, so the test starts no process.
  writeFileSync(daemonPaths(OWN, env).claim, JSON.stringify({ claimedAt: Date.now() }));
  const ev = (sid) => ({ hook_event_name: "PostToolUse", session_id: sid, tool_name: "Read", tool_input: {} });

  payload(dir, OTHER, "drawn-elsewhere");
  runHook(env, ev("drawn-elsewhere"));
  ok(lines(journalOf("drawn-elsewhere", env)).length === 0,
    "the hook of an installation that does not draw the session writes no journal line");

  payload(dir, OWN, "drawn-here");
  payload(dir, OTHER, "drawn-here");
  runHook(env, ev("drawn-here"));
  ok(lines(journalOf("drawn-here", env)).length === 1, "the hook of the drawing installation journals the event");

  runHook(env, ev("no-payload"));
  ok(lines(journalOf("no-payload", env)).length === 1, "with no payload at all the hook journals the event as before");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
