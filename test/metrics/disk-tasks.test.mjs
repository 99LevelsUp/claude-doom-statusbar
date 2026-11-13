#!/usr/bin/env node
// Tasks are read from Claude Code's on-disk task list, so they survive a reboot (which wipes
// the temp-dir journal) and `claude --resume`.
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDiskTasks, mergeDiskTasks, tasksDir, activityValues } from "../src/statusline.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const dir = mkdtempSync(path.join(os.tmpdir(), "doombar-tasks-"));
const put = (id, subject, status, mtime) => {
  const f = path.join(dir, `${id}.json`);
  writeFileSync(f, JSON.stringify({ id, subject, description: "", status, blocks: [], blockedBy: [] }));
  utimesSync(f, mtime, mtime);
};
try {
  // tasksDir: env override, list id, session id.
  process.env.DOOMBAR_TASKS_DIR = "/x/y";
  ok(tasksDir("s1") === "/x/y", "DOOMBAR_TASKS_DIR overrides the directory");
  delete process.env.DOOMBAR_TASKS_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/cfg";
  ok(tasksDir("s1") === path.join("/cfg", "tasks", "s1"), "defaults to <config>/tasks/<session id>");
  process.env.CLAUDE_CODE_TASK_LIST_ID = "shared";
  ok(tasksDir("s1") === path.join("/cfg", "tasks", "shared"), "CLAUDE_CODE_TASK_LIST_ID wins over the session id");
  delete process.env.CLAUDE_CODE_TASK_LIST_ID;
  delete process.env.CLAUDE_CONFIG_DIR;

  ok(readDiskTasks(path.join(dir, "missing")) === null, "no directory -> null");

  const now = 1_000_000;
  put("1", "first", "pending", now - 5000);
  put("2", "second", "completed", now - 4000);
  writeFileSync(path.join(dir, ".lock"), "");
  writeFileSync(path.join(dir, "3.json"), "{broken");
  const disk = readDiskTasks(dir);
  ok(Object.keys(disk).sort().join() === "1,2", "reads task files, skips .lock and broken JSON");
  ok(disk["1"].title === "first" && disk["1"].status === "pending", "subject -> title, status kept");

  // Resume after a reboot: empty journal state, the open task still shows.
  const resumed = mergeDiskTasks({ offset: 0 }, disk);
  ok(activityValues(resumed, now)["act.tasks"] === "1/2", "after a reboot the disk list gives 1 done of 2");

  // Disk status wins over a stale journal status; journal creation time is kept.
  const st = { tasks: { 1: { title: "first", status: "pending", ts: 10 } }, tasks_ts: 10 };
  const m = mergeDiskTasks(st, { 1: { title: "first", status: "completed", ts: now - 1 } });
  ok(m.tasks["1"].status === "completed" && m.tasks["1"].ts === 10, "disk status wins, journal ts kept");
  ok(st.tasks["1"].status === "pending", "input state is not mutated");

  // A task the journal saw deleted (and Claude Code removed from disk) still shows as deleted.
  const d = mergeDiskTasks({ tasks: { 9: { title: "gone", status: "deleted", ts: 5 } }, tasks_ts: now }, disk);
  ok(d.tasks["9"] && d.tasks["9"].status === "deleted", "journal-deleted task kept");

  // Settled and quiet: the list empties after the linger, the count keeps the finished task.
  const all = mergeDiskTasks({}, { 1: { title: "a", status: "completed", ts: now - 100 } });
  const late = activityValues(all, now);
  ok(late["act.tasks"] === "1/1", `finished task still counted after the linger (got ${late["act.tasks"]})`);
  ok(late["act.tasklist"].length === 0, "settled list hides after the linger");
  ok(activityValues(all, now - 95)["act.tasklist"].length === 1, "settled list lingers briefly");

  ok(mergeDiskTasks({ a: 1 }, null).a === 1, "no disk list -> state unchanged");

  // A journal task with no file is kept as the journal saw it.
  const kept = mergeDiskTasks({ tasks: { 7: { title: "j", status: "completed", ts: 1 } } }, {});
  ok(kept.tasks["7"] && kept.tasks["7"].status === "completed", "journal task without a file kept");

  // Claude Code cleaned up a finished list: no task files, only .highwatermark.
  const hw = mkdtempSync(path.join(os.tmpdir(), "doombar-hwm-"));
  try {
    writeFileSync(path.join(hw, ".highwatermark"), "2");
    writeFileSync(path.join(hw, ".lock"), "");
    writeFileSync(path.join(hw, "3.json"), JSON.stringify({ id: "3", subject: "new", status: "pending" }));
    const cleaned = readDiskTasks(hw);
    ok(cleaned["1"].status === "completed" && cleaned["1"].cleaned && cleaned["2"].cleaned, "ids up to the mark count as completed");
    ok(cleaned["3"].status === "pending" && !cleaned["3"].cleaned, "a live file above the mark is read as usual");
    const after = activityValues(mergeDiskTasks({ offset: 0 }, cleaned), now);
    ok(after["act.tasks"] === "2/3", `after a reboot: 2 cleaned-up done of 3 (got ${after["act.tasks"]})`);
    ok(after["act.tasklist"].length === 1 && after["act.tasklist"][0].text === "new", "cleaned-up tasks stay out of the list");
    // The journal still knows a cleaned-up task: it keeps its title and shows in the list.
    const withJ = mergeDiskTasks({ tasks: { 1: { title: "first", status: "pending", ts: now - 2 } } }, cleaned);
    ok(withJ.tasks["1"].status === "completed" && withJ.tasks["1"].title === "first" && !withJ.tasks["1"].cleaned,
      "journal title restored for a cleaned-up task");
  } finally {
    rmSync(hw, { recursive: true, force: true });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
