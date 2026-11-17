#!/usr/bin/env node
// Taking over an installation of claude-doom-statusbar, the package this one replaces, and
// cleaning up what it left: the settings migration, the removal of the old global package (through
// an npm stand-in, never the real npm), the old daemon's identity check, and uninstall in old
// runtime directories.

import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, realpathSync, utimesSync, symlinkSync,
  lstatSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootHash, procStartTicks } from "../../src/platform/runtime.js";
import { install, uninstall, renameOldEnv } from "../../src/install/settings.js";
import { privateCandidates, stopDaemon, removeOldPackageFiles } from "../../src/install/daemons.js";
import { npmCommand } from "../../src/install/old-package.js";
import { sandboxEnv } from "../_sandbox-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const HASH = rootHash(ROOT);
const WIN = process.platform === "win32";
const fwd = (p) => p.replace(/\\/g, "/");
const HOOK = fwd(path.join(ROOT, "src", "hook.js"));
const STANDARD = fwd(path.join(ROOT, "src", "games", "doom", "presets", "standard.toml"));
const EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied",
  "Stop", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "SessionEnd"];
const DAY = 24 * 60 * 60 * 1000;

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { console.log(`  FAIL ${msg}`); failures++; }
};

// Windows environment keys are case-insensitive: drop every spelling of a key before setting it.
function withEnv(over) {
  const env = { ...process.env };
  for (const k of Object.keys(over)) {
    for (const e of Object.keys(env)) if (e.toLowerCase() === k.toLowerCase()) delete env[e];
  }
  return { ...env, ...over };
}

// One test world: a temp dir that is the temp and runtime directory, a home directory inside it
// (HOME and USERPROFILE), and an npm global folder holding the old package, as 0.15.0 installed it.
function world() {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gamebar-migrate-")));
  const home = path.join(tmp, "home");
  const npmRoot = path.join(tmp, "npm-global");
  const oldRoot = path.join(npmRoot, "claude-doom-statusbar");
  for (const d of [path.join(home, ".claude"), path.join(oldRoot, "src"), path.join(oldRoot, "presets")]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(oldRoot, "package.json"), JSON.stringify({ name: "claude-doom-statusbar", version: "0.15.0" }));
  for (const f of ["src/hook.js", "src/daemon.js", "src/statusline.js", "src/doombar-client.sh", "presets/full.toml"]) {
    writeFileSync(path.join(oldRoot, f), "");
  }
  const log = path.join(tmp, "npm-calls.jsonl");
  const settings = path.join(home, ".claude", "settings.json");
  // The user directory is left at its default place, ~/.claude/claude-game-bar, in the sandbox home.
  const env = { ...sandboxEnv(tmp), GAMEBAR_USER_DIR: undefined, DOOMBAR_USER_DIR: undefined,
    HOME: home, USERPROFILE: home, GAMEBAR_NO_FONTS: "1",
    NPM_STUB_ROOT: npmRoot, NPM_STUB_LOG: log, NPM_STUB_WATCH: settings };
  return { tmp, home, npmRoot, oldRoot, log, settings, env };
}
const calls = (w) => existsSync(w.log) ? readFileSync(w.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const uninstallCalls = (w) => calls(w).filter((c) => c.args[0] === "uninstall");
const cli = (w, extra, ...args) => execFileSync(process.execPath, [CLI, ...args],
  { cwd: w.tmp, encoding: "utf-8", env: withEnv({ ...w.env, ...extra }) });
// A user-level install writes to the home directory: make sure the child sees the sandbox one.
const homeIsSandboxed = (w) => fwd(execFileSync(process.execPath, ["-p", "require('node:os').homedir()"],
  { encoding: "utf8", env: withEnv(w.env) }).trim()) === fwd(w.home);

// The settings 0.15.0 wrote from its global folder.
function oldSettings(w) {
  const o = fwd(w.oldRoot);
  const hooks = Object.fromEntries(EVENTS.map((ev) => [ev, [{ hooks: [{ type: "command", command: "node",
    args: [`${o}/src/hook.js`], ...(ev === "SessionEnd" ? {} : { async: true }) }] }]]));
  // A second set in one event, from a checkout under another directory name.
  hooks.PreToolUse.push({ hooks: [{ type: "command", command: "node", args: ["/home/u/bar-checkout/src/hook.js"], async: true }] });
  // A hook of someone else's whose path merely contains "doom".
  hooks.Stop.push({ hooks: [{ type: "command", command: "node", args: ["/home/u/doom-tools/hook.js"] }] });
  return {
    statusLine: { type: "command", refreshInterval: 1, command: `DOOMBAR_ROOT_HASH=${rootHash(w.oldRoot)}; f="${o}/src/doombar-client.sh"; ` +
      "if [ -r \"$f\" ]; then . \"$f\"; else echo 'doombar: offline'; fi" },
    env: { DOOMBAR_PRESET: `${o}/presets/full.toml`, FORCE_HYPERLINK: "1", DOOMBAR_GLYPHS: "quadrant", MY_VAR: "keep" },
    hooks,
  };
}
const ourHooks = (cfg, ev) => (cfg.hooks[ev] || []).flatMap((g) => g.hooks).filter((h) => /src\/hook\.js$/.test((h.args || []).join(" ")));

// What the old package leaves in its runtime directory (the temp directory on Windows): learned
// state, files of two other install hashes, a session, the old face cache, and, with `withNew`, a
// file under the current prefix. Returns { name: content }.
const OTHER_HASHES = ["aaaaaaaaaa", "bbbbbbbbbb"];
const LEARNED = { "mugshot_ratehealth_global.json": "gamebar_ratehealth_global.json", "mugshot_ratelimits_global.json": "gamebar_ratelimits_global.json" };
function plantTraces(dir, { withNew = true } = {}) {
  const files = {
    "mugshot_ratehealth_global.json": '{"k":1.7,"p5":12,"p7":3}',
    "mugshot_ratelimits_global.json": '{"five_hour":{"used_percentage":40,"resets_at":1}}',
    "savings_s1.json": '{"offset":10,"saved":1200,"original":4000}',
    [`mugshot_daemon_${OTHER_HASHES[0]}.json`]: "{}",
    [`mugshot_payload_${OTHER_HASHES[1]}_s2.json`]: "{}",
    "mugshot_s1.json": "{}",
    "mugshot_s1.json.jsonl": "",
    "mugshot_cpu.json": "{}",
    "doombar_faces_0123456789ab.json": "{}",
  };
  if (withNew) files["gamebar_s9.json"] = '{"mine":true}';
  for (const [n, t] of Object.entries(files)) writeFileSync(path.join(dir, n), t);
  return files;
}
const oldPrefixed = (dir) => readdirSync(dir).filter((n) => n.startsWith("mugshot_") || n.startsWith("doombar_faces_"));
const sameFiles = (dir, files) => Object.entries(files).every(([n, t]) => existsSync(path.join(dir, n)) && readFileSync(path.join(dir, n), "utf8") === t);
const REINSTALL = /a repository wired with `claude-doom-statusbar install --project` or `--local` needs `claude-game-bar install --project` \(or `--local`\) run in it again/;

// --- A 0.15.0 installation from the global npm folder is taken over ---------------------------
{
  const w = world();
  if (!homeIsSandboxed(w)) {
    ok(false, "the child process sees the sandbox home directory (skipping the user-level install)");
  } else {
    const original = JSON.stringify(oldSettings(w), null, 2);
    writeFileSync(w.settings, original);
    writeFileSync(path.join(w.home, ".claude", "doombar-theme.json"), JSON.stringify({ theme: "minecraft" }) + "\n");
    const traces = plantTraces(w.tmp);
    ok(oldPrefixed(w.tmp).length === 8 && OTHER_HASHES.every((h) => oldPrefixed(w.tmp).some((n) => n.includes(h))),
      "before the install, old-prefix files of two install hashes and the learned state are there");
    const out = cli(w, {}, "install");
    const cfg = JSON.parse(readFileSync(w.settings, "utf8"));

    ok(Object.entries(LEARNED).every(([o, n]) => existsSync(path.join(w.tmp, n)) && readFileSync(path.join(w.tmp, n), "utf8") === traces[o]),
      "the learned state is under the new names, with the same content");
    ok(readFileSync(path.join(w.tmp, "savings_s1.json"), "utf8") === traces["savings_s1.json"],
      "a session's savings totals, already at their place, stay as they are");
    ok(oldPrefixed(w.tmp).length === 0, `no mugshot_ or doombar_faces_ file is left (left: ${oldPrefixed(w.tmp).join(", ")})`);
    ok(readFileSync(path.join(w.tmp, "gamebar_s9.json"), "utf8") === traces["gamebar_s9.json"], "a gamebar_ file is not touched");
    ok(REINSTALL.test(out), "the output says to re-install repositories wired with the old package");
    const bak = `${w.settings}.bak`, firstBak = `${w.settings}.bak-claude-doom-statusbar`;
    ok(existsSync(firstBak) && readFileSync(firstBak, "utf8") === original, "the settings before the takeover are kept in settings.json.bak-claude-doom-statusbar");
    ok(existsSync(bak) && readFileSync(bak, "utf8") === original, "and in settings.json.bak");

    ok(EVENTS.every((ev) => ourHooks(cfg, ev).length === 1), "exactly one hook of ours per event");
    ok(EVENTS.every((ev) => ourHooks(cfg, ev)[0].args[0] === HOOK), "every hook points at this package's hook.js");
    ok(cfg.hooks.Stop.some((g) => g.hooks.some((h) => (h.args || []).includes("/home/u/doom-tools/hook.js"))),
      "someone else's hook with \"doom\" in its path is kept");
    ok(!JSON.stringify(cfg).includes(fwd(w.oldRoot)), "nothing in the settings names the old package's folder");
    ok(/src\/(gamebar-client\.sh|statusline\.js)/.test(cfg.statusLine.command) && cfg.statusLine.command.includes(fwd(ROOT)),
      "the statusLine runs this package");
    ok(!("GAMEBAR_PRESET" in cfg.env) && !("GAMEBAR_SKIN" in cfg.env), `the old package's preset is gone and no skin is written (${JSON.stringify(cfg.env)})`);
    ok(!("DOOMBAR_PRESET" in cfg.env) && !("DOOMBAR_GLYPHS" in cfg.env), "no DOOMBAR_ names are left in env");
    ok(cfg.env.GAMEBAR_GLYPHS === "quadrant" && cfg.env.MY_VAR === "keep", "other settings are renamed or kept");
    const theme = path.join(w.home, ".claude", "gamebar-theme.json");
    ok(existsSync(theme) && JSON.parse(readFileSync(theme, "utf8")).theme === "minecraft", "Minecraft is still the saved theme");
    const skin = path.join(w.home, ".claude", "claude-game-bar", "skin.json");
    ok(existsSync(skin) && JSON.parse(readFileSync(skin, "utf8")).skin === "minecraft",
      "and the saved skin, in ~/.claude/claude-game-bar/skin.json, is Minecraft's");
    ok(!existsSync(path.join(w.home, ".claude", "doombar-theme.json")), "the old theme file is gone");

    const un = uninstallCalls(w);
    ok(un.length === 1 && un[0].args.join(" ") === "uninstall -g claude-doom-statusbar", "npm was asked to remove the old package");
    ok(un[0] && un[0].watched && !un[0].watched.includes(fwd(w.oldRoot)) && un[0].watched.includes(HOOK),
      "the removal ran after the new settings were written");
    ok(!existsSync(w.oldRoot), "the old package's folder is gone");
    ok(/old package: removed the global claude-doom-statusbar/.test(out), "the output says the old package was removed");

    const before = readFileSync(w.settings, "utf8");
    const n = calls(w).length;
    const out2 = cli(w, {}, "install");
    ok(readFileSync(w.settings, "utf8") === before, "re-running install leaves the settings byte-identical");
    ok(readFileSync(bak, "utf8") === original && readFileSync(firstBak, "utf8") === original,
      "a second install leaves the first install's backups intact");
    ok(uninstallCalls(w).length === 1 && calls(w).length === n + 1, "re-running only asks npm where its global folder is");
    ok(!/re-pointed|old package|renamed/.test(out2) && !REINSTALL.test(out2), "re-running reports nothing to move");

    // uninstall after the migration leaves nothing of ours.
    cli(w, {}, "uninstall");
    const after = JSON.parse(readFileSync(w.settings, "utf8"));
    ok(EVENTS.every((ev) => !after.hooks || ourHooks(after, ev).length === 0) && !after.statusLine,
      "uninstall after the migration removes every entry");
    ok(after.env && !("GAMEBAR_PRESET" in after.env) && !("DOOMBAR_PRESET" in after.env) && after.env.MY_VAR === "keep",
      "uninstall removes the preset setting under both names and keeps the user's own");
    ok(after.hooks?.Stop?.length === 1, "uninstall keeps someone else's hook");
  }
  rmSync(w.tmp, { recursive: true, force: true });
}

// --- npm through the stand-in: failure, --keep-old, no old package, project installs ----------
const themeFiles = (w) => ({ old: path.join(w.home, ".claude", "doombar-theme.json"), now: path.join(w.home, ".claude", "gamebar-theme.json") });
const writeTheme = (file, theme) => writeFileSync(file, JSON.stringify({ theme }) + "\n");
const themeIn = (file) => JSON.parse(readFileSync(file, "utf8")).theme;
{
  const w = world();
  if (homeIsSandboxed(w)) {
    const traces = plantTraces(w.tmp);
    writeTheme(themeFiles(w).old, "minecraft");
    const out = cli(w, { NPM_STUB_FAIL: "1" }, "install");
    ok(/could not remove the global claude-doom-statusbar \(npm exited 1\); remove it with: (sudo )?npm uninstall -g claude-doom-statusbar/.test(out),
      `a failing removal prints the manual command (${out.match(/old package:.*/)?.[0]})`);
    ok(existsSync(w.oldRoot), "and the install still succeeds (exit 0) with the package left in place");
    ok(sameFiles(w.tmp, traces) && existsSync(themeFiles(w).old) && !REINSTALL.test(out),
      "a failing removal leaves the old package's files and its theme file");
  }
  rmSync(w.tmp, { recursive: true, force: true });
}
{
  const w = world();
  if (homeIsSandboxed(w)) {
    const traces = plantTraces(w.tmp);
    writeTheme(themeFiles(w).old, "minecraft");
    const out = cli(w, {}, "install", "--keep-old");
    ok(uninstallCalls(w).length === 0 && existsSync(w.oldRoot), "--keep-old never calls the removal");
    ok(/old package: kept the global claude-doom-statusbar \(--keep-old\)/.test(out), "--keep-old says the old package was kept");
    ok(sameFiles(w.tmp, traces) && !existsSync(path.join(w.tmp, "gamebar_ratehealth_global.json")),
      "--keep-old touches none of the old package's files");
    ok(existsSync(themeFiles(w).old) && themeIn(themeFiles(w).old) === "minecraft" && !existsSync(themeFiles(w).now),
      "--keep-old leaves the old theme file and creates no gamebar-theme.json");
    ok(!REINSTALL.test(out), "--keep-old prints no re-install note");
  }
  rmSync(w.tmp, { recursive: true, force: true });
}
{
  const w = world();
  rmSync(w.oldRoot, { recursive: true, force: true });
  if (homeIsSandboxed(w)) {
    const { old, now } = themeFiles(w);
    writeTheme(old, "satisfactory");
    const out = cli(w, {}, "install");
    ok(uninstallCalls(w).length === 0, "no global old package means no removal");
    ok(!/old package/.test(out) && !REINSTALL.test(out), "and no line about it");
    ok(existsSync(old) && themeIn(old) === "satisfactory" && !existsSync(now) && !/kept the saved theme/.test(out),
      "an old theme file naming an unknown theme is left in place, and no new one is written");

    writeTheme(now, "minecraft");
    writeTheme(old, "doom");
    cli(w, {}, "install");
    ok(themeIn(now) === "minecraft" && existsSync(old), "with both theme files, the new one wins and the old one stays while the old package is not removed");
  }
  rmSync(w.tmp, { recursive: true, force: true });
}
{
  const w = world();
  const traces = plantTraces(w.tmp);
  writeTheme(themeFiles(w).old, "minecraft");
  for (const flag of ["--project", "--local"]) {
    const out = cli(w, {}, "install", flag);
    ok(calls(w).length === 0 && existsSync(w.oldRoot), `${flag} leaves the old global package alone and does not run npm`);
    ok(existsSync(themeFiles(w).old) && themeIn(themeFiles(w).old) === "minecraft" && !existsSync(themeFiles(w).now),
      `${flag} leaves the old theme file and creates no gamebar-theme.json`);
    ok(sameFiles(w.tmp, traces) && !REINSTALL.test(out), `${flag} touches none of the old package's files`);
  }
  rmSync(w.tmp, { recursive: true, force: true });
}
// The takeover with both theme files: the new one wins, and the old one goes with the old package.
// The old file goes even when it names no theme this package knows: the old package that wrote it is
// gone, and the bar would read it as the default theme anyway.
{
  const w = world();
  if (homeIsSandboxed(w)) {
    const { old, now } = themeFiles(w);
    writeTheme(now, "minecraft");
    writeTheme(old, "doom");
    const out = cli(w, {}, "install");
    ok(themeIn(now) === "minecraft" && !existsSync(old) && !/kept the saved theme/.test(out),
      "with both theme files the new one wins, and the takeover removes the old one");
  }
  rmSync(w.tmp, { recursive: true, force: true });
}
{
  const w = world();
  if (homeIsSandboxed(w)) {
    const { old, now } = themeFiles(w);
    writeTheme(old, "doom");
    const out = cli(w, {}, "install");
    ok(existsSync(now) && themeIn(now) === "doom" && !existsSync(old), "a saved default theme is moved to the new file");
    ok(out.includes(`kept the saved theme (doom), now in ${now}`), "and the note names the file it is in");
  }
  rmSync(w.tmp, { recursive: true, force: true });
}
{
  const w = world();
  if (homeIsSandboxed(w)) {
    const { old, now } = themeFiles(w);
    writeTheme(old, "satisfactory");
    cli(w, {}, "install");
    ok(!existsSync(old) && !existsSync(now), "the takeover removes an old theme file naming an unknown theme, and writes no new one");
  }
  rmSync(w.tmp, { recursive: true, force: true });
}

// --- The old package's daemon: stopped only when its identity is confirmed --------------------
{
  const w = world();
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const start = Date.now();
    const oldHash = rootHash(realpathSync(w.oldRoot));
    writeFileSync(path.join(w.tmp, `mugshot_daemon_${oldHash}.json`),
      JSON.stringify({ pid: sleeper.pid, start, version: "0.15.0", window: 3, renewed: start }));
    if (homeIsSandboxed(w)) {
      const out = cli(w, {}, "install");
      let alive = true;
      try { process.kill(sleeper.pid, 0); } catch { alive = false; }
      ok(alive, "a pid the old heartbeat names but that is not the old daemon is left running");
      ok(new RegExp(`left pid ${sleeper.pid} running: not confirmed as the old package's render daemon`).test(out),
        "the output says so");
      ok(uninstallCalls(w).length === 1, "the removal still runs");
      ok(!readdirSync(w.tmp).some((n) => n.startsWith(`mugshot_daemon_${oldHash}`)), "the old package's daemon files are removed after it");
    }
  } finally {
    try { sleeper.kill(); } catch {}
    rmSync(w.tmp, { recursive: true, force: true });
  }
}
// A stand-in names the old package's src/daemon.js without running it, so no real daemon is involved
// (as installer test 11 does for this package's own daemon).
if (WIN || process.platform === "linux") {
  const w = world();
  const start = Date.now();
  const fake = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(w.oldRoot, "src", "daemon.js")], { stdio: "ignore" });
  try {
    const oldHash = rootHash(realpathSync(w.oldRoot));
    writeFileSync(path.join(w.tmp, `mugshot_daemon_${oldHash}.json`), JSON.stringify({ pid: fake.pid, start,
      startTicks: WIN ? undefined : procStartTicks(fake.pid), version: "0.15.0", window: 3, renewed: start }));
    if (homeIsSandboxed(w)) {
      const out = cli(w, {}, "install");
      const gone = fake.exitCode !== null || fake.signalCode !== null || await Promise.race([
        new Promise((r) => fake.once("exit", () => r(true))),
        new Promise((r) => setTimeout(() => r(false), 3000)),
      ]);
      ok(gone, "the old package's confirmed daemon is stopped before the removal");
      ok(new RegExp(`stopped the old package's render daemon \\(pid ${fake.pid}\\)`).test(out), "the output says so");
    }
  } finally {
    try { fake.kill(); } catch {}
    rmSync(w.tmp, { recursive: true, force: true });
  }
}

// --- Preset paths ------------------------------------------------------------------------------
{
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gamebar-preset-")));
  const own = path.join(tmp, "mine", "presets", "full.toml");
  mkdirSync(path.dirname(own), { recursive: true });
  writeFileSync(own, "");
  const copy = path.join(tmp, "other-copy");
  mkdirSync(path.join(copy, "src", "games", "doom", "presets"), { recursive: true });
  writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: "claude-game-bar" }));
  const copyPreset = path.join(copy, "src", "games", "doom", "presets", "standard.toml");
  writeFileSync(copyPreset, "");
  // The skin replaces a preset setting an installer wrote; a preset of the user's own stays.
  for (const [what, value] of [["this package's", STANDARD], ["another copy's", fwd(copyPreset)],
    ["a missing registered", fwd(path.join(tmp, "gone", "full.toml"))]]) {
    const cfg = { env: { GAMEBAR_PRESET: value } };
    const notes = install(cfg, null, 1, "x");
    ok(!("GAMEBAR_PRESET" in cfg.env) && notes.some((n) => /removed GAMEBAR_PRESET/.test(n)), `install removes ${what} preset`);
  }
  for (const [what, value] of [["an existing preset file of the user's own, even when named full.toml", fwd(own)],
    ["a missing file of the user's own name", fwd(path.join(tmp, "gone", "custom.toml"))]]) {
    const mine = { env: { GAMEBAR_PRESET: value } };
    install(mine, null, 1, "x");
    ok(mine.env.GAMEBAR_PRESET === value, `install keeps ${what}`);
  }
  const cfg = { env: { GAMEBAR_PRESET: STANDARD } };
  install(cfg, "doom-minimal", 1, "x");
  ok(cfg.env.GAMEBAR_SKIN === "doom-minimal" && !("GAMEBAR_PRESET" in cfg.env), "a skin to write becomes GAMEBAR_SKIN");
  const fresh = {};
  install(fresh, null, 1, "x");
  ok(!("GAMEBAR_PRESET" in fresh.env) && !("GAMEBAR_SKIN" in fresh.env), "a fresh install without a skin writes neither");
  uninstall(cfg);
  ok(!cfg.env, "uninstall removes GAMEBAR_SKIN");
  rmSync(tmp, { recursive: true, force: true });
}

// --- Env names ---------------------------------------------------------------------------------
{
  const cfg = { env: { A: "1", DOOMBAR_THEME: "minecraft", MUGSHOT_STATE: "/s", GAMEBAR_GLYPHS: "new", DOOMBAR_GLYPHS: "old", DOOMBAR_STATE: "x" } };
  ok(renameOldEnv(cfg) === 3, "three old names renamed (DOOMBAR_STATE was never a setting)");
  ok(JSON.stringify(cfg.env) === JSON.stringify({ A: "1", GAMEBAR_THEME: "minecraft", GAMEBAR_STATE: "/s", GAMEBAR_GLYPHS: "new", DOOMBAR_STATE: "x" }),
    `old names renamed in place, the new name wins when both are set (${JSON.stringify(cfg.env)})`);
  ok(renameOldEnv(cfg) === 0, "renaming again changes nothing");
}

// --- Marks: which entries are ours ------------------------------------------------------------
{
  const foreign = [
    { hooks: [{ type: "command", command: "node", args: ["/x/doom-tools/hook.js"] }] },
    { hooks: [{ type: "command", command: 'node "/x/src/hook.jsx"' }] },
    { hooks: [{ type: "command", command: "node /x/mysrc/hook.js" }] },
    { hooks: [{ type: "command", command: "doom-notify --hook" }] },
  ];
  const mixed = { hooks: [{ type: "command", command: "node", args: ["C:/Users/u/AppData/Roaming/npm/node_modules/claude-doom-statusbar/src/hook.js"] },
    { type: "command", command: "my-logger" }] };
  const cfg = { statusLine: { type: "command", command: "~/bin/doom-status.sh" }, hooks: { Stop: [...structuredClone(foreign), structuredClone(mixed)] } };
  uninstall(cfg);
  ok(cfg.statusLine?.command === "~/bin/doom-status.sh", "uninstall keeps a foreign statusLine with \"doom\" in it");
  ok(cfg.hooks.Stop.length === 5 && JSON.stringify(cfg.hooks.Stop.slice(0, 4)) === JSON.stringify(foreign),
    "uninstall keeps foreign hooks that contain \"doom\", hook.jsx or another src folder");
  ok(JSON.stringify(cfg.hooks.Stop[4].hooks) === JSON.stringify([{ type: "command", command: "my-logger" }]),
    "uninstall removes the old global package's hook from a group and keeps the user's hook beside it");

  const cfg2 = { hooks: { Stop: [structuredClone(mixed)] } };
  const notes = install(cfg2, null, 1, "x");
  ok(cfg2.hooks.Stop.length === 1 && cfg2.hooks.Stop[0].hooks.length === 2 &&
    cfg2.hooks.Stop[0].hooks[0].args[0] === HOOK && cfg2.hooks.Stop[0].hooks[1].command === "my-logger",
    "install re-points our hook inside a shared group and keeps the other hook");
  ok(notes.some((n) => /re-pointed/.test(n)), "and reports the re-pointing");
}

// --- Uninstall cleans old-prefix files in the runtime directory --------------------------------
{
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gamebar-old-files-")));
  const other = HASH === "ffffffffff" ? "eeeeeeeeee" : "ffffffffff";
  const stamp = (n, age = 0) => {
    const p = path.join(tmp, n);
    writeFileSync(p, "{}");
    const t = (Date.now() - age) / 1000;
    utimesSync(p, t, t);
  };
  const mine = [`mugshot_daemon_${HASH}.json`, `mugshot_daemon_${HASH}.claim`, `mugshot_payload_${HASH}_s1.json`, `mugshot_frame_${HASH}_s1.json`];
  const others = [`mugshot_daemon_${other}.json`, `mugshot_payload_${other}_live.json`];
  mine.forEach((n) => stamp(n));
  others.forEach((n) => stamp(n));
  stamp("mugshot_cold.json", 30 * DAY);
  stamp("mugshot_cold.json.jsonl", 30 * DAY);
  stamp("mugshot_live.json", 1000);
  stamp("mugshot_ratehealth_global.json", 30 * DAY);
  stamp("doombar_faces_0123456789ab.json", 30 * DAY);
  stamp("doombar_faces_ba9876543210.json", 1000);
  execFileSync(process.execPath, [CLI, "uninstall", "--project"], { cwd: tmp, encoding: "utf-8", env: withEnv({ ...sandboxEnv(tmp) }) });
  const left = readdirSync(tmp);
  ok(mine.every((n) => !left.includes(n)), `uninstall removes this installation's old-prefix daemon files (left: ${left.join(", ")})`);
  ok(others.every((n) => left.includes(n)), "another installation's old-prefix files stay");
  ok(!left.includes("mugshot_cold.json") && !left.includes("mugshot_cold.json.jsonl") && !left.includes("doombar_faces_0123456789ab.json"),
    "old-prefix session files and face cache older than the sweep's time to live go");
  ok(left.includes("mugshot_live.json") && left.includes("doombar_faces_ba9876543210.json") && left.includes("mugshot_ratehealth_global.json"),
    "fresh old-prefix files and the shared learned state stay");
  rmSync(tmp, { recursive: true, force: true });
}

// --- Old runtime directories on Linux and macOS: only real directories of this user ------------
{
  const euid = 1000;
  const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
  const lstatAs = (st) => (p) => {
    if (p === "/run/user/1000/doombar") return st;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const opts = (st) => ({ platform: "linux", euid, ownerOf: () => euid, lstat: lstatAs(st), name: "doombar" });
  const dir = { isDirectory: () => true, uid: euid };
  ok(JSON.stringify(privateCandidates(env, opts(dir))) === JSON.stringify(["/run/user/1000/doombar"]), "an old runtime directory of this user is a candidate");
  ok(privateCandidates(env, opts({ isDirectory: () => true, uid: euid + 1 })).length === 0, "one owned by another uid is not");
  ok(privateCandidates(env, opts({ isDirectory: () => false, isSymbolicLink: () => true, uid: euid })).length === 0, "a symlink in its place is not");
}
if (!WIN) {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gamebar-old-dir-")));
  const xdg = path.join(tmp, "xdg");
  const oldDir = path.join(xdg, "doombar");
  // Only the test's own directories pass the check; the machine's real /tmp/doombar-<uid> never does.
  const lstat = (p) => {
    if (!path.resolve(p).startsWith(tmp + path.sep)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return lstatSync(p);
  };
  const run = (extra = {}) => stopDaemon({ hash: HASH, daemonJs: path.join(ROOT, "src", "daemon.js"), env: { XDG_RUNTIME_DIR: xdg }, lstat, ...extra });
  const plant = (dir, names) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); names.forEach((n) => writeFileSync(path.join(dir, n), "x")); };
  const other = HASH === "ffffffffff" ? "eeeeeeeeee" : "ffffffffff";

  plant(oldDir, [`mugshot_daemon_${HASH}.json`, `mugshot_frame_${HASH}_s.json`, `mugshot_daemon_${other}.json`]);
  run();
  ok(existsSync(oldDir) && readdirSync(oldDir).join() === `mugshot_daemon_${other}.json`,
    "an old runtime directory with another installation's daemon file keeps it, and is kept");
  rmSync(oldDir, { recursive: true, force: true });

  plant(oldDir, [`mugshot_daemon_${HASH}.json`, `mugshot_payload_${HASH}_s.json`]);
  run();
  ok(!existsSync(oldDir), "an old runtime directory left empty is removed");

  const target = path.join(tmp, "elsewhere");
  plant(target, [`mugshot_daemon_${HASH}.json`]);
  mkdirSync(xdg, { recursive: true });
  symlinkSync(target, oldDir);
  run();
  ok(existsSync(path.join(target, `mugshot_daemon_${HASH}.json`)), "a symlink in the old directory's place is not followed");
  rmSync(oldDir, { force: true });

  plant(oldDir, [`mugshot_daemon_${HASH}.json`]);
  const foreignOwner = (p) => { const st = lstat(p); return { isDirectory: () => st.isDirectory(), uid: process.geteuid() + 1 }; };
  run({ lstat: foreignOwner });
  ok(existsSync(path.join(oldDir, `mugshot_daemon_${HASH}.json`)), "an old runtime directory owned by another uid is not touched");
  rmSync(tmp, { recursive: true, force: true });
}

// --- After the old package is removed, on Linux and macOS: its runtime directory is cleared -----
if (!WIN) {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gamebar-old-traces-")));
  const xdg = path.join(tmp, "xdg");
  const oldDir = path.join(xdg, "doombar"), newDir = path.join(xdg, "gamebar");
  // Only the test's own directories pass the check; the machine's real /tmp/doombar-<uid> never does.
  const lstat = (p) => {
    if (!path.resolve(p).startsWith(tmp + path.sep)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return lstatSync(p);
  };
  const run = () => removeOldPackageFiles({ hash: HASH, env: { XDG_RUNTIME_DIR: xdg }, lstat });

  mkdirSync(oldDir, { recursive: true, mode: 0o700 });
  const traces = plantTraces(oldDir, { withNew: false });
  const moved = run();
  ok(Object.entries(LEARNED).every(([o, n]) => existsSync(path.join(newDir, n)) && readFileSync(path.join(newDir, n), "utf8") === traces[o]) &&
    readFileSync(path.join(newDir, "savings_s1.json"), "utf8") === traces["savings_s1.json"],
    `the learned state moves to the new runtime directory under the new names (${JSON.stringify(moved)})`);
  ok(!existsSync(oldDir), "the old runtime directory, left empty, is removed");

  mkdirSync(oldDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(newDir, "gamebar_ratehealth_global.json"), "new");
  writeFileSync(path.join(oldDir, "mugshot_ratehealth_global.json"), "old");
  writeFileSync(path.join(oldDir, "gamebar_s9.json"), "mine");
  const target = path.join(tmp, "target.json");
  writeFileSync(target, "kept");
  symlinkSync(target, path.join(oldDir, "mugshot_link.json"));
  run();
  ok(readFileSync(path.join(newDir, "gamebar_ratehealth_global.json"), "utf8") === "new" && !existsSync(path.join(oldDir, "mugshot_ratehealth_global.json")),
    "learned state that exists under the new name already wins, and the old copy goes");
  ok(readFileSync(path.join(oldDir, "gamebar_s9.json"), "utf8") === "mine", "a gamebar_ file in the old directory is not touched");
  ok(lstatSync(path.join(oldDir, "mugshot_link.json")).isSymbolicLink() && readFileSync(target, "utf8") === "kept",
    "a link named with the old prefix is neither removed nor followed");
  ok(existsSync(oldDir), "and the directory that still holds them is kept");
  rmSync(tmp, { recursive: true, force: true });
}

// --- A hook of another package that only looks like ours is never re-pointed or dropped ---------
{
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gamebar-foreign-hook-")));
  const pkg = (dir, name) => {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
    writeFileSync(path.join(dir, "src", "hook.js"), "");
    return fwd(path.join(dir, "src", "hook.js"));
  };
  const otherHook = pkg(path.join(tmp, "other"), "other-tool");
  const oldHook = pkg(path.join(tmp, "old-copy"), "claude-doom-statusbar");
  const exec = (script, extra = {}) => ({ hooks: [{ type: "command", command: "node", args: [script], ...extra }] });
  const shell = (script) => ({ hooks: [{ type: "command", command: `node "${script}"` }] });
  const cfg = { hooks: {
    Stop: [exec(otherHook), shell(otherHook)],
    PreToolUse: [exec(HOOK, { async: true }), exec(otherHook)],
    SubagentStop: [exec(oldHook)],
  } };
  install(cfg, null, 1, "x");
  ok(JSON.stringify(cfg.hooks.Stop.slice(0, 2)) === JSON.stringify([exec(otherHook), shell(otherHook)]) &&
    cfg.hooks.Stop.length === 3 && cfg.hooks.Stop[2].hooks[0].args[0] === HOOK,
    "another package's src/hook.js, in exec or shell form, stays, and this package's hook is added beside it");
  ok(cfg.hooks.PreToolUse.length === 2 && cfg.hooks.PreToolUse[0].hooks[0].args[0] === HOOK &&
    JSON.stringify(cfg.hooks.PreToolUse[1]) === JSON.stringify(exec(otherHook)),
    "another package's hook is not dropped as a duplicate of ours");
  ok(cfg.hooks.SubagentStop.length === 1 && cfg.hooks.SubagentStop[0].hooks[0].args[0] === HOOK,
    "a hook in an existing copy of the old package is re-pointed");
  rmSync(tmp, { recursive: true, force: true });
}

// --- npm on Windows runs as npm-cli.js with this node, or from node's folder -------------------
{
  const exe = "C:\\nodejs\\node.exe", npmCli = "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const direct = npmCommand("win32", exe, (p) => p === npmCli);
  ok(direct.file === exe && direct.pre.length === 1 && direct.pre[0] === npmCli && !direct.shell,
    "Windows: npm-cli.js beside node.exe runs with that node, without a shell");
  const viaShell = npmCommand("win32", exe, () => false);
  ok(viaShell.file === "npm" && viaShell.shell && viaShell.cwd === "C:\\nodejs",
    "Windows without npm-cli.js: npm runs through the shell from node.exe's folder, not the current one");
  const posix = npmCommand("linux", "/usr/bin/node", () => true);
  ok(posix.file === "npm" && posix.pre.length === 0 && !posix.shell, "elsewhere: npm from PATH, without a shell");
}

// --- install --help ---------------------------------------------------------------------------
{
  const out = execFileSync(process.execPath, [CLI, "install", "--help"], { encoding: "utf-8" });
  ok(/--keep-old/.test(out) && /claude-doom-statusbar/.test(out), "install --help describes the takeover and --keep-old");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
