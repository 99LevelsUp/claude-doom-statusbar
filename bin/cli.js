#!/usr/bin/env node
// Wire claude-doom-statusbar into Claude Code, so you never touch settings.json by hand.
// Port of install.py.
//
//   claude-doom-statusbar install              # install into ~/.claude/settings.json
//   claude-doom-statusbar install --preset full # pick a preset (full | standard | minimal)
//   claude-doom-statusbar install --project     # install into ./.claude/settings.json instead
//   claude-doom-statusbar install --refresh 5   # re-render on a 5s timer too (0 = events only)
//   claude-doom-statusbar uninstall             # remove everything this installer added
//
// It merges into your existing settings (other hooks / statusline are preserved or
// backed up), is safe to re-run, and prints what to do next.

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // bin/
const ROOT = path.dirname(HERE); // package root

// Normalise to forward slashes, like install.py's `.replace("\\", "/")`. The marker we
// DETECT below must match the command we WRITE byte-for-byte, including slash direction —
// otherwise a second install double-adds. So everything goes through this one funnel.
const slash = (p) => p.replace(/\\/g, "/");

const STATUSLINE = slash(path.join(ROOT, "src", "statusline.js"));
const HOOK = slash(path.join(ROOT, "src", "hook.js"));
const STATUSLINE_CMD = `node "${STATUSLINE}"`;

// refreshInterval re-runs the render command every N seconds ON TOP of the event-driven updates.
// 1 s is the documented minimum and the default here on every platform: a live clock and a
// responsive HUD are the point of this thing, so the tick is a requirement, not a tunable to be
// traded away for an easier life on Windows.
//
// It IS expensive on Windows, and that cost is handled elsewhere rather than by slowing the tick.
// statusLine has no exec form (its whole schema is type/command/padding/refreshInterval), so
// Claude Code wraps our command in a shell, and on Windows that shell is Git Bash whenever Git
// for Windows is installed — CLAUDE_CODE_GIT_BASH_PATH, CLAUDE_CODE_USE_POWERSHELL_TOOL and
// defaultShell do not redirect it. Git\bin\bash.exe is a stub that re-execs Git\usr\bin\bash.exe,
// so 1 Hz means two MSYS inits per second. Healthy, each costs ~0.15 s and nothing accumulates;
// the danger is that ONE hung init poisons the shared MSYS section ("add_item errno 1"), after
// which every render hangs ~15 s and the pile-up sustains itself forever.
//
// The cure is the reaper (see reapStaleShells in src/hook.js, driven from both the hook and the
// render), which kills hung wrappers and lets the section heal within seconds. That keeps 1 Hz
// survivable. `--refresh=N` still overrides, and `--refresh=0` drops the timer for anyone who
// wants a strictly event-driven HUD.
const DEFAULT_REFRESH = 1;

// Lifecycle events the mugshot hook understands (face reactions, geiger, subagents,
// tasks, permission mode, git snapshots). PreToolUse has no matcher -> fires for every tool.
// SessionStart resets the journal and primes git so the HUD is populated from the first
// render. All entries are installed async (see install()) so they never block a tool.
const HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied",
  "Stop", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted",
];

// How we recognise our own entries — current JS scripts plus legacy Python ones, so a
// user who ran install.py earlier still gets cleaned up by `uninstall`.
const HOOK_MARKS = ["src/hook.js", "mugshot_hook.py"];
const SL_MARKS = ["src/statusline.js", "statusline.py"];
const hasMark = (s, marks) => marks.some((m) => slash(String(s || "")).includes(m));

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function settingsFile(project) {
  const base = project ? path.join(process.cwd(), ".claude") : path.join(os.homedir(), ".claude");
  return path.join(base, "settings.json");
}

function load(p) {
  let text;
  try {
    text = readFileSync(p, "utf-8");
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    die(`! ${p} is not valid JSON (${e.message}); fix or move it, then re-run.`);
  }
}

function save(p, data) {
  mkdirSync(path.dirname(p), { recursive: true });
  if (existsSync(p)) copyFileSync(p, p + ".bak"); // one-level backup before writing
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// Match our entry in either form: shell form keeps the script path in `command`, exec form
// (current) keeps it in `args`. Joining both lets `uninstall` and the idempotency guard find
// installs written by any version.
const ours = (entry) => (entry.hooks || [])
  .some((h) => hasMark([h.command, ...(h.args || [])].join(" "), HOOK_MARKS));

function install(cfg, preset, refresh) {
  const notes = [];
  const existing = cfg.statusLine;
  if (existing && !hasMark(JSON.stringify(existing), SL_MARKS)) {
    notes.push("replaced your existing statusLine (the old one is in settings.json.bak)");
  }
  // Assigning a fresh object (rather than patching) also drops a refreshInterval left behind by
  // an older install — which is the whole point of this change on Windows.
  cfg.statusLine = { type: "command", command: STATUSLINE_CMD };
  if (refresh > 0) cfg.statusLine.refreshInterval = refresh;
  else if (existing?.refreshInterval) {
    notes.push("dropped refreshInterval — the HUD now renders on events only (see --refresh)");
  }

  const env = (cfg.env ??= {});
  const presetFile = preset.endsWith(".toml") ? preset : preset + ".toml";
  env.DOOMBAR_PRESET = slash(path.join(ROOT, "presets", presetFile));
  env.FORCE_HYPERLINK ??= "1"; // clickable links (Windows Terminal needs this)

  const hooks = (cfg.hooks ??= {});
  for (const ev of HOOK_EVENTS) {
    const lst = (hooks[ev] ??= []);
    if (!lst.some(ours)) {
      // idempotent: don't double-add. async:true keeps the hook off the blocking path —
      // it only appends one journal line and returns; statusline folds it at render time.
      // EXEC FORM (command + args): Claude Code spawns node directly, with no shell wrapper.
      // On Windows this avoids the `bash -c "node ..."` launcher, so wiring the hook into many
      // events no longer floods Git Bash's shared MSYS section (the "add_item errno 1" crash).
      // statusLine has no exec form and cannot be moved off the shell, so instead we stop
      // driving it on a timer (see DEFAULT_REFRESH) and let the hook reap the wrappers Claude
      // Code leaks when one hangs (see reapStaleShells in src/hook.js).
      lst.push({ hooks: [{ type: "command", command: "node", args: [HOOK], async: true }] });
    }
  }
  return notes;
}

function uninstall(cfg) {
  if (hasMark(cfg.statusLine?.command, SL_MARKS)) delete cfg.statusLine;

  const env = cfg.env || {};
  for (const k of ["DOOMBAR_PRESET", "FORCE_HYPERLINK"]) delete env[k];
  if (Object.keys(env).length === 0) delete cfg.env;

  const hooks = cfg.hooks || {};
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = hooks[ev].filter((e) => !ours(e));
    if (hooks[ev].length === 0) delete hooks[ev];
  }
  if (Object.keys(hooks).length === 0) delete cfg.hooks;
}

function parseArgs(argv) {
  const out = { cmd: "install", preset: "full", project: false, refresh: DEFAULT_REFRESH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "install" || a === "uninstall") out.cmd = a;
    else if (a === "--uninstall") out.cmd = "uninstall";
    else if (a === "--project") out.project = true;
    else if (a === "--preset") out.preset = argv[++i];
    else if (a.startsWith("--preset=")) out.preset = a.slice("--preset=".length);
    else if (a === "--refresh") out.refresh = refreshValue(argv[++i]);
    else if (a.startsWith("--refresh=")) out.refresh = refreshValue(a.slice("--refresh=".length));
    else die(`! unknown argument: ${a}`);
  }
  if (out.cmd === "install" && !out.preset) die("! --preset needs a value (full | standard | minimal)");
  return out;
}

// Claude Code's documented minimum is 1 s; 0 is our own "no timer at all" (the key is omitted).
function refreshValue(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) die("! --refresh needs a whole number of seconds (0 = off)");
  return n;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const p = settingsFile(args.project);
  const cfg = load(p);

  if (args.cmd === "uninstall") {
    uninstall(cfg);
    save(p, cfg);
    console.log(`✓ removed claude-doom-statusbar from ${p}`);
    console.log("  restart Claude Code to apply.");
    return;
  }

  if (!existsSync(fileURLToPath(new URL("../src/statusline.js", import.meta.url)))) {
    die(`! can't find ${STATUSLINE} — reinstall the package.`);
  }
  const notes = install(cfg, args.preset, args.refresh);
  save(p, cfg);

  console.log(`✓ installed claude-doom-statusbar into ${p}`);
  console.log(`  statusline : ${STATUSLINE_CMD}`);
  console.log(`  refresh    : ${args.refresh > 0 ? `every ${args.refresh}s + events` : "events only"}`);
  console.log(`  preset     : ${args.preset}`);
  console.log(`  hooks      : ${HOOK_EVENTS.join(", ")}`);
  for (const n of notes) console.log(`  note       : ${n}`);
  console.log();
  console.log("Next:");
  console.log("  1. (optional) install chafa for a sharper mugshot; without it a pre-rendered face is used.");
  console.log("  2. restart Claude Code.");
  console.log("  Clickable links need FORCE_HYPERLINK=1 (set for you here; on Windows Terminal you may");
  console.log("  also need to launch with it:  $env:FORCE_HYPERLINK='1'; claude ).");
}

main();
