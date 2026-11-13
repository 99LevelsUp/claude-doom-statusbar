#!/usr/bin/env node
// Journal housekeeping: SessionStart drops per-session scratch files that have gone cold.
//
// This is the only code in the package that deletes files, so the selection rule is tested
// exhaustively and purely (staleStateFiles), plus one end-to-end run of the real hook against a
// temp dir it owns. What must NEVER be deleted: cross-session shared state (the rate-health
// accumulator, the reap throttle), this session's own files, anything not ours, and anything
// still fresh — a merely idle or concurrent session must survive untouched.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, rmSync, utimesSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { staleStateFiles } from "../../src/hook.js";
import { sessionPaths, daemonPaths, rootHash, runtimeDir } from "../../src/fold.js";
import { sandboxEnv } from "../_sandbox-env.mjs";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(HERE, "..", "src", "hook.js");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const DAY = 24 * 60 * 60 * 1000;
const TTL = 7 * DAY;

// --- Pure selection rule ------------------------------------------------------------------
{
  const names = [
    "mugshot_old-session.json",           // cold scratch -> go
    "mugshot_old-session.json.jsonl",     // cold scratch -> go
    "mugshot_git_old-session.json",       // cold scratch -> go
    "mugshot_msys_old-session.json",      // cold scratch -> go
    "mugshot_adv_old-session.json",       // cold scratch -> go
    "mugshot_old-session.json.9999.tmp",  // orphaned atomic-write temp -> go
    "savings_old-session.json",           // cold savings accumulator -> go
    "savings_idle.json",                  // fresh savings accumulator -> keep
    "mugshot_cpu.json",                   // SHARED CPU sample -> keep even when ancient
    "mugshot_ratelimits_global.json",     // SHARED rate limits -> keep even when ancient
    "mugshot_ratehealth_global.json",     // SHARED across sessions -> keep even when ancient
    "mugshot_reap_tick.json",             // process-wide throttle -> keep
    "mugshot_live.json",                  // this session -> keep
    "mugshot_live.json.jsonl",            // this session -> keep
    "mugshot_idle.json",                  // another session, still fresh -> keep
    "some-other-tool.json",               // not ours -> keep
    "mugshot_unreadable.json",            // age unknown -> keep (never guess)
  ];
  const ages = {
    "mugshot_idle.json": 30 * 1000,        // half a minute old
    "savings_idle.json": 30 * 1000,
    "mugshot_unreadable.json": null,
  };
  const ageOf = (n) => (n in ages ? ages[n] : 30 * DAY); // default: a month old
  const stale = staleStateFiles(names, ageOf, { keep: ["/tmp/mugshot_live.json", "/tmp/mugshot_live.json.jsonl"] });

  const expected = ["mugshot_old-session.json", "mugshot_old-session.json.jsonl",
    "mugshot_git_old-session.json", "mugshot_msys_old-session.json", "mugshot_adv_old-session.json",
    "mugshot_old-session.json.9999.tmp", "savings_old-session.json"];
  ok(stale.length === expected.length && expected.every((e) => stale.includes(e)),
    `selects exactly the 7 cold scratch files (got ${stale.length}: ${stale.join(", ")})`);
  ok(!stale.includes("mugshot_ratehealth_global.json"),
    "the cross-session rate-health accumulator is NEVER deleted, however old");
  ok(!stale.includes("mugshot_reap_tick.json"), "the reap throttle marker is never deleted");
  ok(!stale.includes("mugshot_cpu.json") && !stale.includes("mugshot_ratelimits_global.json"),
    "the shared CPU sample and rate-limit pool are never deleted");
  ok(!stale.includes("savings_idle.json"), "a fresh savings file is kept");
  ok(!stale.includes("mugshot_live.json") && !stale.includes("mugshot_live.json.jsonl"),
    "this session's own checkpoint and journal are kept");
  ok(!stale.includes("mugshot_idle.json"), "a fresh file from an idle/concurrent session is kept");
  ok(!stale.includes("some-other-tool.json"), "files that are not ours are never touched");
  ok(!stale.includes("mugshot_unreadable.json"), "an unreadable mtime is treated as keep, not delete");

  // TTL boundary: just under stays, just over goes.
  const one = ["mugshot_x.json"];
  ok(staleStateFiles(one, () => TTL - 1000).length === 0, "just inside the TTL -> kept");
  ok(staleStateFiles(one, () => TTL + 1000).length === 1, "just past the TTL -> swept");
  ok(staleStateFiles(one, () => 99 * DAY, { ttl: 100 * DAY }).length === 0, "a custom longer TTL is honoured");
  ok(staleStateFiles([], () => 99 * DAY).length === 0 && staleStateFiles(null, () => 0).length === 0,
    "empty / missing name list is safe");
}

// --- Sessions that never rendered go after an hour, decided per session ---------------------
// Headless runs (claude -p) fire the hooks but never render a bar, so they leave a journal and
// probe markers and no checkpoint. Those are swept after an hour instead of a week; a session
// with a checkpoint keeps the long TTL. The newest file of a session decides for all of it.
{
  const HOUR = 60 * 60 * 1000;
  const sweep = (ages) => staleStateFiles(Object.keys(ages), (n) => ages[n]);
  const all = (names, stale) => names.every((n) => stale.includes(n));
  const none = (names, stale) => names.every((n) => !stale.includes(n));

  const headless = ["mugshot_h.json.jsonl", "mugshot_git_h.json", "mugshot_msys_h.json"];
  ok(all(headless, sweep(Object.fromEntries(headless.map((n) => [n, 2 * HOUR])))),
    "never rendered, newest file 2 h old -> every file of the session goes");
  ok(none(headless, sweep(Object.fromEntries(headless.map((n) => [n, 30 * 60 * 1000])))),
    "never rendered, newest file 30 min old -> all kept");
  ok(none(headless, sweep({ "mugshot_h.json.jsonl": 10 * 60 * 1000,
    "mugshot_git_h.json": 2 * HOUR, "mugshot_msys_h.json": 2 * HOUR })),
    "never rendered, journal fresh but markers 2 h old -> all kept (the newest file decides)");

  const rendered = ["mugshot_r.json", "mugshot_r.json.jsonl", "mugshot_git_r.json", "savings_r.json"];
  ok(none(rendered, sweep(Object.fromEntries(rendered.map((n) => [n, 2 * HOUR])))),
    "rendered (has a checkpoint), 2 h old -> all kept under the 7-day rule");
  ok(all(rendered, sweep(Object.fromEntries(rendered.map((n) => [n, 8 * DAY])))),
    "rendered, 8 days old -> all go, savings file included");
  // After end-of-session cleanup only the savings file is left. Only a render writes it, so it
  // marks the session as rendered: it keeps the 7-day rule and survives a later resume.
  ok(sweep({ "savings_ended.json": 2 * HOUR }).length === 0,
    "a lone savings file (session ended cleanly) is kept past an hour");
  ok(sweep({ "savings_ended.json": 8 * DAY }).length === 1, "a lone savings file goes after 7 days");

  ok(sweep({ "mugshot_s.json.jsonl": 2 * HOUR, "mugshot_cpu.json": 2 * HOUR }).includes("mugshot_s.json.jsonl") &&
     !sweep({ "mugshot_cpu.json": 99 * DAY }).length,
    "shared files are never part of a session, whatever their age");
  ok(staleStateFiles(["mugshot_h.json.jsonl"], () => 2 * HOUR, { unrenderedTtl: 3 * HOUR }).length === 0,
    "a custom unrendered TTL is honoured");
}

// --- Payload and frame files belong to their session; daemon files belong to no session -----
{
  const HOUR = 60 * 60 * 1000;
  const H1 = "0123456789", H2 = "abcdef0123"; // two installations
  const sweep = (ages) => staleStateFiles(Object.keys(ages), (n) => ages[n]);
  const all = (names, stale) => names.every((n) => stale.includes(n));
  const none = (names, stale) => names.every((n) => !stale.includes(n));

  const dead = [`mugshot_payload_${H1}_dead.json`, `mugshot_frame_${H1}_dead.json`];
  ok(all(dead, sweep(Object.fromEntries(dead.map((n) => [n, 2 * HOUR])))),
    "a dead session's payload and frame go after the unrendered TTL");
  ok(none(dead, sweep(Object.fromEntries(dead.map((n) => [n, 30 * 60 * 1000])))),
    "a dead session's payload and frame are kept inside the unrendered TTL");
  ok(sweep({ [`mugshot_frame_${H1}_dead.json.4242.tmp`]: 2 * HOUR }).length === 1,
    "a frame temp file left behind by an interrupted write is swept");

  const shown = [`mugshot_payload_${H1}_shown.json`, `mugshot_frame_${H2}_shown.json`];
  ok(none(shown, sweep({ "mugshot_shown.json": 10 * 60 * 1000,
    ...Object.fromEntries(shown.map((n) => [n, 8 * DAY])) })),
    "8-day-old payload and frame (under either hash) are kept while their session's checkpoint is fresh");
  ok(none([`mugshot_frame_${H1}_busy.json`], sweep({ "mugshot_busy.json.jsonl": 10 * 60 * 1000,
    [`mugshot_frame_${H1}_busy.json`]: 8 * DAY })),
    "an 8-day-old frame is kept while its session's journal is fresh (the newest file decides)");

  const daemon = [`mugshot_daemon_${H1}.json`, `mugshot_daemon_${H1}.claim`,
    `mugshot_daemon_${H2}.json`, `mugshot_daemon_${H2}.claim`];
  ok(sweep(Object.fromEntries(daemon.map((n) => [n, 30 * DAY]))).length === 0,
    "the daemon heartbeat and claim of any install hash are never swept, however old");

  // The names the writers actually produce (through fold.js) are the names the sweep recognizes.
  const sp = sessionPaths("named"), dp = daemonPaths();
  const real = [path.basename(sp.payload), path.basename(sp.frame), path.basename(sp.frame) + ".4242.tmp"];
  ok(all(real, sweep(Object.fromEntries(real.map((n) => [n, 2 * HOUR])))),
    `the payload and frame names sessionPaths writes are swept with their session (${real.join(", ")})`);
  ok(sweep({ [path.basename(dp.heartbeat)]: 30 * DAY, [path.basename(dp.claim)]: 30 * DAY }).length === 0,
    "the heartbeat and claim names daemonPaths writes are never swept");
  ok(path.dirname(sp.frame) === runtimeDir() && path.dirname(dp.heartbeat) === runtimeDir(),
    "payload, frame and daemon files live in the bar's runtime dir");

  const h = rootHash("C:\\Users\\dev\\doombar");
  ok(/^[0-9a-f]{10}$/.test(h), `the install-root hash is 10 hex chars (${h})`);
  ok(rootHash("c:/users/DEV/doombar/") === h, "the hash ignores slash direction, case and a trailing slash");
  ok(rootHash("C:\\Users\\dev\\other") !== h, "a different install root gives a different hash");
}

// --- End to end: the real hook sweeps its own temp dir on SessionStart ----------------------
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-sweep-"));
  const stamp = (name, ageMs) => {
    const p = path.join(tmp, name);
    writeFileSync(p, "{}");
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(p, t, t);
    return p;
  };
  stamp("mugshot_dead.json", 30 * DAY);
  stamp("mugshot_dead.json.jsonl", 30 * DAY);
  stamp("mugshot_git_dead.json", 30 * DAY);
  stamp("mugshot_ratehealth_global.json", 30 * DAY);
  stamp("mugshot_fresh.json", 1000);
  stamp("mugshot_headless.json.jsonl", 2 * 60 * 60 * 1000); // never rendered, 2 h old
  stamp("mugshot_git_headless.json", 2 * 60 * 60 * 1000);
  stamp("mugshot_shown.json", 2 * 60 * 60 * 1000);          // rendered, 2 h old
  stamp("mugshot_shown.json.jsonl", 2 * 60 * 60 * 1000);
  stamp("unrelated.txt", 30 * DAY);
  stamp("mugshot_payload_0123456789_gone.json", 2 * 60 * 60 * 1000); // never rendered, 2 h old
  stamp("mugshot_frame_0123456789_gone.json", 2 * 60 * 60 * 1000);
  stamp("mugshot_frame_0123456789_gone.json.4242.tmp", 2 * 60 * 60 * 1000);
  stamp("mugshot_daemon_0123456789.json", 30 * DAY);
  stamp("mugshot_daemon_0123456789.claim", 30 * DAY);

  // sandboxEnv points the hook's runtime directory at our sandbox; MUGSHOT_STATE keeps its own checkpoint
  // there too, so `keep` covers a real path inside the swept directory.
  const sid = "sweeptest";
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid, cwd: tmp }),
    encoding: "utf8",
    env: { ...process.env, ...sandboxEnv(tmp),
      MUGSHOT_STATE: path.join(tmp, `mugshot_${sid}.json`), DOOMBAR_MSYS_REAP: "0" },
  });

  const left = readdirSync(tmp);
  ok(!left.includes("mugshot_dead.json") && !left.includes("mugshot_dead.json.jsonl") &&
     !left.includes("mugshot_git_dead.json"), `cold files swept (left: ${left.join(", ")})`);
  ok(left.includes("mugshot_ratehealth_global.json"), "shared accumulator survived the sweep");
  ok(left.includes("mugshot_fresh.json"), "fresh file survived");
  ok(!left.includes("mugshot_headless.json.jsonl") && !left.includes("mugshot_git_headless.json"),
    "a session that never rendered is swept after an hour");
  ok(left.includes("mugshot_shown.json") && left.includes("mugshot_shown.json.jsonl"),
    "a rendered session of the same age is kept");
  ok(left.includes("unrelated.txt"), "unrelated file survived");
  ok(!left.some((n) => n.startsWith("mugshot_payload_") || n.startsWith("mugshot_frame_")),
    "a dead session's payload, frame and frame temp file are swept");
  ok(left.includes("mugshot_daemon_0123456789.json") && left.includes("mugshot_daemon_0123456789.claim"),
    "the daemon heartbeat and claim survive the sweep");
  ok(existsSync(path.join(tmp, `mugshot_${sid}.json.jsonl`)),
     "this session's own journal exists and was not swept");

  // The sweep must be switchable off.
  stamp("mugshot_dead2.json", 30 * DAY);
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid + "b", cwd: tmp }),
    encoding: "utf8",
    env: { ...process.env, ...sandboxEnv(tmp), DOOMBAR_JOURNAL_TTL: "off",
      MUGSHOT_STATE: path.join(tmp, `mugshot_${sid}b.json`), DOOMBAR_MSYS_REAP: "0" },
  });
  ok(readdirSync(tmp).includes("mugshot_dead2.json"), "DOOMBAR_JOURNAL_TTL=off disables the sweep");

  rmSync(tmp, { recursive: true, force: true });
}

// --- The sweep follows MUGSHOT_STATE, it does not sweep os.tmpdir() blindly -----------------
// Regression: the first cut read os.tmpdir() directly, so a run with MUGSHOT_STATE pointing at a
// sandbox still deleted from the developer's REAL temp dir. That is exactly what the rest of this
// suite does, so `npm test` was quietly sweeping the machine's temp directory.
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "doombar-sandbox-"));
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "doombar-elsewhere-"));
  const old = (dir, name) => {
    const p = path.join(dir, name);
    writeFileSync(p, "{}");
    const t = (Date.now() - 30 * DAY) / 1000;
    utimesSync(p, t, t);
  };
  old(sandbox, "mugshot_cold-here.json");
  old(elsewhere, "mugshot_cold-elsewhere.json");

  const sid = "scopetest";
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid, cwd: sandbox }),
    encoding: "utf8",
    // MUGSHOT_STATE lives in `sandbox`, while TMPDIR still points at `elsewhere`.
    env: { ...process.env, ...sandboxEnv(elsewhere),
      MUGSHOT_STATE: path.join(sandbox, `mugshot_${sid}.json`), DOOMBAR_MSYS_REAP: "0" },
  });

  ok(!readdirSync(sandbox).includes("mugshot_cold-here.json"),
    "sweeps the directory MUGSHOT_STATE points at");
  ok(readdirSync(elsewhere).includes("mugshot_cold-elsewhere.json"),
    "leaves os.tmpdir() alone when the checkpoint lives elsewhere");

  rmSync(sandbox, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
