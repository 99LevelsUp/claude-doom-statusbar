#!/usr/bin/env node
// git moved off the render hot path: the async hook snapshots git into the journal on a
// write-affecting event, statusline folds it into state.git, and buildValues renders from
// that snapshot (no spawn on the render path).
//
// Uses a SELF-CONTAINED temp git repo with a known branch + a known dirty file, so the test
// is deterministic regardless of how the project itself is checked out (CI checks out a tag
// in detached HEAD, where `git branch --show-current` is empty — an earlier version of this
// test wrongly assumed a named branch and broke the publish).

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, buildValues } from "../src/statusline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "src", "hook.js");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-git-"));
const repo = path.join(tmp, "repo");
mkdirSync(repo);
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

const checkpoint = path.join(tmp, "state.json");
process.env.MUGSHOT_STATE = checkpoint;
const sid = "gittest-" + process.pid;
const env = { ...process.env, MUGSHOT_STATE: checkpoint, DOOMBAR_GIT_TTL: "0" }; // 0 = never throttle

try {
  // Build a known repo: branch "doomtest", one commit, one uncommitted file.
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(repo, "a.txt"), "hello");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("branch", "-M", "doomtest");              // portable rename to a known branch name
  writeFileSync(path.join(repo, "b.txt"), "dirty"); // one untracked file -> status count 1

  // A write-affecting PostToolUse (Bash) in the repo -> hook snapshots git into the journal.
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: sid, tool_name: "Bash", cwd: repo }),
    encoding: "utf8", env,
  });

  const journal = checkpoint + ".jsonl";
  const lines = readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const gitLine = lines.find((l) => l.name === "git");
  ok(!!gitLine, "hook appended a git snapshot line on the write event");
  ok(gitLine?.ev?.git?.cwd === repo, "git snapshot carries the cwd");
  ok(gitLine?.ev?.git?.br === "doomtest", `git snapshot has the branch (got ${JSON.stringify(gitLine?.ev?.git?.br)})`);
  ok(/b\.txt/.test(gitLine?.ev?.git?.st || ""), "git snapshot status lists the dirty file");

  // statusline folds it into state.git; buildValues renders from the snapshot, no spawn.
  const st = loadState({ session_id: sid });
  ok(st.git?.cwd === repo, "loadState folded git snapshot into state.git");
  const v = buildValues({ cwd: repo }, st.git);
  ok(typeof v["git.branch"] === "string" && v["git.branch"].includes("doomtest"),
    `git.branch rendered from snapshot (got ${JSON.stringify(v["git.branch"])})`);
  ok(v["git.status"] === "1", `git.status counts the one dirty file (got ${JSON.stringify(v["git.status"])})`);
  ok(v["git.work"] !== undefined, "git.work rendered from snapshot");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
