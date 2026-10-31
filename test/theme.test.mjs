#!/usr/bin/env node
// Themes: the `icons` render, the minecraft hotbar + chat, and the live theme switch.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { buildBar, setValues, renderValue, vlen } from "../src/render.js";
import { buildHotbar, wrapMessage } from "../src/hotbar.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// icons render: invert reads a used% as what is left.
setValues({ "context.hp": 70 });
const hearts = strip(renderValue({ id: "context.hp", render: "icons", glyph: "♥", empty_glyph: "♡", count: 10, invert: true }, 0, [0, 0, 0]));
ok(hearts === "♥♥♥♡♡♡♡♡♡♡", `icons: 70% used -> 3 of 10 hearts (${hearts})`);

// stretch icons fill their whole box row, like a bar does.
{
  setValues({ "context.hp": 50, "sys.ram": 40 });
  const box = { bar: { headers: false }, segment: [{ type: "box", metric: [
    { id: "context.hp", render: "icons", icon: "💖", glyph: "♥", empty_glyph: "♡", stretch: true, invert: true },
    { id: "sys.ram", render: "bar", icon: "💾" },
  ] }] };
  const [heartsRow, barRow] = buildBar(box, 120).lines.map((l) => strip(l).trim());
  ok(vlen(heartsRow) === vlen(barRow), `stretch: hearts row is as wide as the bar row (${vlen(heartsRow)} vs ${vlen(barRow)})`);
  ok([...heartsRow].filter((c) => c === "♥" || c === "♡").length > 10, "stretch: more than the default 10 glyphs at full width");
}

// Hotbar layout: every row the same width, hearts/hunger track the values, death screen.
{
  const cfg = parseToml(readFileSync(path.join(ROOT, "presets", "minecraft.toml"), "utf8"));
  const vals = { "context.hp": 30, "ratelimit.5h": 80, "ratelimit.7d": 31, "model.name": "Opus 5.5",
    "model.effort_level": "high", "cost.total": "$1.83", "act.tasks": "2/5", "sys.cpu": "17%" };
  const calm = { now: 1005 };
  for (const target of [204, 100, 60, 46, 30]) {
    const { lines, width } = buildHotbar(cfg, target, vals, calm);
    const rows = lines.map((l) => vlen(strip(l)));
    ok(rows.every((w) => w === rows[0]) && rows[0] <= target && width <= target,
      `hotbar @${target}: every row the same width, inside the terminal (${rows[0]})`);
  }
  const plain = buildHotbar(cfg, 100, vals, calm).lines.map(strip);
  ok((plain[0].match(/♥/g) || []).length === 7, "hotbar: 30% context used -> 7 of 10 hearts");
  ok((plain[0].match(/🍖/g) || []).length === 2, "hotbar: 80% of 5h used -> 2 of 10 shanks");
  ok(/ 31 /.test(plain[1]), "hotbar: XP level shows the 7-day percent");
  ok(/┃ \$1\.83 ┃/.test(plain[4]) && /┃  2\/5  ┃/.test(plain[4]), "hotbar: odd-length values sit centred in their slot");
  ok(/^ *┏━+┳/.test(plain[2].slice(plain[2].indexOf("┏"))), "hotbar: slots drawn with heavy lines");
  const dead = buildHotbar(cfg, 100, vals, { exhausted: true, now: 1005 }).lines.map(strip);
  ok(dead[0].includes("You died!") && !dead[0].includes("♥"), "hotbar: out of usage -> You died!, no hearts");
  ok(buildHotbar(cfg, 100, vals, calm).lines.length === 6, "hotbar: six rows (no wave row)");

  // Selected slot: reacts to what just happened, otherwise wanders over time.
  const react = buildHotbar(cfg, 100, vals, { now: 1005, expr: "ouch", exprAge: 1 }).selected;
  ok(cfg.slot[react].id === "act.errors", "hotbar: an error selects the 💥 slot");
  const picks = new Set();
  for (let t = 0; t < 200; t += 7) picks.add(buildHotbar(cfg, 100, vals, { now: t }).selected);
  ok(picks.size > 3, `hotbar: idle selection moves around (${picks.size} different slots)`);

  // Chat: on wide terminals, with the running model as a speaker; hidden when there's no room.
  const wide = buildHotbar(cfg, 204, vals, calm).lines.map(strip).join("\n");
  ok(/<[A-Z][a-z]+ \d\.\d>/.test(wide), "hotbar: chat shows <Model> messages on a wide terminal");
  let mine = false;
  for (let t = 0; t < 400; t += 5) if (buildHotbar(cfg, 204, vals, { now: t }).lines.map(strip).join("").includes("<Opus 5.5>")) mine = true;
  ok(mine, "hotbar: the selected model takes part in the chat");
  ok(!/</.test(buildHotbar(cfg, 100, vals, calm).lines.map(strip).join("")), "hotbar: no chat when there's no room");
}

// Chat timing: answers to questions come quickly, other pauses vary.
{
  const { chatLog } = await import("../src/chat.js");
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
  const { chatScript } = await import("../src/chat.js");
  const { SAMPLE } = await import("../src/render.js");
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
  const cfg = parseToml(readFileSync(path.join(ROOT, "presets", "minecraft.toml"), "utf8"));
  const v = { "model.name": "Opus 5.5", "context.hp": 78, "model.window": "1M" };
  for (const target of [204, 150, 120]) {
    const lines = buildHotbar(cfg, target, v, { now: 1005 }).lines.map(strip);
    ok(!lines.join("").includes("…"), `hotbar @${target}: chat wraps instead of cutting messages off`);
  }
}

// End to end: `theme` writes the choice, the statusline picks it up on the next render.
const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-theme-"));
try {
  const env = { ...process.env, DOOMBAR_THEME_FILE: path.join(tmp, "theme.json"), COLUMNS: "220" };
  delete env.DOOMBAR_THEME;
  const cli = (...a) => execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "theme", ...a], { env, encoding: "utf8" });
  const render = () => strip(execFileSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
    env, encoding: "utf8", input: JSON.stringify({ session_id: `theme-test-${process.pid}`, cwd: tmp, model: { display_name: "Opus" } }),
  }));
  cli("minecraft");
  ok(render().includes("━"), "theme minecraft -> statusline renders the hotbar HUD");
  cli("next");
  ok(!existsSync(env.DOOMBAR_THEME_FILE), "theme next wraps to doom and removes the saved file");
  ok(render().includes("MODEL"), "doom theme -> back to the DOOM preset");
  cli("minecraft-hud");
  ok(JSON.parse(readFileSync(env.DOOMBAR_THEME_FILE, "utf8")).theme === "minecraft", "old name minecraft-hud -> saved as minecraft");
  writeFileSync(env.DOOMBAR_THEME_FILE, JSON.stringify({ theme: "minecraft-hud" }));
  ok(render().includes("━"), "a saved 0.12.x choice (minecraft-hud) still renders the hotbar");
  writeFileSync(env.DOOMBAR_THEME_FILE, JSON.stringify({ theme: "satisfactory" }));
  ok(render().includes("MODEL"), "a saved theme that no longer exists falls back to doom");
  let threw = false;
  try { execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "theme", "satisfactory"], { env, stdio: "pipe" }); } catch { threw = true; }
  ok(threw, "unknown (or removed) theme is rejected");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
