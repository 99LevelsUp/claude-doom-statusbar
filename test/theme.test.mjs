#!/usr/bin/env node
// Themes: pixel-art faces, the `icons` render, theme presets, and the live theme switch.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { pixelFace, parseSprite } from "../src/pixelface.js";
import { buildBar, setValues, renderValue, SAMPLE, vlen } from "../src/render.js";
import { buildHotbar } from "../src/hotbar.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Sprite names map onto expressions + health.
ok(parseSprite("STFDEAD0").expr === "dead", "STFDEAD0 -> dead");
ok(parseSprite("STFOUCH3").expr === "ouch" && parseSprite("STFOUCH3").hp === 3, "STFOUCH3 -> ouch, hp 3");
ok(parseSprite("STFTL20").glance === 0 && parseSprite("STFTR20").glance === 2, "turn sprites set the glance");
ok(parseSprite("STFST12").expr === "idle" && parseSprite("STFST12").glance === 2, "idle glance parsed");

// Every face is exactly `rows` tall and the same width for every sprite (stable layout).
const SPRITES = ["STFST00", "STFST41", "STFOUCH2", "STFKILL1", "STFEVL3", "STFTL00", "STFTR40", "STFDEAD0", "STFGOD0"];
for (const theme of ["minecraft", "satisfactory"]) {
  for (const rows of [4, 5, 7, 9, 12]) {
    const widths = new Set();
    let tall = true;
    for (const sp of SPRITES) {
      const face = pixelFace(theme, sp, rows);
      if (face.length !== rows) tall = false;
      widths.add(Math.max(...face.map((r) => r.length)));
    }
    ok(tall && widths.size === 1, `${theme} @${rows} rows: exact height, one width for all sprites`);
  }
  // Health shows up in the caption: a healthy face has more filled cells than a hurt one.
  const filled = (sp) => pixelFace(theme, sp, 7)[6].filter(([ch]) => ch === "♥" || ch === "▰").length;
  ok(filled("STFST00") > filled("STFST41"), `${theme}: caption loses health as hp drops`);
}
ok(pixelFace("satisfactory", "STFDEAD0", 7)[6].map(([c]) => c).join("") === "FUSE!", "satisfactory: dead -> FUSE!");

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

// Theme presets render at full width and fall back when narrow.
setValues(SAMPLE);
for (const name of ["minecraft", "satisfactory"]) {
  const cfg = parseToml(readFileSync(path.join(ROOT, "presets", `${name}.toml`), "utf8"));
  const mini = parseToml(readFileSync(path.join(ROOT, "presets", cfg.bar.fallback + ".toml"), "utf8"));
  const res = buildBar(cfg, 220);
  ok(res.lines.length >= 4 && res.lines.every((l) => vlen(l) <= 220), `${name}: renders within 220 cols`);
  ok(mini.mugshot.face === name, `${name}: fallback preset keeps the ${name} face`);
}

// Hotbar layout: every row the same width, hearts/hunger track the values, death screen.
{
  const cfg = parseToml(readFileSync(path.join(ROOT, "presets", "minecraft-hud.toml"), "utf8"));
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
  ok(render().includes("PLAYER"), "theme minecraft -> statusline renders the minecraft HUD");
  cli("next");
  ok(render().includes("━"), "theme next -> minecraft-hud (the hotbar layout)");
  cli("next");
  ok(render().includes("ENGINEER"), "theme next -> satisfactory");
  cli("next");
  ok(!existsSync(env.DOOMBAR_THEME_FILE), "theme next wraps to doom and removes the saved file");
  ok(render().includes("MODEL"), "doom theme -> back to the DOOM preset");
  let threw = false;
  try { execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "theme", "zelda"], { env, stdio: "pipe" }); } catch { threw = true; }
  ok(threw, "unknown theme is rejected");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
