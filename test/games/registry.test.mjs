#!/usr/bin/env node
// The game registry (src/games/index.js): a game is a folder with a manifest (game.toml) and its
// skins, found by the registry itself.
//
// The fixture game in ./fixture-game is a manifest and one skin, data only. This test reads the
// folder into a registry entry, adds it to the registry's list and renders it through
// renderSession, the same call the one-shot status line and the render daemon make: nothing outside
// the fixture's folder is needed. It also pins the production list (themes cycle doom -> minecraft
// -> doom, the old minecraft-hud name still resolves, every manifest is complete), the old layouts
// that still draw a skin whose file a game does not ship yet, the glyph test card's sample lookup,
// and the fallback for preset paths written before the presets moved into their games.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { sandboxEnv } from "../_sandbox-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const FIXTURE_DIR = path.join(HERE, "fixture-game");
const DOOM_PRESETS = path.join(ROOT, "src", "games", "doom", "presets");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const inside = (dir, p) => !path.relative(dir, p).startsWith("..") && !path.isAbsolute(path.relative(dir, p));

const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-registry-"));
const TMPDIR = path.join(SB, "tmp");
mkdirSync(TMPDIR, { recursive: true });
// Before the imports: the sandbox is the runtime directory, and the terminal running the tests must
// not pick the mugshot's glyphs.
const USER_DIR = path.join(SB, "user");
Object.assign(process.env, { ...sandboxEnv(TMPDIR), PATH: "", GAMEBAR_MSYS_REAP: "0", GAMEBAR_RATELIMITS_SHARE: "0", GAMEBAR_USER_DIR: USER_DIR });
for (const k of ["WT_SESSION", "TERM_PROGRAM", "TERM", "TMUX", "VTE_VERSION", "GAMEBAR_GLYPHS", "GAMEBAR_THEME", "GAMEBAR_PRESET", "GAMEBAR_SKIN"]) delete process.env[k];

const { GAMES, readGame, defaultGame, gameNames, sampleImage, presetFile } = await import("../../src/games/index.js");
const { THEME_NAMES, nextTheme, resolveTheme, currentTheme } = await import("../../src/theme.js");
const { renderSession } = await import("../../src/render.js");
const { buildSkin } = await import("../../src/kit/skin/load.js");

const strip = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");
const NOW = 1793500000.123;
function session(name) {
  const dir = path.join(SB, name);
  for (const d of ["tasks", "proj", "state"]) mkdirSync(path.join(dir, d), { recursive: true });
  const env = {
    COLUMNS: "120", GAMEBAR_THEME_FILE: path.join(dir, "no-theme.json"), GAMEBAR_RATELIMITS_SHARE: "0",
    GAMEBAR_USER_DIR: USER_DIR,
    GAMEBAR_STATE: path.join(dir, "state", "checkpoint.json"), GAMEBAR_TASKS_DIR: path.join(dir, "tasks"),
    GAMEBAR_EVENTS: path.join(dir, "events.jsonl"), GAMEBAR_LLMLINGUA: path.join(dir, "ling.json"),
    GAMEBAR_RATELIMITS: path.join(dir, "rl.json"),
  };
  const data = {
    session_id: `sid-${name}`, session_name: `${name}-run`, cwd: path.join(dir, "proj"),
    model: { display_name: "Opus 5.5" }, context_window: { used_percentage: 42, context_window_size: 1000000 },
    cost: { total_cost_usd: 1.5, total_duration_ms: 3725000 },
  };
  return { env, data };
}
const render = (s, over = {}) => renderSession({ data: s.data, env: { ...s.env, ...over }, now: NOW }).join("\n");

// Add an entry for the length of `fn`, at the front or the back of the list, and take it out again.
function withGame(entry, fn, { first = false } = {}) {
  if (first) GAMES.unshift(entry); else GAMES.push(entry);
  try { return fn(); } finally { GAMES.splice(GAMES.indexOf(entry), 1); }
}

try {
  render(session("warmup")); // the first render has no earlier CPU sample to diff against

  // The production list.
  ok(GAMES.map((g) => g.name).join(",") === "doom,minecraft", "the registry lists doom, then minecraft");
  ok(THEME_NAMES.join(",") === "doom,minecraft", "the theme names follow the registry's order");
  ok(nextTheme("doom") === "minecraft" && nextTheme("minecraft") === "doom", "theme next cycles doom -> minecraft -> doom");
  ok(resolveTheme("minecraft-hud") === "minecraft", "the old name minecraft-hud still resolves to minecraft");
  ok(resolveTheme("satisfactory") === null, "a name no game registers resolves to nothing");
  ok(gameNames().join(",") === "doom,minecraft,minecraft-hud", "the registry's names are the games and their older theme names");
  ok(GAMES.filter((g) => g.default).length === 1 && defaultGame().name === "doom", "exactly one game is the default: doom");
  for (const g of GAMES) {
    const dir = path.join(ROOT, "src", "games", g.name);
    const manifest = parseToml(readFileSync(path.join(dir, "game.toml"), "utf8"));
    ok(manifest.name === g.name && g.dir === dir && g.about.length > 0, `${g.name}: read from src/games/${g.name}/game.toml`);
    ok(g.skins.some((s) => s.name === g.defaultSkin) && Object.values(g.presetSkins).every((n) => g.skins.some((s) => s.name === n)),
      `${g.name}: its default skin and the skin of each preset are among its skins (${g.skins.map((s) => s.name).join(", ")})`);
    ok(g.assets && g.assets.package === `@claude-game-bar/${g.name}` && typeof g.assets.version === "string"
      && typeof g.assets.integrity === "string", `${g.name}: its asset package is @claude-game-bar/${g.name}, pinned`);
    const files = Object.values(g.presets);
    ok(files.length > 0 && files.every((f) => inside(dir, f) && existsSync(f)),
      `${g.name}: its presets exist inside src/games/${g.name}`);
    ok(Object.hasOwn(g.presets, g.defaultPreset), `${g.name}: its default preset is one of its presets`);
  }
  ok(GAMES.find((g) => g.name === "doom").readsPresets && !GAMES.find((g) => g.name === "minecraft").readsPresets,
    "doom reads the preset setting, minecraft does not");

  // A skin a game names but ships no file for yet draws the game's old layout and preset of the
  // skin's size, chosen by the session or saved.
  {
    const s = session("old-layout");
    const doom = GAMES.find((g) => g.name === "doom");
    for (const size of ["full", "standard", "minimal"]) {
      const skin = doom.presetSkins[size];
      ok(render(s, { GAMEBAR_SKIN: skin }) === render(s, { GAMEBAR_THEME: "doom", GAMEBAR_PRESET: doom.presets[size] }),
        `GAMEBAR_SKIN=${skin} draws doom's ${size} preset`);
    }
    ok(render(s, { GAMEBAR_SKIN: "minecraft", GAMEBAR_THEME: "doom" }) === render(s, { GAMEBAR_THEME: "minecraft" }),
      "GAMEBAR_SKIN=minecraft draws the minecraft preset, whatever the theme");
  }

  // The fixture game: its own folder, data only, and it renders through renderSession.
  {
    const files = readdirSync(FIXTURE_DIR, { recursive: true }).map((f) => f.replace(/\\/g, "/")).sort();
    ok(files.join(",") === "game.toml,skins,skins/fixture.toml", `the fixture game is a manifest and one skin (${files.join(", ")})`);
    const FIXTURE_GAME = readGame(FIXTURE_DIR);
    ok(FIXTURE_GAME.skins.length === 1 && inside(FIXTURE_DIR, FIXTURE_GAME.skins[0].file) && FIXTURE_GAME.layout === null,
      "its entry names only a skin from its own folder, and no layout");
    const skinFile = FIXTURE_GAME.skins[0].file;
    ok(buildSkin(parseToml(readFileSync(skinFile, "utf8")), skinFile).warnings.length === 0, "its skin loads without a warning");
    const s = session("fixture");
    const drawn = (over) => strip(render(s, over)).trim();
    const want = "FIXTURE Opus 5.5";
    ok(!drawn({ GAMEBAR_THEME: "fixture" }).startsWith(want), "before it is registered, the fixture theme is not drawn");
    withGame(FIXTURE_GAME, () => {
      ok(resolveTheme("fixture-old") === "fixture", "a registered game's alias resolves");
      const viaTheme = drawn({ GAMEBAR_THEME: "fixture" });
      ok(viaTheme.startsWith(want) && !viaTheme.includes("\n"), `chosen as a theme, it draws its own skin (${JSON.stringify(viaTheme)})`);
      ok(drawn({ GAMEBAR_SKIN: "fixture" }) === viaTheme, "chosen as a skin, it draws the same");
      ok(drawn({ GAMEBAR_THEME: "fixture", GAMEBAR_PRESET: path.join(DOOM_PRESETS, "full.toml") }) === viaTheme,
        "a game that reads no presets is not swayed by GAMEBAR_PRESET");
      ok(currentTheme({ GAMEBAR_THEME: "fixture" }) === "fixture", "the current theme can be the registered game");
    });
    ok(GAMES.map((g) => g.name).join(",") === "doom,minecraft", "taking the entry out leaves the production list as it was");
    ok(render(s, { GAMEBAR_THEME: "doom" }).includes("MODEL"), "with the fixture gone, doom draws its boxes again");
  }

  // The preset decides the layout, not the theme: a preset of one game named through GAMEBAR_PRESET
  // under the other game's theme renders as it always did.
  {
    const s = session("cross");
    const over = { COLUMNS: "160", GAMEBAR_INDENT: "4" };
    const minecraft = render(s, { ...over, GAMEBAR_THEME: "minecraft" });
    ok(minecraft.includes("━") && !minecraft.includes("MODEL"), "the minecraft theme draws the hotbar");
    ok(render(s, { ...over, GAMEBAR_THEME: "doom", GAMEBAR_PRESET: path.join(ROOT, "src", "games", "minecraft", "presets", "minecraft.toml") }) === minecraft,
      "theme doom with the minecraft preset in GAMEBAR_PRESET draws the same hotbar");
    ok(render(s, { ...over, GAMEBAR_THEME: "doom", GAMEBAR_PRESET: path.join(ROOT, "presets", "minecraft.toml") }) === minecraft,
      "and so does the old path to the minecraft preset");
    ok(render(s, { ...over, GAMEBAR_THEME: "minecraft", GAMEBAR_PRESET: path.join(DOOM_PRESETS, "full.toml") }) === minecraft,
      "theme minecraft ignores a DOOM preset in GAMEBAR_PRESET");
  }

  // The glyph test card's sample: the first registered game that has one.
  {
    const doomSample = sampleImage();
    ok(doomSample && existsSync(doomSample) && path.basename(doomSample) === "STFST01.png",
      "the test card's sample is the DOOM idle mugshot, and it exists");
    const first = withGame(readGame(FIXTURE_DIR), () => sampleImage(), { first: true });
    ok(first === doomSample, "with a game that has no sample registered first, the card still finds DOOM's");
  }

  // Preset paths written before the presets moved: <root>/presets/<name>.toml.
  {
    const oldFull = path.join(ROOT, "presets", "full.toml");
    const newFull = path.join(DOOM_PRESETS, "full.toml");
    ok(!existsSync(oldFull), "the old preset path no longer exists (the checks below can fail)");
    ok(presetFile(oldFull) === newFull, "an old path to a registered preset resolves to its new file");
    ok(presetFile(newFull) === newFull, "a path that exists is used as is");
    const missing = path.join(SB, "missing.toml");
    ok(presetFile(missing) === missing, "a missing file no game registers stays as it is (and fails to load)");
    const elsewhere = path.join(SB, "full.toml");
    ok(!existsSync(elsewhere) && presetFile(elsewhere) === elsewhere,
      "a missing full.toml outside the old presets folder stays as it is, not swapped for the bundled one");
    const s = session("old-path");
    for (const cols of ["250", "120", "90"]) {
      const viaOld = render(s, { GAMEBAR_THEME: "doom", GAMEBAR_PRESET: oldFull, COLUMNS: cols });
      const viaNew = render(s, { GAMEBAR_THEME: "doom", GAMEBAR_PRESET: newFull, COLUMNS: cols });
      ok(viaOld === viaNew && viaOld.includes("MODEL"), `at ${cols} columns the old path draws DOOM full exactly like the new one`);
    }
    // At 90 columns full does not fit: the fallback chain loads standard (and minimal) beside the
    // file actually loaded. A copy of full.toml alone in a folder has no chain to fall back on.
    const lone = path.join(SB, "lone");
    mkdirSync(lone);
    copyFileSync(newFull, path.join(lone, "full.toml"));
    const narrow = render(s, { GAMEBAR_THEME: "doom", GAMEBAR_PRESET: oldFull, COLUMNS: "90" });
    ok(narrow !== render(s, { GAMEBAR_THEME: "doom", GAMEBAR_PRESET: path.join(lone, "full.toml"), COLUMNS: "90" }),
      "the narrow render really fell back to a sibling preset, found beside the redirected file");
    ok(narrow === render(s, { GAMEBAR_THEME: "doom", GAMEBAR_PRESET: path.join(ROOT, "presets", "standard.toml"), COLUMNS: "90" })
      || narrow === render(s, { GAMEBAR_THEME: "doom", GAMEBAR_PRESET: path.join(DOOM_PRESETS, "minimal.toml"), COLUMNS: "90" }),
      "and it draws what that sibling draws on its own");
  }
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
