#!/usr/bin/env node
// Wire claude-doom-statusbar into Claude Code, so you never touch settings.json by hand.
// Port of install.py.
//
//   claude-doom-statusbar install              # install into ~/.claude/settings.json
//   claude-doom-statusbar install --preset full # pick a preset (full | standard | minimal)
//   claude-doom-statusbar install --project     # install into ./.claude/settings.json instead
//   claude-doom-statusbar install --local       # install into ./.claude/settings.local.json instead
//   claude-doom-statusbar install --refresh 0   # events only; default is a 1s timer + events
//   claude-doom-statusbar install --no-fonts    # don't check for / install an emoji font (Linux)
//   claude-doom-statusbar uninstall             # remove everything this installer added
//   claude-doom-statusbar theme minecraft       # switch game theme: doom | minecraft
//   claude-doom-statusbar theme next            # cycle to the next theme
//   claude-doom-statusbar theme                 # list themes, show the current one
//   claude-doom-statusbar test-card             # show which glyphs this terminal draws
//
// It merges into your existing settings (other hooks / statusline are preserved or
// backed up), is safe to re-run, and prints what to do next.

import { readFileSync, existsSync, readdirSync, unlinkSync, lstatSync, rmdirSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../src/package-root.js";
import { THEMES, THEME_NAMES, currentTheme, saveTheme, clearTheme, nextTheme, resolveTheme } from "../src/theme.js";
import { rootHash, daemonPrefix, payloadPrefix, framePrefix, runtimeDir } from "../src/platform/runtime.js";
import { confirmedDaemonPid } from "../src/platform/supervise.js";
import { HOOK_EVENTS, die, settingsFile, load, save, install, uninstall } from "../src/install/settings.js";
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

// Stop this installation's render daemon and delete its temp files: heartbeat, claim (and the
// claim's lock and temp copies), and every session's payload and frame. Only this install's hash,
// so another installation's daemon (a global copy next to a checkout) is never touched. A pid is
// stopped only when the process list confirms it is node running this package's src/daemon.js,
// started when the heartbeat says; a stale heartbeat may name a pid reused by anything.
// The kill comes first, or the daemon would rewrite its files on its next pass.
//
// Where to look: the runtime directory. On Linux and macOS the shell running uninstall may see
// another XDG_RUNTIME_DIR than Claude Code did (tmux, ssh), so every candidate directory is
// tried, each only when it is a real directory of this user. With DOOMBAR_RUNTIME_DIR set, only
// that one, so a test never reaches the live bar.
function runtimeCandidates(env = process.env) {
  if (env.DOOMBAR_RUNTIME_DIR || process.platform === "win32") return [runtimeDir(env)];
  const dirs = new Set([runtimeDir(env)]);
  if (String(env.XDG_RUNTIME_DIR || "").startsWith("/")) dirs.add(path.posix.join(env.XDG_RUNTIME_DIR, "doombar"));
  if (process.platform === "darwin" && String(env.TMPDIR || "").startsWith("/")) dirs.add(path.posix.join(env.TMPDIR, "doombar"));
  dirs.add(`/tmp/doombar-${process.geteuid()}`);
  return [...dirs];
}

// SIGTERM lets the daemon close its socket and drop its heartbeat; it exits on its own within 2 s
// (STOP_WAIT_MS leaves room). One still running then is killed. True when the pid is gone.
const STOP_WAIT_MS = 3000;
// A zombie (exited, not yet reaped by its parent) still answers kill(pid, 0) but is gone.
function pidAlive(pid) {
  try { process.kill(pid, 0); } catch (e) { return e.code === "EPERM"; }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch { return false; }
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function stopPid(pid) {
  try { process.kill(pid); } catch { return !pidAlive(pid); }
  for (let waited = 0; pidAlive(pid) && waited < STOP_WAIT_MS; waited += 50) sleepSync(50);
  if (pidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    for (let waited = 0; pidAlive(pid) && waited < 1000; waited += 50) sleepSync(50);
  }
  return !pidAlive(pid);
}

function stopDaemon() {
  const notes = [];
  const posix = process.platform !== "win32";
  const prefixes = [daemonPrefix(HASH), payloadPrefix(HASH), framePrefix(HASH)];
  for (const dir of runtimeCandidates()) {
    if (posix) {
      try {
        const st = lstatSync(dir);
        if (!st.isDirectory() || st.uid !== process.geteuid()) continue;
      } catch { continue; }
    }
    let hb = null;
    try { hb = JSON.parse(readFileSync(path.join(dir, `${daemonPrefix(HASH)}json`), "utf-8")); } catch {}
    if (hb && Number.isInteger(hb.pid) && hb.pid > 0) {
      const pid = confirmedDaemonPid(hb);
      if (pid !== null) {
        notes.push(stopPid(pid) ? `stopped the render daemon (pid ${pid})`
          : `could not stop the render daemon (pid ${pid}); its files are removed, and it exits after its idle time`);
      } else {
        notes.push(`left pid ${hb.pid} running: not confirmed as this installation's render daemon`);
      }
    }
    let removed = 0;
    let names = [];
    try { names = readdirSync(dir); } catch {}
    for (const n of names) {
      if (!prefixes.some((p) => n.startsWith(p))) continue;
      try { unlinkSync(path.join(dir, n)); removed++; } catch {}
    }
    if (removed) notes.push(`removed ${removed} render daemon file(s) from ${dir}`);
    if (posix && !process.env.DOOMBAR_RUNTIME_DIR) { try { rmdirSync(dir); } catch { /* not empty: other files */ } }
  }
  return notes;
}

function parseArgs(argv) {
  const out = { cmd: "install", preset: "full", project: false, local: false, refresh: DEFAULT_REFRESH, theme: null, fonts: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "install" || a === "uninstall") out.cmd = a;
    else if (a === "theme" || a === "themes") { out.cmd = "theme"; out.theme = argv[++i] ?? null; }
    else if (a === "test-card") out.cmd = "test-card";
    else if (a === "--uninstall") out.cmd = "uninstall";
    else if (a === "--project") out.project = true;
    else if (a === "--local") out.local = true;
    else if (a === "--no-fonts") out.fonts = false;
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
  console.log(`To choose another, set DOOMBAR_GLYPHS to one of: ${STEPS.join(", ")} (in the env block of settings.json).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === "theme") return theme(args.theme);
  if (args.cmd === "test-card") return testCard();
  const p = settingsFile(args.project, args.local);
  const cfg = load(p);

  if (args.cmd === "uninstall") {
    uninstall(cfg);
    save(p, cfg);
    if (!args.project && !args.local) clearTheme(); // drop the saved theme choice too
    const notes = stopDaemon();
    console.log(`✓ removed claude-doom-statusbar from ${p}`);
    for (const n of notes) console.log(`  note       : ${n}`);
    console.log("  restart Claude Code to apply.");
    return;
  }

  const clientCmd = clientCommand();
  const script = clientCmd ? CLIENT : STATUSLINE;
  if (!existsSync(script)) die(`! can't find ${script} — reinstall the package.`);
  const command = clientCmd || NODE_CMD;
  const notes = install(cfg, args.preset, args.refresh, command);
  save(p, cfg);

  console.log(`✓ installed claude-doom-statusbar into ${p}`);
  console.log(`  statusline : ${command}`);
  if (clientCmd) console.log("  renderer   : per-installation render daemon, started by the hooks");
  if (process.platform !== "win32") console.log(`  files      : ${runtimeDir()} (private to this user)`);
  console.log(`  refresh    : ${args.refresh > 0 ? `every ${args.refresh}s + events` : "events only"}`);
  console.log(`  preset     : ${args.preset}`);
  console.log(`  hooks      : ${HOOK_EVENTS.join(", ")}`);
  for (const n of notes) console.log(`  note       : ${n}`);
  // Linux only: a desktop without a colour emoji font shows boxes in place of the bar's emoji.
  const font = await ensureEmojiFont({ skip: !args.fonts });
  for (const n of font.notes) console.log(n.startsWith("emoji font :") ? `  ${n}` : `  note       : ${n}`);
  console.log();
  console.log("Next:");
  console.log(font.status === "installed"
    ? "  1. restart your terminal (for the new emoji font), then Claude Code."
    : "  1. restart Claude Code.");
  console.log("  2. (optional) run `claude-doom-statusbar test-card` to see which glyphs this terminal draws.");
  console.log("  Clickable links need FORCE_HYPERLINK=1 (set for you here; on Windows Terminal you may");
  console.log("  also need to launch with it:  $env:FORCE_HYPERLINK='1'; claude ).");
}

await main();
