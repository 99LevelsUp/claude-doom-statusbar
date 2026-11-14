#!/usr/bin/env node
// Behavioral round-trip test for bin/cli.js. The output settings.json cannot match the
// Python installer byte-for-byte (we write `node "…/src/*.js"`, not `"<python>" "…/*.py"`),
// so we assert behavior on a temp settings.json instead of diffing.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, chmodSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootHash, procStartTicks } from "../../src/platform/runtime.js";
import { sandboxEnv } from "../_sandbox-env.mjs";

// Pin the DOOM theme so a theme saved on this machine (`theme minecraft`) can't change
// what the statusline renders under test. Child processes inherit it via process.env.
process.env.DOOMBAR_THEME = "doom";
// Likewise keep the rate limits other live sessions shared on this machine out of the test.
process.env.DOOMBAR_RATELIMITS_SHARE = "0";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
    { cwd: tmp, encoding: "utf-8", env: withEnv({ ...sandboxEnv(tmp), DOOMBAR_NO_FONTS: "1", ...env }) });
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

// Linux and macOS: the bash 5 the installer would pick, if this machine has one (PATH's bash is
// the one checked here; the installer looks at the usual places first, which on Linux is the same).
const bashVersion = (bash) => {
  const r = spawnSync(bash, ["--norc", "--noprofile", "-c", 'echo "${BASH_VERSINFO[0]}"'], { encoding: "utf8" });
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
};
const BASH5 = WIN ? null : ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"]
  .find((b) => existsSync(b) && bashVersion(b) >= 5) || null;
// A bash that reports major version 3, like macOS's own: the installer must keep the one-shot.
function oldBashEnv(tmp) {
  const fake = path.join(tmp, "old-bash");
  writeFileSync(fake, "#!/bin/sh\necho 3\n");
  chmodSync(fake, 0o755);
  return { DOOMBAR_BASH: fake };
}
// The client's environment and its absence, per platform.
const clientEnv = (tmp) => (WIN ? gitBashEnv(tmp) : { DOOMBAR_BASH: BASH5 });
const noClientEnv = (tmp) => (WIN ? noGitBashEnv(tmp) : oldBashEnv(tmp));
const clientHere = WIN ? gitBashHere : Boolean(BASH5);

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
  const want = clientHere ? "src/doombar-client.sh" : "src/statusline.js";
  ok(cfg.statusLine?.command?.includes(want), `statusLine points at ${want}`);
  // 1 s on EVERY platform, Windows included. The Git Bash / MSYS cost of a 1 Hz tick on Windows
  // is paid by the reaper, not by slowing the HUD down — a live clock is the point of this thing.
  ok(cfg.statusLine?.refreshInterval === 1, "statusLine refreshInterval is 1 on all platforms");
  ok(cfg.env?.DOOMBAR_PRESET === `${ROOT.replace(/\\/g, "/")}/src/games/doom/presets/full.toml`,
    `DOOMBAR_PRESET -> src/games/doom/presets/full.toml (${cfg.env?.DOOMBAR_PRESET})`);
  ok(existsSync(cfg.env.DOOMBAR_PRESET), "and that preset file exists");
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

// 6b. Linux and macOS with a bash 5: the statusLine hands the tick from /bin/sh to that bash, by
// the path it was found at, with the install hash as its argument.
if (!WIN && BASH5) {
  const tmp = tmpdir();
  const env = clientEnv(tmp);
  runEnv(tmp, env, "install", "--project");
  const cmd = read(tmp).statusLine?.command || "";
  ok(cmd.startsWith(`b='${BASH5}'; f='${CLIENT}';`), `client command names the bash and the client (got: ${cmd})`);
  ok(cmd.includes(`exec "$b" --norc --noprofile "$f" ${HASH};`), "client command execs that bash with the install hash");
  ok(cmd.includes('[ -r "$f" ] && [ -x "$b" ]') && cmd.includes("unset BASH_ENV"),
    "client command guards a missing client or bash and clears BASH_ENV");
  ok(/else echo 'doombar: offline'; fi$/.test(cmd), "client command prints the offline line otherwise");
  ok(!/\bnode\b/.test(cmd), "client command starts no node process");
  const before = readFileSync(settingsPath(tmp), "utf-8");
  const out = runEnv(tmp, env, "install", "--project");
  ok(readFileSync(settingsPath(tmp), "utf-8") === before, "re-install leaves settings.json byte-identical");
  ok(!/replaced your existing statusLine/.test(out), "re-install does not call our own client foreign");
  // Claude Code runs it through /bin/sh. A bash that went away prints the offline line, exit 0.
  const gone = cmd.replace(`b='${BASH5}'`, `b='${path.join(tmp, "no-bash")}'`);
  const r = spawnSync("/bin/sh", ["-c", gone], { input: "{}", encoding: "utf8", env: withEnv(sandboxEnv(tmp)) });
  ok(r.status === 0 && r.stdout === "doombar: offline\n", `a bash that is gone prints the offline line (got ${JSON.stringify(r.stdout)})`);
  rmSync(tmp, { recursive: true, force: true });
}

// 6c. A bash path with shell syntax in it stays text: /bin/sh runs the command on every tick, so
// a `$(...)`, a quote or a backtick in a directory name must never run.
if (!WIN && BASH5) {
  const tmp = tmpdir();
  const odd = path.join(tmp, "b $(touch pwned) `touch pwned2` 'q\" dir");
  mkdirSync(odd, { recursive: true });
  symlinkSync(BASH5, path.join(odd, "bash"));
  runEnv(tmp, { DOOMBAR_BASH: path.join(odd, "bash") }, "install", "--project");
  const cmd = read(tmp).statusLine?.command || "";
  ok(cmd.includes("exec \"$b\""), `an odd bash path still gets the client command (got: ${cmd})`);
  const r = spawnSync("/bin/sh", ["-c", cmd], { cwd: tmp, input: "{}", encoding: "utf8", env: withEnv(sandboxEnv(tmp)) });
  ok(!r.error && !/not found|syntax error/i.test(r.stderr), `the command runs under /bin/sh (stderr ${JSON.stringify(r.stderr)})`);
  ok(!existsSync(path.join(tmp, "pwned")) && !existsSync(path.join(tmp, "pwned2")),
    "nothing in the bash path ran as a command");
  rmSync(tmp, { recursive: true, force: true });
}

// 7. No bash for the client (no Git Bash on Windows, a bash older than 5 elsewhere): the one-shot.
{
  const tmp = tmpdir();
  runEnv(tmp, noClientEnv(tmp), "install", "--project");
  ok(read(tmp).statusLine?.command === NODE_CMD, "no bash for the client -> node statusline.js command");
  rmSync(tmp, { recursive: true, force: true });
}

// 7b. --local writes the project's settings.local.json and leaves settings.json alone.
{
  const tmp = tmpdir();
  run(tmp, "install", "--local");
  const local = path.join(tmp, ".claude", "settings.local.json");
  ok(existsSync(local) && JSON.parse(readFileSync(local, "utf-8")).statusLine?.command, "--local installs into settings.local.json");
  ok(!existsSync(settingsPath(tmp)), "--local leaves settings.json alone");
  run(tmp, "uninstall", "--local");
  ok(Object.keys(JSON.parse(readFileSync(local, "utf-8"))).length === 0, "uninstall --local empties settings.local.json");
  rmSync(tmp, { recursive: true, force: true });
}

// 8. A settings file wired to statusline.js is rewired in place to the client.
if (WIN || BASH5) {
  const tmp = tmpdir();
  mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  writeFileSync(settingsPath(tmp), JSON.stringify({
    statusLine: { type: "command", command: 'node "C:/old/cache/claude-doom-statusbar/src/statusline.js"', refreshInterval: 1 },
  }, null, 2));
  const out = runEnv(tmp, clientEnv(tmp), "install", "--project");
  const sl = read(tmp).statusLine;
  ok(sl?.command?.includes(WIN ? `"${CLIENT}"` : `'${CLIENT}'`), "old statusline.js command upgraded to the client");
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
    ok(new RegExp(`left pid ${sleeper.pid} running`).test(out), "uninstall reports the pid it did not stop");
    ok(ourFiles(tmp).length === 0, `this installation's files removed (left: ${ourFiles(tmp).join(", ")})`);
    ok(ourFiles(tmp, other).length === 2, "another installation's files are untouched");
  } finally {
    try { sleeper.kill(); } catch { /* already gone */ }
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 11. uninstall stops a process that passes the identity check: node running this package's
// src/daemon.js, started when the heartbeat says (on Linux: the start time in /proc). A stand-in
// names the script without running it, so no real daemon (and no address of this installation)
// is involved.
if (WIN || process.platform === "linux") {
  const tmp = tmpdir();
  const start = Date.now();
  const fake = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(ROOT, "src", "daemon.js")],
    { stdio: "ignore" });
  try {
    writeFileSync(path.join(tmp, `mugshot_daemon_${HASH}.json`),
      JSON.stringify({ pid: fake.pid, start, startTicks: WIN ? undefined : procStartTicks(fake.pid), version: "0", window: 3, renewed: start }));
    const out = run(tmp, "uninstall", "--project");
    // Wait for the exit event, not the pid: on Linux a killed child stays a zombie (and its pid
    // answers) until this process reaps it, which needs the event loop.
    const gone = fake.exitCode !== null || fake.signalCode !== null || await Promise.race([
      new Promise((r) => fake.once("exit", () => r(true))),
      new Promise((r) => setTimeout(() => r(false), 3000)),
    ]);
    ok(gone, "uninstall stopped this installation's confirmed daemon");
    ok(new RegExp(`stopped the render daemon \\(pid ${fake.pid}\\)`).test(out), "uninstall reports the stopped daemon");
    ok(ourFiles(tmp).length === 0, "its heartbeat is removed");
  } finally {
    try { fake.kill(); } catch { /* already gone */ }
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 12. With DOOMBAR_RUNTIME_DIR set, uninstall cleans only that directory: a heartbeat and files of
// this installation in another candidate directory (here, an XDG runtime dir) stay.
if (!WIN) {
  const tmp = tmpdir();
  const xdg = path.join(tmp, "xdg");
  mkdirSync(path.join(xdg, "doombar"), { recursive: true, mode: 0o700 });
  const planted = [`mugshot_daemon_${HASH}.json`, `mugshot_payload_${HASH}_s1.json`];
  for (const n of planted) writeFileSync(path.join(xdg, "doombar", n), "x");
  runEnv(tmp, { XDG_RUNTIME_DIR: xdg }, "uninstall", "--project");
  ok(planted.every((n) => existsSync(path.join(xdg, "doombar", n))), "uninstall with the override leaves other runtime dirs alone");
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
