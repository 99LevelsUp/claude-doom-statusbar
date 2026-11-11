#!/usr/bin/env node
// Wire claude-doom-statusbar into Claude Code, so you never touch settings.json by hand.
// Port of install.py.
//
//   claude-doom-statusbar install              # install into ~/.claude/settings.json
//   claude-doom-statusbar install --preset full # pick a preset (full | standard | minimal)
//   claude-doom-statusbar install --project     # install into ./.claude/settings.json instead
//   claude-doom-statusbar install --refresh 0   # events only; default is a 1s timer + events
//   claude-doom-statusbar uninstall             # remove everything this installer added
//   claude-doom-statusbar theme minecraft       # switch game theme: doom | minecraft
//   claude-doom-statusbar theme next            # cycle to the next theme
//   claude-doom-statusbar theme                 # list themes, show the current one
//   claude-doom-statusbar test-card             # show which glyphs this terminal draws
//
// It merges into your existing settings (other hooks / statusline are preserved or
// backed up), is safe to re-run, and prints what to do next.

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES, THEME_NAMES, currentTheme, saveTheme, nextTheme, resolveTheme } from "../src/theme.js";
import { rootHash, daemonPaths, daemonPrefix, payloadPrefix, framePrefix } from "../src/fold.js";
import { confirmedDaemonPid } from "../src/hook.js";
import { STEPS, testCardLines } from "../src/glyphs.js";
import { convertImage } from "../src/glyph-render.js";
import { terminalStep } from "../src/glyph-level.js";
import { decodePng } from "../src/png.js";
import { sgrFg, sgrBg } from "../src/ansi.js";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // bin/
const ROOT = path.dirname(HERE); // package root
const HASH = rootHash(ROOT); // this installation's daemon, pipe and temp files

// Normalise to forward slashes, like install.py's `.replace("\\", "/")`. The marker we
// DETECT below must match the command we WRITE byte-for-byte, including slash direction —
// otherwise a second install double-adds. So everything goes through this one funnel.
const slash = (p) => p.replace(/\\/g, "/");

const STATUSLINE = slash(path.join(ROOT, "src", "statusline.js"));
const CLIENT = slash(path.join(ROOT, "src", "doombar-client.sh"));
const HOOK = slash(path.join(ROOT, "src", "hook.js"));
const NODE_CMD = `node "${STATUSLINE}"`;

// On Windows with Git Bash, Claude Code runs the statusLine through Git Bash, and the command
// sources the bash client into that very bash: no second bash, no node, no process at all. The
// client prints the frame the render daemon prepared (see src/doombar-client.sh, src/daemon.js).
// It lives in the package, so an upgrade in the same place reaches it without touching
// settings.json; the guard keeps a removed package from printing bash errors into the bar.
// `if` rather than `[ ] && . || echo`: the client may end with a non-zero status after printing
// a frame, and `||` would then add the offline line under it.
// Everywhere else (macOS ships bash 3.2; without Git Bash Claude Code uses PowerShell) the
// one-shot renderer stays.
const CLIENT_CMD = `DOOMBAR_ROOT_HASH=${HASH}; f="${CLIENT}"; ` +
  `if [ -r "$f" ]; then . "$f"; else echo 'doombar: offline'; fi`;

// The bash Claude Code would run the statusLine with. It finds Git Bash on its own, not through
// PATH (whose bash.exe may well be WSL's): an explicit CLAUDE_CODE_GIT_BASH_PATH, the standard
// Git for Windows locations, then the install around a git.exe on PATH. Existence checks only.
function gitBash(env = process.env) {
  if (process.platform !== "win32") return null;
  const bin = (root) => path.join(root, "bin", "bash.exe");
  const cands = [env.CLAUDE_CODE_GIT_BASH_PATH];
  for (const pf of [env.ProgramFiles, env["ProgramFiles(x86)"]]) if (pf) cands.push(bin(path.join(pf, "Git")));
  if (env.LOCALAPPDATA) cands.push(bin(path.join(env.LOCALAPPDATA, "Programs", "Git")));
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const git = path.join(dir.replace(/^"|"$/g, ""), "git.exe");
    if (!existsSync(git)) continue;
    // <git>\cmd\git.exe or <git>\bin\git.exe, and <git>\mingw64\bin\git.exe one level deeper.
    // No early stop: a git.exe that is not Git for Windows (a scoop shim) must not hide a later one.
    cands.push(bin(path.dirname(path.dirname(git))), bin(path.dirname(path.dirname(path.dirname(git)))));
  }
  return cands.find((p) => p && existsSync(p)) ?? null;
}

const useClient = () => gitBash() !== null;

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
  "Stop", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "SessionEnd",
];

// How we recognise our own entries — current JS scripts plus legacy Python ones, so a
// user who ran install.py earlier still gets cleaned up by `uninstall`.
const HOOK_MARKS = ["src/hook.js", "mugshot_hook.py"];
const SL_MARKS = ["src/doombar-client.sh", "src/statusline.js", "statusline.py"];
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

function install(cfg, preset, refresh, command) {
  const notes = [];
  const existing = cfg.statusLine;
  if (existing && !hasMark(JSON.stringify(existing), SL_MARKS)) {
    notes.push("replaced your existing statusLine (the old one is in settings.json.bak)");
  }
  // Assigning a fresh object (rather than patching) also drops a refreshInterval left behind by
  // an older install — which is the whole point of this change on Windows.
  cfg.statusLine = { type: "command", command };
  if (refresh > 0) cfg.statusLine.refreshInterval = refresh;
  else if (existing?.refreshInterval) {
    notes.push("dropped refreshInterval — the HUD now renders on events only (see --refresh)");
  }

  const env = (cfg.env ??= {});
  const presetFile = preset.endsWith(".toml") ? preset : preset + ".toml";
  env.DOOMBAR_PRESET = slash(path.join(ROOT, "presets", presetFile));
  env.FORCE_HYPERLINK ??= "1"; // clickable links (Windows Terminal needs this)

  const hooks = (cfg.hooks ??= {});
  let repointed = 0;
  for (const ev of HOOK_EVENTS) {
    const lst = (hooks[ev] ??= []);
    // async:true keeps the hook off the blocking path — it only appends one journal line and
    // returns; statusline folds it at render time.
    // EXEC FORM (command + args): Claude Code spawns node directly, with no shell wrapper.
    // On Windows this avoids the `bash -c "node ..."` launcher, so wiring the hook into many
    // events no longer floods Git Bash's shared MSYS section (the "add_item errno 1" crash).
    // statusLine has no exec form and cannot be moved off the shell, so the flood from ABOVE
    // is handled by the hook's reaper instead (see reapStaleShells in src/hook.js).
    // SessionEnd is the exception: it deletes the session's scratch files as Claude Code exits,
    // and an async hook can be cut off by that exit. It only unlinks a few files, so running
    // it synchronously costs nothing noticeable.
    const entry = { type: "command", command: "node", args: [HOOK] };
    if (ev !== "SessionEnd") entry.async = true;
    const desired = { hooks: [entry] };
    const at = lst.findIndex(ours);
    if (at === -1) { lst.push(desired); continue; }
    // Idempotent, but NOT blindly: an entry of ours that points at a different path is stale —
    // an upgrade that moved the package (a fresh npx cache dir, npx -> global install) or an
    // install written in the old shell form. Skipping it used to leave the statusLine upgraded
    // (it is replaced unconditionally) while the hook still ran the previous version's code, so
    // a fix shipped in the hook silently never took effect. Re-point it instead.
    if (!lst[at].hooks?.some((h) => h.command === "node" && (h.args || []).includes(HOOK))) {
      lst[at] = desired;
      repointed++;
    }
  }
  if (repointed) {
    notes.push(`re-pointed ${repointed} hook event(s) from a previous install's path`);
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

// Stop this installation's render daemon and delete its temp files: heartbeat, claim (and the
// claim's lock and temp copies), and every session's payload and frame. Only this install's hash,
// so another installation's daemon (a global copy next to a checkout) is never touched. A pid is
// stopped only when the process list confirms it is node running this package's src/daemon.js,
// started when the heartbeat says; a stale heartbeat may name a pid reused by anything.
// The kill comes first, or the daemon would rewrite its files on its next pass.
function stopDaemon() {
  const notes = [];
  const { heartbeat } = daemonPaths(HASH);
  let hb = null;
  try { hb = JSON.parse(readFileSync(heartbeat, "utf-8")); } catch {}
  if (process.platform === "win32" && hb && Number.isInteger(hb.pid) && hb.pid > 0) {
    const pid = confirmedDaemonPid(hb);
    if (pid !== null) {
      try { process.kill(pid); notes.push(`stopped the render daemon (pid ${pid})`); } catch {}
    } else {
      notes.push(`left pid ${hb.pid} running: not confirmed as this installation's render daemon`);
    }
  }
  const dir = os.tmpdir();
  const prefixes = [daemonPrefix(HASH), payloadPrefix(HASH), framePrefix(HASH)];
  let removed = 0;
  let names = [];
  try { names = readdirSync(dir); } catch {}
  for (const n of names) {
    if (!prefixes.some((p) => n.startsWith(p))) continue;
    try { unlinkSync(path.join(dir, n)); removed++; } catch {}
  }
  if (removed) notes.push(`removed ${removed} render daemon file(s) from ${dir}`);
  return notes;
}

function parseArgs(argv) {
  const out = { cmd: "install", preset: "full", project: false, refresh: DEFAULT_REFRESH, theme: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "install" || a === "uninstall") out.cmd = a;
    else if (a === "theme" || a === "themes") { out.cmd = "theme"; out.theme = argv[++i] ?? null; }
    else if (a === "test-card") out.cmd = "test-card";
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

// `theme` with no name lists the themes; with a name (or "next") switches. The statusline
// re-reads the choice on every render, so it takes effect on the next refresh.
function theme(name) {
  const cur = currentTheme();
  if (!name) {
    console.log("themes:");
    for (const t of THEME_NAMES) console.log(`  ${t === cur ? "▶" : " "} ${t.padEnd(13)} ${THEMES[t].about}`);
    console.log("\nswitch with:  claude-doom-statusbar theme <name>   (or: theme next)");
    return;
  }
  const want = name === "next" ? nextTheme(cur) : resolveTheme(name.toLowerCase());
  if (!want) die(`! unknown theme: ${name} (pick one of: ${THEME_NAMES.join(", ")}, next)`);
  saveTheme(want);
  console.log(`✓ theme: ${want} — ${THEMES[want].about}`);
  console.log("  the status bar switches on its next refresh (no restart needed).");
  if (process.env.DOOMBAR_THEME && process.env.DOOMBAR_THEME !== want) {
    console.log(`  note: DOOMBAR_THEME=${process.env.DOOMBAR_THEME} is set in this environment and overrides the saved theme.`);
  }
}

// The glyph test card, then one mugshot drawn at every step side by side, so the steps this
// terminal draws correctly can be judged by eye.
function testCard() {
  console.log("Glyph test card: each step below should show clean block shapes, no boxes, question");
  console.log("marks or gaps. The last step that looks right is the richest one this terminal can draw.\n");
  for (const line of testCardLines()) console.log(line);
  const img = decodePng(readFileSync(path.join(ROOT, "assets", "images", "mugshot", "alpha", "STFST01.png")));
  const ROWS = 8;
  const faces = STEPS.map((step) => convertImage(img, ROWS, step));
  const width = Math.max(...faces.flatMap((f) => f.map((r) => r.length)));
  const cell = ([ch, fg, bg]) => sgrFg(fg || [0, 0, 0]) + sgrBg(bg || [0, 0, 0]) + ch;
  console.log("\nThe mugshot at each step:");
  console.log("  " + STEPS.map((s) => s.padEnd(width + 2)).join(""));
  for (let r = 0; r < ROWS; r++) {
    const parts = faces.map((f) => (f[r] || []).map(cell).join("") + "\x1b[0m" + " ".repeat(width + 2 - (f[r] || []).length));
    console.log("  " + parts.join(""));
  }
  console.log(`\nThis terminal gets the "${terminalStep(process.env)}" step.`);
  console.log(`To choose another, set DOOMBAR_GLYPHS to one of: ${STEPS.join(", ")} (in the env block of settings.json).`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === "theme") return theme(args.theme);
  if (args.cmd === "test-card") return testCard();
  const p = settingsFile(args.project);
  const cfg = load(p);

  if (args.cmd === "uninstall") {
    uninstall(cfg);
    save(p, cfg);
    if (!args.project) saveTheme("doom"); // drop the saved theme choice too
    const notes = stopDaemon();
    console.log(`✓ removed claude-doom-statusbar from ${p}`);
    for (const n of notes) console.log(`  note       : ${n}`);
    console.log("  restart Claude Code to apply.");
    return;
  }

  const client = useClient();
  const script = client ? CLIENT : STATUSLINE;
  if (!existsSync(script)) die(`! can't find ${script} — reinstall the package.`);
  const command = client ? CLIENT_CMD : NODE_CMD;
  const notes = install(cfg, args.preset, args.refresh, command);
  save(p, cfg);

  console.log(`✓ installed claude-doom-statusbar into ${p}`);
  console.log(`  statusline : ${command}`);
  if (client) console.log("  renderer   : per-installation render daemon, started by the hooks");
  console.log(`  refresh    : ${args.refresh > 0 ? `every ${args.refresh}s + events` : "events only"}`);
  console.log(`  preset     : ${args.preset}`);
  console.log(`  hooks      : ${HOOK_EVENTS.join(", ")}`);
  for (const n of notes) console.log(`  note       : ${n}`);
  console.log();
  console.log("Next:");
  console.log("  1. restart Claude Code.");
  console.log("  2. (optional) run `claude-doom-statusbar test-card` to see which glyphs this terminal draws.");
  console.log("  Clickable links need FORCE_HYPERLINK=1 (set for you here; on Windows Terminal you may");
  console.log("  also need to launch with it:  $env:FORCE_HYPERLINK='1'; claude ).");
}

main();
