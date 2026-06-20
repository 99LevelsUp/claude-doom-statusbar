#!/usr/bin/env node
// git moved off the render hot path: the async hook snapshots git into the journal on a
// write-affecting event, statusline folds it into state.git, and buildValues renders from
// that snapshot (no spawn on the render path). Uses the real repo as cwd.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, buildValues } from "../src/statusline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const HOOK = path.join(REPO, "src", "hook.js");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-git-"));
const checkpoint = path.join(tmp, "state.json");
process.env.MUGSHOT_STATE = checkpoint;
const sid = "gittest-" + process.pid;
const env = { ...process.env, MUGSHOT_STATE: checkpoint, DOOMBAR_GIT_TTL: "0" }; // 0 = never throttle

try {
  // A write-affecting PostToolUse (Bash) in the repo -> hook snapshots git into the journal.
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: sid, tool_name: "Bash", cwd: REPO }),
    encoding: "utf8", env,
  });

  const journal = checkpoint + ".jsonl";
  const lines = readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const gitLine = lines.find((l) => l.name === "git");
  ok(!!gitLine, "hook appended a git snapshot line on the write event");
  ok(gitLine?.ev?.git?.cwd === REPO, "git snapshot carries the cwd");
  ok(typeof gitLine?.ev?.git?.br === "string" && gitLine.ev.git.br.length > 0, "git snapshot has a branch name");

  // statusline folds it into state.git, buildValues renders git.branch from the snapshot.
  const st = loadState({ session_id: sid });
  ok(st.git?.cwd === REPO, "loadState folded git snapshot into state.git");
  const v = buildValues({ cwd: REPO }, st.git);
  // The label is clipped to 24 code points, so match a prefix rather than the full name.
  ok(typeof v["git.branch"] === "string" && v["git.branch"].includes(st.git.br.slice(0, 20)),
    `git.branch rendered from snapshot (got ${JSON.stringify(v["git.branch"])})`);
  // The working tree has uncommitted changes during this refactor -> a changed-file count.
  ok(v["git.work"] !== undefined, "git.work (changed-file count) rendered from snapshot");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
