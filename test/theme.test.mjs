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
