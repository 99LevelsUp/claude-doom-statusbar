#!/usr/bin/env node
// The game registry (src/games/index.js): a game is a folder with a manifest (game.toml) and its
// skins, found by the registry itself.
//
// The fixture game in ./fixture-game is a manifest and one skin, data only. This test reads the
// folder into a registry entry, adds it to the registry's list and renders it through
// renderSession, the same call the one-shot status line and the render daemon make: nothing outside
// the fixture's folder is needed. It also pins the production list (themes cycle doom -> minecraft
// -> doom, the old minecraft-hud name still resolves, every manifest is complete, every game draws
// only its skins), and the preset paths written before skins and before the presets moved into
// their games.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const { GAMES, readGame, defaultGame, gameNames, skinName } = await import("../../src/games/index.js");
const { THEME_NAMES, nextTheme, resolveTheme, currentTheme } = await import("../../src/theme.js");
const { renderSession } = await import("../../src/render.js");
const { selectSkin } = await import("../../src/skin-select.js");
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
    ok(manifest.name === g.name && g.dir === dir && g.description.length > 0, `${g.name}: read from src/games/${g.name}/game.toml`);
    ok(g.skins.some((s) => s.name === g.defaultSkin) && Object.values(g.presetSkins).every((n) => g.skins.some((s) => s.name === n)),
      `${g.name}: its default skin and the skin of each preset are among its skins (${g.skins.map((s) => s.name).join(", ")})`);
    ok(g.assets && g.assets.package === `@claude-game-bar/${g.name}` && typeof g.assets.version === "string"
      && typeof g.assets.integrity === "string", `${g.name}: its asset package is @claude-game-bar/${g.name}, pinned`);
    const files = Object.values(g.presets);
    ok(files.length > 0 && files.every((f) => inside(dir, f)) && Object.keys(g.presets).every((n) => Object.hasOwn(g.presetSkins, n)),
      `${g.name}: each preset it names has its place inside src/games/${g.name}`);
    ok(g.skins.every((s) => s.file && existsSync(s.file)) && files.every((f) => !existsSync(f)) && Object.hasOwn(g.presets, g.defaultPreset),
      `${g.name}: it draws only its skins, every one a file, and ships no presets`);
    ok(!("layout" in g) && !("layoutKey" in g), `${g.name}: its entry names no layout`);
  }
  ok(GAMES.find((g) => g.name === "doom").readsPresets && !GAMES.find((g) => g.name === "minecraft").readsPresets,
    "doom reads the preset setting, minecraft does not");

  // A skin chosen by the session draws what the legacy preset setting of its size draws.
  {
    const s = session("by-name");
    const doom = GAMES.find((g) => g.name === "doom");
    for (const size of ["full", "standard", "minimal"]) {
      const skin = doom.presetSkins[size];
      ok(render(s, { GAMEBAR_SKIN: skin }) === render(s, { GAMEBAR_THEME: "doom", GAMEBAR_PRESET: doom.presets[size] }),
        `GAMEBAR_SKIN=${skin} draws what doom's ${size} preset setting draws`);
    }
    ok(render(s, { GAMEBAR_SKIN: "minecraft", GAMEBAR_THEME: "doom" }) === render(s, { GAMEBAR_THEME: "minecraft" }),
      "GAMEBAR_SKIN=minecraft draws the minecraft skin, whatever the theme");
  }

  // The fixture game: its own folder, data only, and it renders through renderSession.
  {
    const files = readdirSync(FIXTURE_DIR, { recursive: true }).map((f) => f.replace(/\\/g, "/")).sort();
    ok(files.join(",") === "game.toml,skins,skins/fixture.toml", `the fixture game is a manifest and one skin (${files.join(", ")})`);
    const FIXTURE_GAME = readGame(FIXTURE_DIR);
    ok(FIXTURE_GAME.skins.length === 1 && inside(FIXTURE_DIR, FIXTURE_GAME.skins[0].file) && !("layout" in FIXTURE_GAME),
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

  // A skin a manifest names but whose file is missing: the default skin is drawn, and a line under
  // the bar names the missing skin.
  {
    const dir = path.join(SB, "ghost-game");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "game.toml"), 'name = "ghostgame"\ndescription = "a game whose skin file is missing"\ndefault_skin = "ghost"\n');
    const s = session("ghost");
    withGame(readGame(dir), () => {
      const lines = strip(render(s, { GAMEBAR_SKIN: "ghost" })).split("\n");
      ok(lines[0].includes("MODEL") && lines.at(-1).trim().startsWith("gamebar:") && lines.at(-1).includes("ghost"),
        `GAMEBAR_SKIN=ghost, a skin without a file, draws doom-full with a line naming ghost (${lines.at(-1).trim()})`);
    });
  }

  // A bundled skin's name is read without parsing the whole file: the same name a full parse gives
  // (its `name` when that is a non-empty string, else the file name), for every skin file the
  // repository has and for the ways a name can be written.
  {
    const nameByParse = (file) => {
      let name = null;
      try { name = parseToml(readFileSync(file, "utf8")).name; } catch { /* the file name */ }
      return typeof name === "string" && name ? name : path.basename(file, ".toml");
    };
    const tomls = (dir) => readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f))
      .filter((f) => f.endsWith(".toml") && path.basename(path.dirname(f)) === "skins");
    const odd = path.join(SB, "odd-skins", "skins");
    mkdirSync(odd, { recursive: true });
    const written = {
      "escaped.toml": 'version = 1\nname = "a \\"quoted\\" name"\n[element.bar]\nkind = "row"\n',
      "literal.toml": "version = 1\nname = 'literal-name' # a comment\n",
      "quoted-key.toml": '"name" = "quoted-key"\n',
      "crlf.toml": '# a comment\r\nname = "crlf-name"\r\n[element.bar]\r\nkind = "row"\r\n',
      "in-table.toml": 'version = 1\n[element.bar]\nname = "not-the-skin"\n',
      "empty.toml": 'name = ""\n',
      "number.toml": "name = 3\n",
      "multiline.toml": 'description = """\n[not a table]\nname = "inside"\n"""\nname = "after-multiline"\n',
    };
    for (const [f, text] of Object.entries(written)) writeFileSync(path.join(odd, f), text);
    const files = [...tomls(path.join(ROOT, "src", "games")), ...tomls(path.join(ROOT, "test")), ...tomls(odd)];
    const differ = files.filter((f) => skinName(f) !== nameByParse(f)).map((f) => `${path.relative(ROOT, f)}: ${skinName(f)} != ${nameByParse(f)}`);
    ok(files.length >= 20 && differ.length === 0, `every skin's name is the one a full parse gives (${files.length} files${differ.length ? `; ${differ.join("; ")}` : ""})`);
  }

  // A game whose manifest has no [legacy] table (no presets at all) is all a new game needs: the
  // theme module, loaded while that game is registered, lists it and does not throw.
  {
    const dir = path.join(SB, "skin-era-game");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "game.toml"), 'name = "skinera"\ndescription = "a game with skins and no presets"\ndefault_skin = "skinera"\n');
    const entry = readGame(dir);
    GAMES.push(entry);
    let theme = null, threw = null;
    try {
      // A fresh copy of the theme module, evaluated while the game is in the shared registry.
      theme = await import(new URL("../../src/theme.js?no-legacy", import.meta.url).href);
    } catch (e) { threw = e; } finally { GAMES.splice(GAMES.indexOf(entry), 1); }
    ok(!threw && entry.defaultPreset === null, `loading the theme module with it registered does not throw${threw ? ` (${threw.message})` : ""}`);
    ok(theme && theme.THEME_NAMES.includes("skinera"), "and the game is one of the themes");
  }

  // A game that reads no presets follows its theme, whatever preset is set; a game that reads presets
  // takes only the preset names it declares, and any other preset (another game's, or one the user
  // wrote) no longer draws: its default skin is drawn with a line naming the preset.
  {
    const s = session("cross");
    const over = { COLUMNS: "160", GAMEBAR_INDENT: "4" };
    const minecraft = render(s, { ...over, GAMEBAR_THEME: "minecraft" });
    ok(minecraft.includes("━") && !minecraft.includes("MODEL"), "the minecraft theme draws the hotbar");
    for (const preset of [path.join(ROOT, "src", "games", "minecraft", "presets", "minecraft.toml"), path.join(ROOT, "presets", "minecraft.toml")]) {
      const env = { ...s.env, ...over, GAMEBAR_THEME: "doom", GAMEBAR_PRESET: preset };
      // The warning names the whole path; the line under the bar may cut a long checkout path at the
      // terminal's width, so the selection's own warning is checked for the name and the render for
      // the line.
      const sel = selectSkin(env);
      const lines = render(s, env).split("\n");
      ok(sel.name === "doom-full" && sel.warnings.some((w) => w.message.includes(preset) && w.message.includes("doom-full"))
        && strip(lines[0]).includes("MODEL") && strip(lines.at(-1)).trim().startsWith("gamebar:"),
        `theme doom with ${path.relative(ROOT, preset)} in GAMEBAR_PRESET draws doom-full and names the preset`);
    }
    ok(render(s, { ...over, GAMEBAR_THEME: "minecraft", GAMEBAR_PRESET: path.join(DOOM_PRESETS, "full.toml") }) === minecraft,
      "theme minecraft ignores a DOOM preset in GAMEBAR_PRESET");
  }

  // Preset paths written before the presets moved: <root>/presets/<name>.toml.
  {
    ok(!existsSync(path.join(ROOT, "presets")) && !existsSync(path.join(ROOT, "src", "games", "minecraft", "presets")),
      "no preset files are shipped, in the old folder or a game's");
    // DOOM's presets are gone; their file names still pick the size of a DOOM skin, from the old
    // folder and the later one alike.
    const oldFull = path.join(ROOT, "presets", "full.toml");
    const s = session("old-path");
    for (const cols of ["250", "120", "90"]) {
      const viaOld = render(s, { GAMEBAR_THEME: "doom", GAMEBAR_PRESET: oldFull, COLUMNS: cols });
      const viaNew = render(s, { GAMEBAR_THEME: "doom", GAMEBAR_PRESET: path.join(DOOM_PRESETS, "full.toml"), COLUMNS: cols });
      ok(viaOld === viaNew && viaOld === render(s, { GAMEBAR_SKIN: "doom-full", COLUMNS: cols }) && viaOld.includes("MODEL"),
        `at ${cols} columns the old path draws doom-full`);
    }
    // At 90 columns doom-full does not fit and goes down its smaller-skin chain.
    ok(render(s, { GAMEBAR_THEME: "doom", GAMEBAR_PRESET: oldFull, COLUMNS: "90" }) === render(s, { GAMEBAR_SKIN: "doom-minimal", COLUMNS: "90" }),
      "at 90 columns it draws what doom-minimal draws");
  }
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
