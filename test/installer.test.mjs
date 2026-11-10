#!/usr/bin/env node
// Behavioral round-trip test for bin/cli.js. The output settings.json cannot match the
// Python installer byte-for-byte (we write `node "…/src/*.js"`, not `"<python>" "…/*.py"`),
// so we assert behavior on a temp settings.json instead of diffing.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootHash } from "../src/fold.js";

// Pin the DOOM theme so a theme saved on this machine (`theme minecraft`) can't change
// what the statusline renders under test. Child processes inherit it via process.env.
process.env.DOOMBAR_THEME = "doom";
// Likewise keep the rate limits other live sessions shared on this machine out of the test.
process.env.DOOMBAR_RATELIMITS_SHARE = "0";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "cli.js");

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { console.log(`  FAIL ${msg}`); failures++; }
};

const ROOT = path.resolve(HERE, "..");
const HASH = rootHash(ROOT);
const WIN = process.platform === "win32";

// Windows environment keys are case-insensitive: drop every spelling of a key before setting it,
// or a leftover `PROGRAMFILES` would sit next to the `ProgramFiles` we set.
function withEnv(over) {
  const env = { ...process.env };
  for (const k of Object.keys(over)) {
    for (const e of Object.keys(env)) if (e.toLowerCase() === k.toLowerCase()) delete env[e];
  }
  return { ...env, ...over };
}

// Every child gets the test's own dir as its temp dir. The installer's uninstall stops this
// installation's daemon and deletes its files from the temp dir, and this checkout may be the
// developer's live install (same hash), so it must never see the real temp dir.
function run(tmp, ...args) {
  return runEnv(tmp, {}, ...args);
}
function runEnv(tmp, env, ...args) {
  return execFileSync(process.execPath, [CLI, ...args],
    { cwd: tmp, encoding: "utf-8", env: withEnv({ TEMP: tmp, TMP: tmp, TMPDIR: tmp, ...env }) });
}
const settingsPath = (tmp) => path.join(tmp, ".claude", "settings.json");
const read = (tmp) => JSON.parse(readFileSync(settingsPath(tmp), "utf-8"));
const tmpdir = () => mkdtempSync(path.join(os.tmpdir(), "doombar-test-"));

// Git Bash present, whatever this machine has: CLAUDE_CODE_GIT_BASH_PATH names a file that exists.
function gitBashEnv(tmp) {
  const bash = path.join(tmp, "bash.exe");
  writeFileSync(bash, "");
  return { CLAUDE_CODE_GIT_BASH_PATH: bash };
}
// Git Bash absent: the override names a missing file, the standard locations and PATH are empty dirs.
// Windows resets a 64-bit child's ProgramFiles from ProgramW6432, so that one is emptied too.
function noGitBashEnv(tmp) {
  const empty = path.join(tmp, "empty");
  mkdirSync(empty, { recursive: true });
  return { CLAUDE_CODE_GIT_BASH_PATH: path.join(empty, "bash.exe"), ProgramFiles: empty, ProgramW6432: empty,
    "ProgramFiles(x86)": empty, LOCALAPPDATA: empty, PATH: empty };
}
// What a default install on this machine is expected to find (the PATH lookup is not mirrored).
const gitBashHere = WIN && [process.env.CLAUDE_CODE_GIT_BASH_PATH,
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
  process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
].some((p) => p && existsSync(p));

const CLIENT = `${ROOT.replace(/\\/g, "/")}/src/doombar-client.sh`;
const NODE_CMD = `node "${ROOT.replace(/\\/g, "/")}/src/statusline.js"`;
const ourFiles = (dir, hash = HASH) => readdirSync(dir).filter((n) =>
  n.startsWith(`mugshot_daemon_${hash}.`) || n.startsWith(`mugshot_payload_${hash}_`) || n.startsWith(`mugshot_frame_${hash}_`));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// 1. empty {} -> install -> full structure present
{
  const tmp = tmpdir();
  run(tmp, "install", "--project", "--preset", "full");
  const cfg = read(tmp);
  const want = gitBashHere ? "src/doombar-client.sh" : "src/statusline.js";
  ok(cfg.statusLine?.command?.includes(want), `statusLine points at ${want}`);
  // 1 s on EVERY platform, Windows included. The Git Bash / MSYS cost of a 1 Hz tick on Windows
  // is paid by the reaper, not by slowing the HUD down — a live clock is the point of this thing.
  ok(cfg.statusLine?.refreshInterval === 1, "statusLine refreshInterval is 1 on all platforms");
  ok(cfg.env?.DOOMBAR_PRESET?.includes("full.toml"), "DOOMBAR_PRESET -> full.toml");
  ok(cfg.env?.FORCE_HYPERLINK === "1", "FORCE_HYPERLINK = 1");
  const EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied",
    "Stop", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted"];
  ok(EVENTS.every((e) => Array.isArray(cfg.hooks?.[e]) && cfg.hooks[e].length === 1),
     "all 10 hook events present (incl. SessionStart) with one entry each");
  ok(EVENTS.every((e) => cfg.hooks[e][0].hooks[0].async === true),
     "every hook entry is async:true (off the blocking path)");
  ok(EVENTS.every((e) => {
    const h = cfg.hooks[e][0].hooks[0];
    return h.command === "node" && Array.isArray(h.args) && h.args.some((a) => a.includes("src/hook.js"));
  }), "every hook entry is exec form (command:node + args, no shell wrapper)");
  // SessionEnd cleans up the session's files. It runs synchronously: an async hook can be cut
  // off when Claude Code exits, which is exactly when this one runs.
  const end = cfg.hooks?.SessionEnd;
  ok(Array.isArray(end) && end.length === 1, "SessionEnd hook present with one entry");
  ok(end?.[0].hooks[0].command === "node" && end[0].hooks[0].args.some((a) => a.includes("src/hook.js")),
    "SessionEnd entry is exec form and runs src/hook.js");
  ok(end?.[0].hooks[0].async !== true, "SessionEnd entry is synchronous (not async)");
  rmSync(tmp, { recursive: true, force: true });
}

// 2. install twice -> arrays do NOT grow (THE idempotency assertion)
{
  const tmp = tmpdir();
  run(tmp, "install", "--project");
  run(tmp, "install", "--project");
  const cfg = read(tmp);
  const sizes = Object.values(cfg.hooks).map((a) => a.length);
  ok(sizes.every((n) => n === 1), `re-install did not double-add (hook sizes = ${sizes.join(",")})`);
  rmSync(tmp, { recursive: true, force: true });
}

// 2b. --refresh is an explicit override in both directions, and 0 omits the key entirely
{
  const tmp = tmpdir();
  run(tmp, "install", "--project", "--refresh", "5");
  ok(read(tmp).statusLine?.refreshInterval === 5, "--refresh 5 sets refreshInterval to 5");
  run(tmp, "install", "--project", "--refresh=0");
  ok(!("refreshInterval" in read(tmp).statusLine), "--refresh=0 omits refreshInterval");
  let rejected = false;
  try { run(tmp, "install", "--project", "--refresh", "-2"); } catch { rejected = true; }
  ok(rejected, "--refresh rejects a negative value");
  rmSync(tmp, { recursive: true, force: true });
}

// 2c. --refresh=0 on an install that already had a timer: the key goes away and it is reported,
// so anyone who deliberately wants a strictly event-driven HUD can see that it took effect.
{
  const tmp = tmpdir();
  mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  writeFileSync(settingsPath(tmp), JSON.stringify({
    statusLine: { type: "command", command: 'node "/old/src/statusline.js"', refreshInterval: 1 },
  }, null, 2));
  const out = run(tmp, "install", "--project", "--refresh=0");
  ok(!("refreshInterval" in read(tmp).statusLine), "--refresh=0 drops an existing timer");
  ok(/dropped refreshInterval/.test(out), "install reports that it dropped the timer");
  rmSync(tmp, { recursive: true, force: true });
}

// 2d. UPGRADE PATH: an entry of ours pointing at a PREVIOUS install's path must be re-pointed,
// not skipped as "already installed". Skipping it left statusLine on the new version (it is
// replaced unconditionally) while the hook still ran the old code — so a fix shipped in the hook
// silently never took effect. Covers both a moved path and the legacy shell form.
{
  const tmp = tmpdir();
  mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  writeFileSync(settingsPath(tmp), JSON.stringify({
    hooks: {
      // stale exec form: our marker, someone else's (older) path
      SessionStart: [{ hooks: [{ type: "command", command: "node", args: ["C:/old/cache/claude-doom-statusbar/src/hook.js"], async: true }] }],
      // legacy shell form: our marker, no args array at all
      Stop: [{ hooks: [{ type: "command", command: 'node "C:/old/cache/claude-doom-statusbar/src/hook.js"' }] }],
    },
  }, null, 2));
  const out = run(tmp, "install", "--project");
  const cfg = read(tmp);
  ok(/re-pointed 2 hook event/.test(out), `install reports the re-pointing (got: ${out.match(/note.*/)?.[0]})`);
  for (const ev of ["SessionStart", "Stop"]) {
    ok(cfg.hooks[ev].length === 1, `${ev}: still exactly one entry (no double-add)`);
    const h = cfg.hooks[ev][0].hooks[0];
    ok(h.command === "node" && Array.isArray(h.args), `${ev}: now exec form`);
    ok(!h.args.some((a) => a.includes("old/cache")), `${ev}: stale path is gone`);
    ok(h.args.some((a) => a.includes("src/hook.js")), `${ev}: points at this install's hook.js`);
  }
  // A second run must now be a genuine no-op.
  const out2 = run(tmp, "install", "--project");
  ok(!/re-pointed/.test(out2), "re-running does not re-point again (converged)");
  rmSync(tmp, { recursive: true, force: true });
}

// 3. foreign existing statusLine -> backup note + .bak written, user content preserved in .bak
{
  const tmp = tmpdir();
  mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  const foreign = { statusLine: { type: "command", command: "my-own-statusline" }, env: { MY_VAR: "keep" } };
  writeFileSync(settingsPath(tmp), JSON.stringify(foreign, null, 2));
  const out = run(tmp, "install", "--project");
  ok(/replaced your existing statusLine/.test(out), "emits 'replaced existing statusLine' note");
  ok(existsSync(settingsPath(tmp) + ".bak"), ".bak backup written");
  const bak = JSON.parse(readFileSync(settingsPath(tmp) + ".bak", "utf-8"));
  ok(bak.statusLine?.command === "my-own-statusline", ".bak contains the user's original statusLine");
  const cfg = read(tmp);
  ok(cfg.env?.MY_VAR === "keep", "unrelated env var preserved across install");
  rmSync(tmp, { recursive: true, force: true });
}

// 4. uninstall -> returns to pre-install state (clean removal of all our keys)
{
  const tmp = tmpdir();
  run(tmp, "install", "--project");
  run(tmp, "uninstall", "--project");
  const cfg = read(tmp);
  ok(cfg.statusLine === undefined, "statusLine removed");
  ok(cfg.hooks === undefined, "hooks removed (was empty after pruning)");
  ok(cfg.env === undefined, "env removed (was empty after pruning)");
  ok(Object.keys(cfg).length === 0, "settings.json is back to empty {}");
  rmSync(tmp, { recursive: true, force: true });
}

// 5. uninstall cleans up LEGACY Python entries too (a user who ran install.py earlier)
{
  const tmp = tmpdir();
  mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  const legacy = {
    statusLine: { type: "command", command: '"python" "/x/statusline.py"' },
    env: { DOOMBAR_PRESET: "/x/presets/full.toml", FORCE_HYPERLINK: "1" },
    hooks: { Stop: [{ hooks: [{ type: "command", command: '"python" "/x/hooks/mugshot_hook.py"' }] }] },
  };
  writeFileSync(settingsPath(tmp), JSON.stringify(legacy, null, 2));
  run(tmp, "uninstall", "--project");
  const cfg = read(tmp);
  ok(Object.keys(cfg).length === 0, "legacy Python install fully removed by JS uninstall");
  rmSync(tmp, { recursive: true, force: true });
}

// 6. Windows with Git Bash: the statusLine sources the packaged client into Claude Code's bash,
// with this installation's hash and a guard for a missing client. Re-installing changes nothing.
if (WIN) {
  const tmp = tmpdir();
  const env = gitBashEnv(tmp);
  runEnv(tmp, env, "install", "--project");
  const cmd = read(tmp).statusLine?.command || "";
  ok(cmd.startsWith(`DOOMBAR_ROOT_HASH=${HASH};`), `client command sets the install hash first (got: ${cmd})`);
  ok(cmd.includes(`"${CLIENT}"`), "client command names this package's doombar-client.sh");
  ok(/if \[ -r "\$f" \]; then \. "\$f"; else echo 'doombar: offline'; fi$/.test(cmd),
    "client command sources the client, or prints the offline line when it is missing");
  ok(!/\bnode\b/.test(cmd), "client command starts no node process");
  ok(read(tmp).statusLine.refreshInterval === 1, "client command keeps the 1 s refresh");
  const before = readFileSync(settingsPath(tmp), "utf-8");
  const out = runEnv(tmp, env, "install", "--project");
  ok(readFileSync(settingsPath(tmp), "utf-8") === before, "re-install leaves settings.json byte-identical");
  ok(!/replaced your existing statusLine/.test(out), "re-install does not call our own client foreign");
  rmSync(tmp, { recursive: true, force: true });
}

// 7. Git Bash absent (or not Windows): the old one-shot renderer command.
{
  const tmp = tmpdir();
  runEnv(tmp, noGitBashEnv(tmp), "install", "--project");
  ok(read(tmp).statusLine?.command === NODE_CMD, "no Git Bash -> node statusline.js command");
  if (!WIN) {
    runEnv(tmp, gitBashEnv(tmp), "install", "--project");
    ok(read(tmp).statusLine?.command === NODE_CMD, "not Windows -> node command even with a bash path set");
  }
  rmSync(tmp, { recursive: true, force: true });
}

// 8. A settings file wired to statusline.js is rewired in place to the client.
if (WIN) {
  const tmp = tmpdir();
  mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  writeFileSync(settingsPath(tmp), JSON.stringify({
    statusLine: { type: "command", command: 'node "C:/old/cache/claude-doom-statusbar/src/statusline.js"', refreshInterval: 1 },
  }, null, 2));
  const out = runEnv(tmp, gitBashEnv(tmp), "install", "--project");
  const sl = read(tmp).statusLine;
  ok(sl?.command?.includes(`"${CLIENT}"`), "old statusline.js command upgraded to the client");
  ok(sl?.refreshInterval === 1, "upgrade keeps the 1 s refresh");
  ok(!/replaced your existing statusLine/.test(out), "upgrade recognises the old command as ours");
  rmSync(tmp, { recursive: true, force: true });
}

// 9. uninstall removes the client command and leaves nothing of ours behind, in settings or temp.
{
  const tmp = tmpdir();
  runEnv(tmp, gitBashEnv(tmp), "install", "--project");
  writeFileSync(path.join(tmp, `mugshot_payload_${HASH}_s1.json`), "doombar-env\n{}");
  writeFileSync(path.join(tmp, `mugshot_frame_${HASH}_s1.json`), "doombar-frame v=1\n");
  writeFileSync(path.join(tmp, `mugshot_daemon_${HASH}.claim`), "{}");
  run(tmp, "uninstall", "--project");
  const cfg = read(tmp);
  ok(Object.keys(cfg).length === 0, "uninstall after a client install -> settings.json is {}");
  ok(ourFiles(tmp).length === 0, `uninstall removed this installation's temp files (left: ${ourFiles(tmp).join(", ")})`);
  rmSync(tmp, { recursive: true, force: true });
}

// 10. uninstall with a heartbeat naming an unrelated live process: nothing is killed (it is not
// this installation's daemon), but every file of this installation goes, and another one's stay.
{
  const tmp = tmpdir();
  const other = "ffffffffff" === HASH ? "eeeeeeeeee" : "ffffffffff";
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const start = Date.now();
    writeFileSync(path.join(tmp, `mugshot_daemon_${HASH}.json`),
      JSON.stringify({ pid: sleeper.pid, start, version: "0", window: 3, renewed: start }));
    const claim = path.join(tmp, `mugshot_daemon_${HASH}.claim`);
    for (const f of [claim, `${claim}.lock`, `${claim}.123.tmp`, path.join(tmp, `mugshot_payload_${HASH}_abc.json`),
      path.join(tmp, `mugshot_frame_${HASH}_abc.json`), path.join(tmp, `mugshot_frame_${HASH}_abc.json.77.tmp`),
      path.join(tmp, `mugshot_daemon_${other}.json`), path.join(tmp, `mugshot_payload_${other}_abc.json`)]) {
      writeFileSync(f, "x");
    }
    const out = run(tmp, "uninstall", "--project");
    ok(alive(sleeper.pid), "an unrelated process named by the heartbeat is left running");
    if (WIN) ok(new RegExp(`left pid ${sleeper.pid} running`).test(out), "uninstall reports the pid it did not stop");
    ok(ourFiles(tmp).length === 0, `this installation's files removed (left: ${ourFiles(tmp).join(", ")})`);
    ok(ourFiles(tmp, other).length === 2, "another installation's files are untouched");
  } finally {
    try { sleeper.kill(); } catch { /* already gone */ }
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 11. uninstall stops a process that passes the identity check: node running this package's
// src/daemon.js, started when the heartbeat says. A stand-in names the script without running it,
// so no real daemon (and no pipe of this installation) is involved.
if (WIN) {
  const tmp = tmpdir();
  const start = Date.now();
  const fake = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(ROOT, "src", "daemon.js")],
    { stdio: "ignore" });
  try {
    writeFileSync(path.join(tmp, `mugshot_daemon_${HASH}.json`),
      JSON.stringify({ pid: fake.pid, start, version: "0", window: 3, renewed: start }));
    const out = run(tmp, "uninstall", "--project");
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      gone = !alive(fake.pid);
      if (!gone) execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 50)"]);
    }
    ok(gone, "uninstall stopped this installation's confirmed daemon");
    ok(new RegExp(`stopped the render daemon \\(pid ${fake.pid}\\)`).test(out), "uninstall reports the stopped daemon");
    ok(ourFiles(tmp).length === 0, "its heartbeat is removed");
  } finally {
    try { fake.kill(); } catch { /* already gone */ }
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
