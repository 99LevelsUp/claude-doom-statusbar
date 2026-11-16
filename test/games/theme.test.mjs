#!/usr/bin/env node
// Themes: the icon-row visual, the minecraft hotbar + chat, the live switch (`theme`, the older name
// of `skin`), and the theme a release before skins saved.
import "../_temp-sandbox.mjs"; // before the modules that name temp paths
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { renderContext } from "../../src/kit/context.js";
import { VISUALS } from "../../src/kit/elements/index.js";
import { vlen } from "../../src/kit/text.js";
import { buildHotbar, wrapMessage } from "../../src/games/minecraft/layout.js";
import { sandboxEnv } from "../_sandbox-env.mjs";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.join(HERE, "..");
const MINECRAFT_PRESET = path.join(ROOT, "src", "games", "minecraft", "presets", "minecraft.toml");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// icon-row visual: invert reads a used% as what is left.
{
  const row = VISUALS["icon-row"];
  const p = row.validate({ glyph: "♥", empty_glyph: "♡", count: 10, invert: true }).params;
  const hearts = strip(row.draw({ value: 70, params: p, width: row.widths(p).natural })[0]);
  ok(hearts === "♥♥♥♡♡♡♡♡♡♡", `icon row: 70% used -> 3 of 10 hearts (${hearts})`);
}

// Hotbar layout: every row the same width, hearts/hunger track the values, death screen.
{
  const cfg = parseToml(readFileSync(MINECRAFT_PRESET, "utf8"));
  const vals = { "context.hp": 30, "ratelimit.5h": 80, "ratelimit.7d": 31, "model.name": "Opus 5.5",
    "model.effort_level": "high", "cost.total": "$1.83", "act.tasks": "2/5", "sys.cpu": "17%" };
  const calm = { now: 1005 };
  const hud = (target, o) => buildHotbar(cfg, target, renderContext({ values: vals, ...o }));
  for (const target of [204, 100, 60, 46, 30]) {
    const { lines, width } = hud(target, calm);
    const rows = lines.map((l) => vlen(strip(l)));
    ok(rows.every((w) => w === rows[0]) && rows[0] <= target && width <= target,
      `hotbar @${target}: every row the same width, inside the terminal (${rows[0]})`);
  }
  const plain = hud(100, calm).lines.map(strip);
  ok((plain[0].match(/♥/g) || []).length === 2, "hotbar: 80% of 5h used -> 2 of 10 hearts");
  ok((plain[0].match(/🍖/g) || []).length === 7, "hotbar: 30% context used -> 7 of 10 shanks");
  ok(/ 31 /.test(plain[1]), "hotbar: XP level shows the 7-day percent");
  ok(/┃ \$1\.83 ┃/.test(plain[4]) && /┃  2\/5  ┃/.test(plain[4]), "hotbar: odd-length values sit centred in their slot");
  ok(/^ *┏━+┳/.test(plain[2].slice(plain[2].indexOf("┏"))), "hotbar: slots drawn with heavy lines");
  const dead = hud(100, { reaction: { dead: true }, now: 1005 }).lines.map(strip);
  ok(dead[0].includes("You died!") && !dead[0].includes("♥"), "hotbar: out of usage -> You died!, no hearts");
  ok(hud(100, calm).lines.length === 6, "hotbar: six rows (no wave row)");

  // Selected slot: reacts to what just happened, otherwise wanders over time.
  const react = hud(100, { now: 1005, reaction: { expr: "ouch", exprAge: 1 } }).selected;
  ok(cfg.slot[react].id === "act.errors", "hotbar: an error selects the 💥 slot");
  const picks = new Set();
  for (let t = 0; t < 200; t += 7) picks.add(hud(100, { now: t }).selected);
  ok(picks.size > 3, `hotbar: idle selection moves around (${picks.size} different slots)`);

  // Chat: on wide terminals, with the running model as a speaker; hidden when there's no room.
  const wide = hud(204, calm).lines.map(strip).join("\n");
  ok(/<[A-Z][a-z]+ \d\.\d>/.test(wide), "hotbar: chat shows <Model> messages on a wide terminal");
  let mine = false;
  for (let t = 0; t < 400; t += 5) if (hud(204, { now: t }).lines.map(strip).join("").includes("<Opus 5.5>")) mine = true;
  ok(mine, "hotbar: the selected model takes part in the chat");
  ok(!/</.test(hud(100, calm).lines.map(strip).join("")), "hotbar: no chat when there's no room");
}

// Chat timing: answers to questions come quickly, other pauses vary.
{
  const { chatLog } = await import("../../src/games/minecraft/chat.js");
  const vals = { "model.name": "Opus 5.5" };
  const last = (t) => chatLog(vals, t, 1)[0].map((p) => p.text).join("");
  const gaps = [];
  let prev = last(0), since = 0, prevText = prev;
  for (let t = 1; t < 400; t++) {
    const cur = last(t);
    if (cur !== prev) { gaps.push([prevText.trim().endsWith("?"), t - since]); since = t; prevText = cur; prev = cur; }
  }
  const answers = gaps.filter(([q]) => q).map(([, g]) => g);
  const others = new Set(gaps.filter(([q]) => !q).map(([, g]) => g));
  ok(answers.length > 0 && answers.every((g) => g <= 2), `chat: answers follow questions within 2s (${answers.join(",")})`);
  ok(others.size >= 3, `chat: other pauses vary (${[...others].sort((a, b) => a - b).join(",")}s)`);
}

// Chat facts: everything the status bar knows shows up somewhere in the loop, and a sparse
// session still makes a coherent chat (no unfilled {placeholders}, no unanswered questions).
{
  const { chatScript } = await import("../../src/games/minecraft/chat.js");
  const { SAMPLE } = await import("../../src/kit/values.js");
  const full = chatScript({ ...SAMPLE, "model.name": "Opus 5.5", "model.effort_level": "high",
    "session.title": "status bar themes", "loc.added": "185" }).map((m) => m.map((p) => p.text).join(""));
  const all = full.join("\n");
  const expected = ["status bar themes", "claude-doom-statusbar", "main", "3 files changed", "high", "thinking is on",
    "fast mode off", "auto mode", "Opus 4.8", "78% full", "1M", "64%", "2h13m", "31%", "3d4h", "$1.83", "185 blocks",
    "62 mined", "#1234", "2 helpers", "hook events", "2m13s", "2/5", "statusline values", "hook bus", "render engine",
    "0. clean run", "3 commits to push", "2 new commits", "12% on 8 cores", "95%", "RAM 47%", "disk 63%", "3 zombies",
    "busy 54%", "8.3k", "1.2k", "5h55m", "14:23"];
  const missing = expected.filter((x) => !all.includes(x));
  ok(missing.length === 0, `chat: every session fact is mentioned${missing.length ? " (missing: " + missing.join(", ") + ")" : ""}`);
  for (const [name, vals] of [["full", null], ["sparse", { "model.name": "Opus 5.5" }]]) {
    const lines = vals ? chatScript(vals).map((m) => m.map((p) => p.text).join("")) : full;
    ok(!lines.some((l) => /[{}]/.test(l)), `chat (${name}): no unfilled {placeholders}`);
    const dangling = lines.filter((l, i) => l.trim().endsWith("?") && !(lines[i + 1] || "").startsWith("<"));
    ok(dangling.length === 0, `chat (${name}): every question gets a reply${dangling.length ? " (" + dangling.join(" | ") + ")" : ""}`);
  }
}

// Chat wrapping: long messages break at spaces onto more lines, never wider than the strip.
{
  const msg = [{ text: "<", role: "text" }, { text: "Opus 5.5", role: "me" }, { text: "> context 78% full, out of 1M", role: "text" }];
  const text = (l) => l.map((p) => p.text).join("");
  const one = wrapMessage(msg, 60);
  ok(one.length === 1 && text(one[0]) === "<Opus 5.5> context 78% full, out of 1M", "wrap: fits on one line when wide");
  const many = wrapMessage(msg, 16);
  ok(many.length > 1 && many.every((l) => vlen(text(l)) <= 16), `wrap: narrow -> ${many.length} lines, each <= 16 cols`);
  ok(many.map(text).join(" ").replace(/ +/g, " ") === "<Opus 5.5> context 78% full, out of 1M", "wrap: no words lost or split");
  ok(!text(many[0]).startsWith(" ") && many.slice(1).every((l) => /^ \S/.test(text(l))), "wrap: continuation lines start with one space");
  ok(many[0].some((p) => p.role === "me" && p.text.includes("Opus")), "wrap: the model name keeps its colour role");
  const long = wrapMessage([{ text: "supercalifragilisticexpialidocious", role: "text" }], 10);
  ok(long.every((l) => vlen(text(l)) <= 10), "wrap: a word longer than the line is split");
  const cfg = parseToml(readFileSync(MINECRAFT_PRESET, "utf8"));
  const v = { "model.name": "Opus 5.5", "context.hp": 78, "model.window": "1M" };
  for (const target of [204, 150, 120]) {
    const lines = buildHotbar(cfg, target, renderContext({ values: v, now: 1005 })).lines.map(strip);
    ok(!lines.join("").includes("…"), `hotbar @${target}: chat wraps instead of cutting messages off`);
  }
}

// End to end: `theme` is the older name of `skin`. It saves the skin choice (skin.json in the user
// directory), and the statusline picks it up on the next render. A game's name chooses its default
// skin.
const tmp = mkdtempSync(path.join(os.tmpdir(), "gamebar-theme-"));
try {
  // TEMP/TMP/TMPDIR -> tmp: the render's state files land here, not in the real temp dir; the user
  // directory is tmp/user.
  const env = { ...process.env, GAMEBAR_THEME_FILE: path.join(tmp, "theme.json"), COLUMNS: "220",
    ...sandboxEnv(tmp), GAMEBAR_MSYS_REAP: "0" };
  for (const k of ["GAMEBAR_THEME", "DOOMBAR_THEME", "GAMEBAR_SKIN", "DOOMBAR_SKIN", "GAMEBAR_PRESET", "DOOMBAR_PRESET"]) delete env[k];
  const skinFile = path.join(env.GAMEBAR_USER_DIR, "skin.json");
  const saved = () => (existsSync(skinFile) ? JSON.parse(readFileSync(skinFile, "utf8")).skin : null);
  const cli = (...a) => execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "theme", ...a], { env, encoding: "utf8" });
  const skinCli = (...a) => execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "skin", ...a], { env, encoding: "utf8" });
  const render = () => strip(execFileSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
    env, encoding: "utf8", input: JSON.stringify({ session_id: `theme-test-${process.pid}`, cwd: tmp, model: { display_name: "Opus" } }),
  }));
  const out = cli("minecraft");
  ok(saved() === "minecraft" && render().includes("━"), "theme minecraft saves the minecraft skin -> statusline renders the hotbar HUD");
  ok(out === skinCli("minecraft"), "and prints what skin minecraft prints");
  ok(!existsSync(env.GAMEBAR_THEME_FILE), "theme writes no theme file");
  cli("next");
  ok(saved() === "doom-full" && render().includes("MODEL"), `theme next after the last skin wraps to the first, doom's (${saved()})`);
  cli("next");
  ok(saved() === "doom-standard", `theme next goes on through the skins (${saved()})`);
  cli("minecraft-hud");
  ok(saved() === "minecraft", "old name minecraft-hud -> saved as the minecraft skin");
  ok(cli("list") === skinCli("list") && cli() === skinCli(), "theme and theme list list the skins, as skin does");
  let threw = false;
  try { execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "theme", "satisfactory"], { env, stdio: "pipe" }); } catch { threw = true; }
  ok(threw && saved() === "minecraft", "unknown (or removed) theme is rejected and nothing is saved");

  // The theme file a release before skins saved is still read while no skin is chosen.
  rmSync(skinFile);
  writeFileSync(env.GAMEBAR_THEME_FILE, JSON.stringify({ theme: "minecraft-hud" }));
  ok(render().includes("━"), "a saved 0.12.x choice (minecraft-hud) still renders the hotbar");
  writeFileSync(env.GAMEBAR_THEME_FILE, JSON.stringify({ theme: "satisfactory" }));
  ok(render().includes("MODEL"), "a saved theme that no longer exists falls back to doom");
  writeFileSync(env.GAMEBAR_THEME_FILE, JSON.stringify({ theme: "minecraft" }));
  cli("doom");
  ok(render().includes("MODEL") && JSON.parse(readFileSync(env.GAMEBAR_THEME_FILE, "utf8")).theme === "minecraft",
    "a chosen skin wins over the saved theme, and the theme file is left as it is");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// The theme under its old names: the DOOMBAR_THEME variable, and the theme file a release before
// 1.0.0 saved (~/.claude/doombar-theme.json). The home directory is a sandbox, and no theme file is
// named, so the default places are used.
const home = mkdtempSync(path.join(os.tmpdir(), "gamebar-theme-home-"));
try {
  const env = { ...process.env, ...sandboxEnv(home), HOME: home, USERPROFILE: home, COLUMNS: "220", GAMEBAR_MSYS_REAP: "0" };
  for (const k of ["GAMEBAR_THEME", "DOOMBAR_THEME", "GAMEBAR_THEME_FILE", "DOOMBAR_THEME_FILE", "GAMEBAR_SKIN", "DOOMBAR_SKIN",
    "GAMEBAR_PRESET", "DOOMBAR_PRESET"]) delete env[k];
  const childHome = execFileSync(process.execPath, ["--input-type=module", "-e", "import os from 'node:os'; process.stdout.write(os.homedir())"],
    { env, encoding: "utf8" });
  if (path.resolve(childHome) !== path.resolve(home)) {
    ok(false, `the sandbox home is not the child's home (${childHome}): the old-file checks are skipped`);
  } else {
    const claudeDir = path.join(home, ".claude");
    const newFile = path.join(claudeDir, "gamebar-theme.json"), oldFile = path.join(claudeDir, "doombar-theme.json");
    const cli = (...a) => execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "theme", ...a], { env, encoding: "utf8" });
    const render = (extra = {}) => strip(execFileSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
      env: { ...env, ...extra }, encoding: "utf8",
      input: JSON.stringify({ session_id: `theme-old-${process.pid}`, cwd: home, model: { display_name: "Opus" } }),
    }));
    const saved = () => execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { currentTheme } from ${JSON.stringify(new URL("../../src/theme.js", import.meta.url).href)}; process.stdout.write(currentTheme())`],
    { env, encoding: "utf8" });

    ok(render({ DOOMBAR_THEME: "minecraft" }).includes("━"), "only DOOMBAR_THEME=minecraft set -> the bar renders Minecraft");
    ok(render({ GAMEBAR_THEME: "doom", DOOMBAR_THEME: "minecraft" }).includes("MODEL"), "both names set -> GAMEBAR_THEME wins");

    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(oldFile, JSON.stringify({ theme: "minecraft" }) + "\n");
    ok(saved() === "minecraft" && render().includes("━"), "only the old theme file says minecraft -> the saved theme is minecraft");
    writeFileSync(newFile, JSON.stringify({ theme: "doom" }) + "\n");
    ok(saved() === "doom" && render().includes("MODEL"), "with both files, the new one wins");
    rmSync(newFile);

    // The old package may still run and read the old file, so choosing a skin never touches it.
    cli("doom");
    ok(existsSync(oldFile) && JSON.parse(readFileSync(oldFile, "utf8")).theme === "minecraft" && !existsSync(newFile),
      "theme doom leaves the old theme file as it is and writes no new one");
    ok(render().includes("MODEL"), "and the chosen skin wins over the old file's minecraft");
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
