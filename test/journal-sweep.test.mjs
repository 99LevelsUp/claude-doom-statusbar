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
import { staleStateFiles } from "../src/hook.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
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
    "mugshot_unreadable.json": null,
  };
  const ageOf = (n) => (n in ages ? ages[n] : 30 * DAY); // default: a month old
  const stale = staleStateFiles(names, ageOf, { keep: ["/tmp/mugshot_live.json", "/tmp/mugshot_live.json.jsonl"] });

  const expected = ["mugshot_old-session.json", "mugshot_old-session.json.jsonl",
    "mugshot_git_old-session.json", "mugshot_msys_old-session.json", "mugshot_adv_old-session.json",
    "mugshot_old-session.json.9999.tmp"];
  ok(stale.length === expected.length && expected.every((e) => stale.includes(e)),
    `selects exactly the 6 cold scratch files (got ${stale.length}: ${stale.join(", ")})`);
  ok(!stale.includes("mugshot_ratehealth_global.json"),
    "the cross-session rate-health accumulator is NEVER deleted, however old");
  ok(!stale.includes("mugshot_reap_tick.json"), "the reap throttle marker is never deleted");
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
  stamp("unrelated.txt", 30 * DAY);

  // TMPDIR points the hook's os.tmpdir() at our sandbox; MUGSHOT_STATE keeps its own checkpoint
  // there too, so `keep` covers a real path inside the swept directory.
  const sid = "sweeptest";
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid, cwd: tmp }),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
      MUGSHOT_STATE: path.join(tmp, `mugshot_${sid}.json`), DOOMBAR_MSYS_REAP: "0" },
  });

  const left = readdirSync(tmp);
  ok(!left.includes("mugshot_dead.json") && !left.includes("mugshot_dead.json.jsonl") &&
     !left.includes("mugshot_git_dead.json"), `cold files swept (left: ${left.join(", ")})`);
  ok(left.includes("mugshot_ratehealth_global.json"), "shared accumulator survived the sweep");
  ok(left.includes("mugshot_fresh.json"), "fresh file survived");
  ok(left.includes("unrelated.txt"), "unrelated file survived");
  ok(existsSync(path.join(tmp, `mugshot_${sid}.json.jsonl`)),
     "this session's own journal exists and was not swept");

  // The sweep must be switchable off.
  stamp("mugshot_dead2.json", 30 * DAY);
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid + "b", cwd: tmp }),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, DOOMBAR_JOURNAL_TTL: "off",
      MUGSHOT_STATE: path.join(tmp, `mugshot_${sid}b.json`), DOOMBAR_MSYS_REAP: "0" },
  });
  ok(readdirSync(tmp).includes("mugshot_dead2.json"), "DOOMBAR_JOURNAL_TTL=off disables the sweep");

  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
