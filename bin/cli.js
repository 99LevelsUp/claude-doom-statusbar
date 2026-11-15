#!/usr/bin/env node
// Wire claude-game-bar into Claude Code, so you never touch settings.json by hand.
// Port of install.py.
//
//   claude-game-bar install              # install into ~/.claude/settings.json
//   claude-game-bar install --preset full # pick a preset (full | standard | minimal)
//   claude-game-bar install --project     # install into ./.claude/settings.json instead
//   claude-game-bar install --local       # install into ./.claude/settings.local.json instead
//   claude-game-bar install --refresh 0   # events only; default is a 1s timer + events
//   claude-game-bar install --no-fonts    # don't check for / install an emoji font (Linux)
//   claude-game-bar install --keep-old    # leave a global claude-doom-statusbar installed
//   claude-game-bar install --help        # the install options
//   claude-game-bar uninstall             # remove everything this installer added
//   claude-game-bar theme minecraft       # switch game theme: doom | minecraft
//   claude-game-bar theme next            # cycle to the next theme
//   claude-game-bar theme                 # list themes, show the current one
//   claude-game-bar test-card             # show which glyphs this terminal draws
//
// It merges into your existing settings (other hooks / statusline are preserved or
// backed up), is safe to re-run, and prints what to do next. It also takes over an installation
// of claude-doom-statusbar, the package this one replaces: its entries are re-pointed here, its
// DOOMBAR_ settings renamed, its saved theme kept, and the global package removed.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT, SRC_DIR } from "../src/package-root.js";
import {
  THEMES, THEME_NAMES, currentTheme, saveTheme, clearTheme, nextTheme, resolveTheme, migrateTheme, themeFile, removeOldThemeFile,
} from "../src/theme.js";
import { rootHash, runtimeDir } from "../src/platform/runtime.js";
import { envGet, newName, oldName } from "../src/platform/env.js";
import { HOOK_EVENTS, die, settingsFile, load, save, install, uninstall } from "../src/install/settings.js";
import { stopDaemon } from "../src/install/daemons.js";
import { removeOldPackage, OLD_PACKAGE } from "../src/install/old-package.js";
import { STATUSLINE, CLIENT, NODE_CMD, clientCommand } from "../src/install/shell.js";
import { STEPS, testCardLines } from "../src/kit/raster/glyphs.js";
import { convertImage } from "../src/kit/raster/glyph-render.js";
import { terminalStep } from "../src/kit/raster/glyph-level.js";
import { decodePng } from "../src/kit/raster/png.js";
import { sgrFg, sgrBg } from "../src/kit/ansi.js";
import { ensureEmojiFont } from "../src/install/emoji-font.js";
import { sampleImage } from "../src/games/index.js";

const HASH = rootHash(PACKAGE_ROOT); // this installation's daemon and its files

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
// The cure is the reaper (see reapStaleShells in src/platform/reap.js, driven from both the hook and the
// render), which kills hung wrappers and lets the section heal within seconds. That keeps 1 Hz
// survivable. `--refresh=N` still overrides, and `--refresh=0` drops the timer for anyone who
// wants a strictly event-driven HUD.
const DEFAULT_REFRESH = 1;

const INSTALL_HELP = `usage: claude-game-bar install [options]

Wires the bar into Claude Code's settings. Safe to re-run. It also takes over an installation of
claude-doom-statusbar, the package this one replaces: its entries point here afterwards, its
DOOMBAR_ settings are renamed to GAMEBAR_, its saved theme is kept, and the global
claude-doom-statusbar package is removed with npm.

options:
  --preset <name>  full | standard | minimal (default: keep the current one, else full)
  --project        install into ./.claude/settings.json instead of ~/.claude/settings.json
  --local          install into ./.claude/settings.local.json instead
  --refresh <s>    redraw every <s> seconds as well as on events (default 1; 0 = events only)
  --no-fonts       do not check for or install an emoji font (Linux)
  --keep-old       leave a global claude-doom-statusbar installed

The old package is removed only by an install into ~/.claude/settings.json, the settings it was
wired into. If npm cannot remove it, the install still succeeds and prints the command to run.`;

function parseArgs(argv) {
  const out = { cmd: "install", preset: null, project: false, local: false, refresh: DEFAULT_REFRESH, theme: null,
    fonts: true, keepOld: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "install" || a === "uninstall") out.cmd = a;
    else if (a === "theme" || a === "themes") { out.cmd = "theme"; out.theme = argv[++i] ?? null; }
    else if (a === "test-card") out.cmd = "test-card";
    else if (a === "--uninstall") out.cmd = "uninstall";
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--project") out.project = true;
    else if (a === "--local") out.local = true;
    else if (a === "--keep-old") out.keepOld = true;
    else if (a === "--no-fonts") out.fonts = false;
    else if (a === "--preset") out.preset = argv[++i];
    else if (a.startsWith("--preset=")) out.preset = a.slice("--preset=".length);
    else if (a === "--refresh") out.refresh = refreshValue(argv[++i]);
    else if (a.startsWith("--refresh=")) out.refresh = refreshValue(a.slice("--refresh=".length));
    else die(`! unknown argument: ${a}`);
  }
  if (out.cmd === "install" && out.preset !== null && !out.preset) die("! --preset needs a value (full | standard | minimal)");
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
    console.log("\nswitch with:  claude-game-bar theme <name>   (or: theme next)");
    return;
  }
  const want = name === "next" ? nextTheme(cur) : resolveTheme(name.toLowerCase());
  if (!want) die(`! unknown theme: ${name} (pick one of: ${THEME_NAMES.join(", ")}, next)`);
  saveTheme(want);
  console.log(`✓ theme: ${want} — ${THEMES[want].about}`);
  console.log("  the status bar switches on its next refresh (no restart needed).");
  const forced = envGet("THEME");
  if (forced && forced !== want) {
    const setAs = process.env[newName("THEME")] !== undefined ? newName("THEME") : oldName("THEME");
    console.log(`  note: ${setAs}=${forced} is set in this environment and overrides the saved theme.`);
  }
}

// The glyph test card, then one face drawn at every step side by side, so the steps this terminal
// draws correctly can be judged by eye. The face is the sample image of the first registered game
// that has one (src/games/index.js).
function testCard() {
  console.log("Glyph test card: each step below should show clean block shapes, no boxes, question");
  console.log("marks or gaps. The last step that looks right is the richest one this terminal can draw.\n");
  for (const line of testCardLines()) console.log(line);
  const sample = sampleImage();
  if (sample) {
    const img = decodePng(readFileSync(sample));
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
  }
  console.log(`\nThis terminal gets the "${terminalStep(process.env)}" step.`);
  console.log(`To choose another, set GAMEBAR_GLYPHS to one of: ${STEPS.join(", ")} (in the env block of settings.json).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(INSTALL_HELP); return; }
  if (args.cmd === "theme") return theme(args.theme);
  if (args.cmd === "test-card") return testCard();
  const p = settingsFile(args.project, args.local);
  const cfg = load(p);

  if (args.cmd === "uninstall") {
    uninstall(cfg);
    save(p, cfg);
    if (!args.project && !args.local) { clearTheme(); removeOldThemeFile(); } // drop the saved theme choice too
    const notes = stopDaemon({ hash: HASH, daemonJs: path.join(SRC_DIR, "daemon.js") });
    console.log(`✓ removed claude-game-bar from ${p}`);
    for (const n of notes) console.log(`  note       : ${n}`);
    console.log("  restart Claude Code to apply.");
    return;
  }

  const clientCmd = clientCommand();
  const script = clientCmd ? CLIENT : STATUSLINE;
  if (!existsSync(script)) die(`! can't find ${script} — reinstall the package.`);
  const command = clientCmd || NODE_CMD;
  const notes = install(cfg, args.preset, args.refresh, command);
  save(p, cfg, { firstBackup: notes.migrated });

  // Taking over an installation of the old package: only from the user settings, the ones its
  // global install was wired into. A project or local install leaves them as they are, so the old
  // package may still be in use there, and it stays, with its saved theme. Once npm has removed the
  // old package, its theme file goes too: its choice is in the new file by then.
  let old = { line: null, notes: [], removed: false };
  if (!args.project && !args.local) {
    if (!args.keepOld) {
      const moved = migrateTheme();
      if (moved) notes.push(`kept the saved theme (${moved}), now in ${themeFile()}`);
    }
    old = removeOldPackage({ keepOld: args.keepOld });
    if (old.removed) removeOldThemeFile();
  }

  const preset = cfg.env[newName("PRESET")];
  console.log(`✓ installed claude-game-bar into ${p}`);
  console.log(`  statusline : ${command}`);
  if (clientCmd) console.log("  renderer   : per-installation render daemon, started by the hooks");
  if (process.platform !== "win32") console.log(`  files      : ${runtimeDir()} (private to this user)`);
  console.log(`  refresh    : ${args.refresh > 0 ? `every ${args.refresh}s + events` : "events only"}`);
  console.log(`  preset     : ${args.preset || preset}`);
  console.log(`  hooks      : ${HOOK_EVENTS.join(", ")}`);
  for (const n of [...notes, ...old.notes]) console.log(`  note       : ${n}`);
  if (old.line) console.log(`  old package: ${old.line}`);
  // Settings of a project the old package was wired into (its `install --project` or `--local`)
  // are out of the installer's sight.
  if (old.removed) {
    console.log(`  note       : a repository wired with \`${OLD_PACKAGE} install --project\` or \`--local\` needs ` +
      "`claude-game-bar install --project` (or `--local`) run in it again");
  }
  // Linux only: a desktop without a colour emoji font shows boxes in place of the bar's emoji.
  const font = await ensureEmojiFont({ skip: !args.fonts });
  for (const n of font.notes) console.log(n.startsWith("emoji font :") ? `  ${n}` : `  note       : ${n}`);
  console.log();
  console.log("Next:");
  console.log(font.status === "installed"
    ? "  1. restart your terminal (for the new emoji font), then Claude Code."
    : "  1. restart Claude Code.");
  console.log("  2. (optional) run `claude-game-bar test-card` to see which glyphs this terminal draws.");
  console.log("  Clickable links need FORCE_HYPERLINK=1 (set for you here; on Windows Terminal you may");
  console.log("  also need to launch with it:  $env:FORCE_HYPERLINK='1'; claude ).");
}

await main();
