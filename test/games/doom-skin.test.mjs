#!/usr/bin/env node
// DOOM as data: its game folder holds only its manifest and its skins (full, standard, minimal, and
// the low compact and line), and what is particular to DOOM, the mugshot's frame for the session's
// reaction, is a script among its assets. These pin the skins (they load without a warning, the
// boxes each width shows, how the bar narrows from full to standard to minimal, and how a short or
// narrow terminal takes it on to compact and line), the mugshot script's frames, the default frame
// drawn when no script runs, and that the old preset setting still picks the size.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEMP_SANDBOX } from "../_temp-sandbox.mjs"; // before the modules that name temp paths
import { RAW_SAMPLE } from "../_raw-sample.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const k of ["WT_SESSION", "TERM_PROGRAM", "TERM", "TMUX", "VTE_VERSION", "GAMEBAR_GLYPHS", "GAMEBAR_THEME", "GAMEBAR_PRESET", "GAMEBAR_SKIN",
  "LINES", "GAMEBAR_MAX_ROWS", "DOOMBAR_MAX_ROWS"]) delete process.env[k];
Object.assign(process.env, { PATH: "", GAMEBAR_MSYS_REAP: "0", GAMEBAR_RATELIMITS_SHARE: "0" });

const { findGame } = await import("../../src/games/index.js");
const { findSkin, selectSkin } = await import("../../src/skin-select.js");
const { loadSkin } = await import("../../src/kit/skin/load.js");
const { fitSkin } = await import("../../src/kit/skin/fit.js");
const { drawFit } = await import("../../src/kit/skin/draw.js");
const { runScripts, createScriptPass } = await import("../../src/kit/skin/scripts.js");
const { createScriptHost } = await import("../../src/platform/scripts/host.js");
const { createAssetResolver } = await import("../../src/platform/assets.js");
const { renderSession } = await import("../../src/render.js");
const { vlen } = await import("../../src/kit/text.js");

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const NOW = 1793500000;
const CALM = { expr: null, exprAge: null, flash: null, hp: 1, god: false, dead: false };
const flash = (f, hp = 2) => ({ ...CALM, expr: f, exprAge: 0.5, flash: f, hp });

const doom = findGame("doom");
const assets = createAssetResolver({ folder: doom.dir });
const host = createScriptHost({ callBudgetMs: 2000, graceMs: 2000, startupMs: 5000 });
const SCRIPT = assets.resolve("doom:scripts/mugshot.js");

// The mugshot script's frame for `reaction` at `now`.
function frameFor(reaction, now = NOW) {
  const [r] = host.runBatch([{ script: SCRIPT, input: { reaction, now, value: null, params: {}, state: {} } }], { deadlineMs: 5000 });
  return r.status === "ok" ? r.output.frame : `(${r.status}: ${r.message})`;
}

const smaller = (name) => {
  const s = findSkin(name);
  return s && s.file ? loadSkin(s.file).skin : null;
};

// A skin file fitted to `width` and `rows`, its scripts run (unless `scripts` is false), and drawn.
function draw(file, { width = 200, rows = Infinity, reaction = CALM, now = NOW, step = "octant", scripts = true, frames = null, values = RAW_SAMPLE } = {}) {
  const loaded = loadSkin(file);
  const fit = fitSkin(loaded.skin, { values, width, rows, loadSmaller: smaller });
  const ctx = { tick: 0, step, resolveAsset: assets.resolve, reaction, now };
  let drawn = fit, outputs = frames ?? {};
  if (scripts && !frames) {
    // A pass no loaded machine uses up: these checks need the mugshot script to run, not to be timed.
    const pass = createScriptPass({ budgetMs: 60000, callBudgetMs: 10000 });
    const run = runScripts(fit, { host, pass, values, reaction, now, tick: 0, folderOf: () => doom.dir, resolveAsset: assets.resolve });
    drawn = run.fit;
    outputs = run.scripts;
  }
  return { loaded, fit, scripts: outputs, lines: drawFit(drawn, { values, width, ctx, scripts: outputs }) };
}

const skinFile = (name) => findSkin(name).file;
const titles = (lines) => strip(lines[0]).trim().split(/\s{2,}|[^A-Z ]+/).map((t) => t.trim()).filter((t) => /^[A-Z]{3,}$/.test(t));

try {
  console.log("the game folder is data:");
  {
    const dir = path.join(ROOT, "src", "games", "doom");
    const files = readdirSync(dir, { recursive: true }).map((f) => f.replace(/\\/g, "/")).sort();
    ok(same(files, ["game.toml", "skins", "skins/compact.toml", "skins/full.toml", "skins/line.toml", "skins/minimal.toml", "skins/standard.toml"]),
      `src/games/doom holds the manifest and five skins, no code (${files.join(", ")})`);
    for (const name of ["doom-full", "doom-standard", "doom-minimal"]) {
      const s = findSkin(name);
      const { skin, warnings } = loadSkin(s.file);
      ok(skin && warnings.length === 0, `${name} loads without a warning${warnings.length ? `: ${warnings.map((w) => w.message).join("; ")}` : ""}`);
    }
    ok(SCRIPT && existsSync(SCRIPT), "the mugshot script is a DOOM asset (doom:scripts/mugshot.js)");
  }

  console.log("mugshot frames:");
  {
    ok(frameFor(flash("dead", 4)) === "STFDEAD0", "the dead reaction draws STFDEAD0");
    ok(frameFor(flash("god", 0)) === "STFGOD0", "the god reaction draws STFGOD0");
    ok(frameFor(flash("ouch", 2)) === "STFOUCH2", "an ouch at hp 2 draws STFOUCH2");
    ok(frameFor(flash("kill", 3)) === "STFKILL3" && frameFor(flash("evl", 1)) === "STFEVL1", "kill and evl draw their frames at the health row");
    ok(frameFor(flash("tl", 2)) === "STFTL20" && frameFor(flash("tr", 4)) === "STFTR40", "a glance left or right draws its frame");
    ok(frameFor(flash("other", 2)) === "STFST21", "a reaction DOOM has no face for holds the middle idle frame");
    const idle = new Set(Array.from({ length: 40 }, (_, i) => frameFor({ ...CALM, hp: 1 }, NOW + 2 * i)));
    ok(same([...idle].sort(), ["STFST10", "STFST11", "STFST12"]), `calm at several clock values cycles the three idle frames (${[...idle].join(" ")})`);
    ok(frameFor(CALM, NOW) === frameFor(CALM, NOW + 1.9) || Math.floor(NOW / 2) !== Math.floor((NOW + 1.9) / 2),
      "one idle glance holds for its two seconds");
    ok(frameFor({ ...CALM, hp: 3 }, null) === "STFST31", "without a clock the idle face holds the middle frame");
    // Every frame the script can return is one of the frames DOOM ships.
    const named = new Set();
    for (const f of [null, "dead", "god", "ouch", "kill", "evl", "tl", "tr", "other"]) {
      for (let hp = 0; hp <= 4; hp++) for (let i = 0; i < 12; i++) named.add(frameFor(f ? flash(f, hp) : { ...CALM, hp }, NOW + 2 * i));
    }
    const missing = [...named].filter((n) => !assets.resolve(`doom:images/mugshot/${n}.png`));
    ok(missing.length === 0, `every frame the script picks exists among DOOM's images (${named.size} frames${missing.length ? `; missing ${missing.join(", ")}` : ""})`);
  }

  console.log("the DOOM mugshot in another game's container:");
  {
    // A user skin: a Minecraft-styled hotbar cell holding the DOOM mugshot.
    const dir = path.join(TEMP_SANDBOX, "user", "skins", "mixed");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "mixed.toml");
    writeFileSync(file, [
      'version = 1', 'root = "hotbar"',
      '[element.hotbar]', 'kind = "row"', 'frame = { kind = "grid", background = "#262626" }', 'children = ["face", "branch"]',
      '[element.face]', 'kind = "animation"', 'frames = "doom:images/mugshot"', 'script = "doom:scripts/mugshot.js"',
      'default_frame = "doom:images/mugshot/STFST01.png"', 'width = 14',
      '[element.branch]', 'kind = "text"', 'metric = "git.branch"', 'width = 8', '',
    ].join("\n"));
    const ouch = draw(file, { width: 40, reaction: flash("ouch", 2) });
    ok(ouch.loaded.warnings.length === 0, "the mixed skin loads without a warning");
    ok(ouch.scripts.face && ouch.scripts.face.frame === "STFOUCH2", `with the reaction ouch at hp 2 the DOOM script picks STFOUCH2 (${JSON.stringify(ouch.scripts.face)})`);
    const pinned = draw(file, { width: 40, frames: { face: { frame: "STFOUCH2" } } });
    const idle = draw(file, { width: 40, frames: {} });
    ok(same(ouch.lines, pinned.lines) && !same(ouch.lines, idle.lines), "the hurt frame STFOUCH2 is drawn, not the default face");
  }

  console.log("the skins at each width:");
  {
    const full = skinFile("doom-full");
    const at = (width) => draw(full, { width });
    const wide = at(200);
    const t200 = titles(wide.lines);
    ok(["MODEL", "USAGE", "PROJECT", "ACTIVITY", "AGENTS", "TASKS"].every((t) => t200.includes(t)),
      `doom-full at 200 columns shows MODEL, USAGE, PROJECT, ACTIVITY, AGENTS and TASKS (${t200.join(" ")})`);
    ok(same(t200, ["MODEL", "USAGE", "SAVE", "PROJECT", "ACTIVITY", "AGENTS", "TASKS", "SYSTEM"]) && wide.fit.skin.name === "doom-full",
      "at 200 columns every box of doom-full is drawn");
    const mid = at(120);
    ok(same(titles(mid.lines), ["MODEL", "USAGE", "PROJECT", "ACTIVITY", "AGENTS", "TASKS"]),
      `at 120 columns SYSTEM and SAVE have dropped (${titles(mid.lines).join(" ")})`);
    const narrow = at(80);
    ok(narrow.fit.skin.name === "doom-minimal" && same(titles(narrow.lines), ["MODEL", "USAGE", "PROJECT", "ACTIVITY"]),
      `at 80 columns the bar has gone down to doom-minimal (${narrow.fit.skin.name}: ${titles(narrow.lines).join(" ")})`);
    ok(same(narrow.fit.tree.children.map((k) => k.id), ["model", "usage", "mugshot", "project", "activity"]),
      "doom-minimal has the mugshot between USAGE and PROJECT");
    for (const [width, r] of [[200, wide], [120, mid], [80, narrow]]) {
      ok(r.lines.length === 7 && r.lines.every((l) => vlen(l) <= width), `at ${width} columns the bar is 7 rows within the width`);
    }
    ok(draw(skinFile("doom-standard"), { width: 200 }).fit.skin.name === "doom-standard"
      && same(titles(draw(skinFile("doom-standard"), { width: 200 }).lines), ["MODEL", "USAGE", "PROJECT", "ACTIVITY", "AGENTS", "TASKS"]),
      "doom-standard at 200 columns is full without SAVE and SYSTEM");
  }

  console.log("the skins at each height:");
  {
    const full = skinFile("doom-full");
    // The boxes and the mugshot in order; doom-compact holds MODEL and USAGE in a row of their own.
    const ids = (r) => r.fit.tree.children.flatMap((k) => (k.id === "boxes" ? k.children.map((c) => c.id) : [k.id]));
    const tall = draw(full, { width: 200, rows: 7 });
    ok(tall.fit.skin.name === "doom-full" && tall.lines.length === 7, "with room for 7 rows doom-full is drawn whole");
    const six = draw(full, { width: 200, rows: 6 });
    ok(six.fit.skin.name === "doom-compact" && six.lines.length === 3,
      `with 6 rows every titled skin is too tall and the bar goes down to doom-compact (${six.fit.skin.name}, ${six.lines.length} rows)`);
    // The Raspberry Pi's panel: 58 columns less the indent, 16 rows of which the bar may take a third.
    const panel = draw(full, { width: 56, rows: 5 });
    ok(panel.fit.skin.name === "doom-compact" && same(ids(panel), ["model", "usage", "mugshot", "project"]) && !panel.fit.clipped,
      `a 56x5 panel draws doom-compact whole (${panel.fit.skin.name}: ${ids(panel).join(" ")})`);
    ok(panel.lines.length === 3 && panel.lines.every((l) => vlen(l) <= 56), "doom-compact is 3 rows within the width");
    ok(!/[A-Z]{4,}/.test(strip(panel.lines.join("\n")).replace(/Opus/g, "")), "doom-compact's boxes have no title rows");
    const byId = (t, id) => (t.id === id ? t : t.children.map((k) => byId(k, id)).find(Boolean) || null);
    for (const width of [44, 56, 70, 90]) {
      const fitted = draw(skinFile("doom-compact"), { width }).fit.tree;
      const w = ["context-bar", "limit-5h-bar", "limit-7d-bar"].map((id) => byId(fitted, id)?.width);
      ok(w[0] > 0 && w.every((x) => x === w[0]), `at ${width} columns doom-compact's three USAGE bars are as long (${w.join(", ")})`);
    }
    ok(strip(panel.lines[0]).includes("Opus") && !strip(panel.lines[0]).includes("4.8"), "doom-compact names the model without its version");
    // The face is 5 or 6 columns in every frame; in 7 columns with no separator beside it, its own
    // black margin of one column is the only gap to USAGE and PROJECT.
    ok(byId(panel.fit.tree, "mugshot").width === 7 && panel.fit.tree.node.params.separator === "",
      "doom-compact's mugshot is 7 columns and sits right against its neighbours");
    const narrow = draw(full, { width: 44, rows: 5 });
    ok(narrow.fit.skin.name === "doom-compact" && same(ids(narrow), ["model", "usage", "mugshot"]),
      `at 44 columns doom-compact has dropped PROJECT (${ids(narrow).join(" ")})`);
    const short = draw(full, { width: 56, rows: 2 });
    ok(short.fit.skin.name === "doom-line" && short.lines.length === 1 && vlen(short.lines[0]) <= 56,
      `with 2 rows the bar is doom-line, one row (${short.fit.skin.name})`);
    const oneRow = draw(full, { width: 56, rows: 1 });
    ok(oneRow.fit.skin.name === "doom-line" && !oneRow.lines.some((l) => /[\u{1CD00}-\u{1CDE5}]/u.test(l)), "doom-line has no mugshot");
    // With no room at all the last skin of the chain is drawn, never nothing.
    const none = draw(full, { width: 56, rows: 0 });
    ok(none.fit.skin.name === "doom-line" && none.lines.length === 1, "a terminal too short for any skin still gets doom-line");
    // Width alone: below doom-minimal's width the bar now goes on to doom-compact instead of being cut.
    const cut = draw(full, { width: 56 });
    ok(cut.fit.skin.name === "doom-compact" && !cut.fit.clipped, "at 56 columns doom-compact is drawn instead of a cut doom-minimal");
  }

  console.log("empty lists, the cores and the rows of a box:");
  {
    const node = (t, id) => (t.id === id ? t : t.children.map((k) => node(k, id)).find(Boolean) || null);
    for (const name of ["doom-full", "doom-standard"]) {
      const empty = draw(skinFile(name), { values: { ...RAW_SAMPLE, "act.subagents": [], "act.tasklist": [] } });
      const agents = node(empty.fit.tree, "agents"), tasks = node(empty.fit.tree, "tasks");
      ok(agents.width === "AGENTS".length + 2 && tasks.width === "TASKS".length + 2 && !agents.children.length && !tasks.children.length,
        `${name}: empty AGENTS and TASKS boxes shrink to their titles (${agents.width}, ${tasks.width})`);
      ok(same(titles(empty.lines), titles(draw(skinFile(name)).lines)), `${name}: and keep their titles`);
    }
    const sys = (cores) => node(draw(skinFile("doom-full"), { values: { ...RAW_SAMPLE, "sys.cores": cores } }).fit.tree, "system");
    ok(node(sys([0.1, 0.5, 0.9, 1]), "cores").width === 3 + 4 && node(sys(RAW_SAMPLE["sys.cores"]), "cores").width === 3 + 8,
      "the CPU equalizer has a column per core: 4 cores, 4 columns");
    const s = sys([0.1, 0.5, 0.9, 1]);
    const inner = s.width - 2;
    ok(s.children.every((k) => k.width === inner), `every row of the SYSTEM box is as wide as the box (${s.children.map((k) => `${k.id} ${k.width}`).join(", ")} of ${inner})`);
    ok(node(s, "cpu-total").width > 4, "the CPU total takes what the equalizer leaves, so it ends at the box's edge");
  }

  console.log("without scripts (the one-shot status line):");
  {
    const full = skinFile("doom-full");
    const none = draw(full, { scripts: false, reaction: flash("ouch", 2) });
    const idleFace = draw(full, { frames: { mugshot: { frame: "STFST01" } } });
    const hurt = draw(full, { frames: { mugshot: { frame: "STFOUCH2" } } });
    ok(same(none.lines, idleFace.lines) && !same(none.lines, hurt.lines), "the mugshot draws its default frame, the idle face STFST01");
  }

  console.log("the glyph step:");
  {
    const full = skinFile("doom-full");
    const mug = loadSkin(full).skin.root.children.find((k) => k.id === "mugshot");
    ok(mug && mug.params.glyphs === "octant", "the mugshot names its richest glyph step");
    const faceGlyphs = (lines) => new Set(lines.flatMap((l) => [...strip(l)]));
    const half = draw(full, { step: "half", frames: { mugshot: { frame: "STFST01" } } });
    const octant = draw(full, { step: "octant", frames: { mugshot: { frame: "STFST01" } } });
    ok(!same(half.lines, octant.lines), "a terminal that draws only half blocks gets another face");
    const dir = path.join(TEMP_SANDBOX, "user", "skins", "capped");
    mkdirSync(dir, { recursive: true });
    const capped = path.join(dir, "capped.toml");
    writeFileSync(capped, [
      'version = 1', 'root = "face"',
      '[element.face]', 'kind = "animation"', 'frames = "doom:images/mugshot"', 'default_frame = "doom:images/mugshot/STFST01.png"',
      'width = 14', 'glyphs = "half"', '',
    ].join("\n"));
    const lines = draw(capped, { width: 14, step: "octant", frames: {} }).lines;
    ok([...faceGlyphs(lines)].every((ch) => " █▀▄▌▐".includes(ch)) && lines.some((l) => /[█▀▄▌▐]/.test(strip(l))),
      "a mugshot capped at half blocks draws half blocks on a terminal that draws octants");
  }

  console.log("an old preset setting picks the size:");
  {
    const env = {
      ...process.env, COLUMNS: "250", GAMEBAR_THEME_FILE: path.join(TEMP_SANDBOX, "no-theme.json"),
      GAMEBAR_PRESET: path.join(ROOT, "src", "games", "doom", "presets", "minimal.toml"),
      GAMEBAR_STATE: path.join(TEMP_SANDBOX, "state.json"), GAMEBAR_TASKS_DIR: path.join(TEMP_SANDBOX, "tasks"),
    };
    const sel = selectSkin(env);
    ok(sel.name === "doom-minimal" && sel.file === skinFile("doom-minimal") && sel.warnings.length === 0,
      `GAMEBAR_PRESET at the old DOOM minimal preset, no theme and no skin choice: doom-minimal (${sel.name})`);
    const data = { session_id: "s1", model: { display_name: "Opus 5.5" }, context_window: { used_percentage: 42 } };
    const out = strip(renderSession({ data, env, now: NOW, scripts: false }).join("\n"));
    const fullOut = strip(renderSession({ data, env: { ...env, GAMEBAR_PRESET: "", GAMEBAR_SKIN: "doom-full" }, now: NOW, scripts: false }).join("\n"));
    ok(out.includes("MODEL") && !out.includes("SYSTEM") && fullOut.includes("SYSTEM"), "and renderSession draws doom-minimal, not doom-full");
  }
} finally {
  host.close();
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
