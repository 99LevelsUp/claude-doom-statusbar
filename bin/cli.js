#!/usr/bin/env node
// Wire claude-doom-statusbar into Claude Code, so you never touch settings.json by hand.
// Port of install.py.
//
//   claude-doom-statusbar install              # install into ~/.claude/settings.json
//   claude-doom-statusbar install --preset full # pick a preset (full | standard | minimal)
//   claude-doom-statusbar install --project     # install into ./.claude/settings.json instead
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

function install(cfg, preset) {
  const notes = [];
  const existing = cfg.statusLine;
  if (existing && !hasMark(JSON.stringify(existing), SL_MARKS)) {
    notes.push("replaced your existing statusLine (the old one is in settings.json.bak)");
  }
  cfg.statusLine = { type: "command", command: STATUSLINE_CMD, refreshInterval: 1 };

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
      // statusLine has no exec form, so it stays shell-form below — one sequential spawn per
      // tick, not a concurrent burst.
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
  const out = { cmd: "install", preset: "full", project: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "install" || a === "uninstall") out.cmd = a;
    else if (a === "--uninstall") out.cmd = "uninstall";
    else if (a === "--project") out.project = true;
    else if (a === "--preset") out.preset = argv[++i];
    else if (a.startsWith("--preset=")) out.preset = a.slice("--preset=".length);
    else die(`! unknown argument: ${a}`);
  }
  if (out.cmd === "install" && !out.preset) die("! --preset needs a value (full | standard | minimal)");
  return out;
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
  const notes = install(cfg, args.preset);
  save(p, cfg);

  console.log(`✓ installed claude-doom-statusbar into ${p}`);
  console.log(`  statusline : ${STATUSLINE_CMD}`);
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
