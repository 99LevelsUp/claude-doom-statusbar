// The game registry: every game the bar can dress up as, in one list. A game is a folder under
// src/games/ with a manifest, game.toml, and its bundled skins in skins/*.toml. The registry finds
// the folders itself, so adding a game changes nothing outside its folder. The rest of the code
// reaches a game only through this list. Its order (the folders' names, sorted) is the order
// `theme next` and `skin next` cycle through.
//
// A manifest (game.toml):
//   name          the game's name, also its theme name (`claude-game-bar theme <name>`)
//   description   a one-line blurb for the theme and skin lists
//   default       true for the game drawn when nothing is chosen (one game)
//   default_skin  the skin drawn when the game is chosen without a skin
//   [legacy]      what a release before skins saved:
//     aliases        older theme names that still choose this game
//     reads_presets  the file name of the preset setting (GAMEBAR_PRESET) picks the size; a game
//                    that does not read presets draws its default skin whatever the preset is
//     presets        preset file name (without .toml) -> the skin of that size
//   [assets]      the npm package of the game's assets: package, version (pinned), integrity
//
// A bundled skin's name is the `name` its file gives, else the file name without .toml. A skin the
// manifest names (its default skin and the skins of its presets) is a skin of the game even while
// its file is missing: the bar then draws the game's old layout and preset in its place.
//
// An entry of the list:
//   name, description, about (the same blurb), aliases, default, dir, defaultSkin, readsPresets,
//   presetSkins (preset name -> skin name), assets, skins ([{ name, file | null }], in the order
//   the manifest names them, then the other skin files)
// and, while a game still draws with its old layout:
//   usesPresetSetting  the same as readsPresets
//   presets            preset name -> absolute path of its .toml file in the game's presets/
//   defaultPreset      the preset the old layout renders when the preset setting names none
//   layoutKey          the preset [bar] layout value that selects this game's layout
//   layout             (cfg, target, ctx) -> lines, from a parsed preset, the target width and the
//                      render context (src/kit/context.js)
//   sample             optional image the glyph test card draws at every glyph step
//
// The list is plain data. A test may add an entry (readGame of a folder of its own) and take it out
// again; the lookups below read the list each time they are called.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { PACKAGE_ROOT, SRC_DIR } from "../package-root.js";
import { doomLayout } from "./doom/layout.js";
import { IDLE_FACE } from "./doom/face.js";
import { minecraftLayout } from "./minecraft/layout.js";

// The code the bundled games still draw with, by folder name, until their skins replace it.
const OLD_LAYOUTS = {
  doom: { layoutKey: "boxes", layout: doomLayout, defaultPreset: "standard", sample: IDLE_FACE },
  minecraft: { layoutKey: "hotbar", layout: minecraftLayout, defaultPreset: "minecraft" },
};

// The bundled skin files of a game folder, sorted by file name: [{ name, file }].
function skinFiles(dir) {
  const skinsDir = path.join(dir, "skins");
  let names;
  try { names = readdirSync(skinsDir).filter((n) => n.endsWith(".toml")).sort(); } catch { return []; }
  return names.map((n) => {
    const file = path.join(skinsDir, n);
    let name = null;
    try { name = parseToml(readFileSync(file, "utf8")).name; } catch { /* the loader reports it when drawn */ }
    return { name: typeof name === "string" && name ? name : n.slice(0, -".toml".length), file };
  });
}

// The registry entry for the game folder `dir`, read from its game.toml. `old` is the old layout
// the game still draws with, if any.
export function readGame(dir, old = {}) {
  const m = parseToml(readFileSync(path.join(dir, "game.toml"), "utf8"));
  const legacy = m.legacy || {};
  const presetSkins = { ...(legacy.presets || {}) };
  const presets = Object.fromEntries(Object.keys(presetSkins)
    .map((n) => [n, path.join(dir, "presets", `${n}.toml`)])
    .filter(([, f]) => existsSync(f)));
  const files = skinFiles(dir);
  const names = [...new Set([...Object.values(presetSkins), m.default_skin, ...files.map((f) => f.name)])]
    .filter((n) => typeof n === "string" && n);
  const readsPresets = legacy.reads_presets === true;
  return {
    name: m.name,
    description: m.description || "",
    about: m.description || "",
    aliases: [...(legacy.aliases || [])],
    default: m.default === true,
    dir,
    defaultSkin: m.default_skin,
    readsPresets,
    presetSkins,
    assets: m.assets ? { package: m.assets.package, version: m.assets.version, integrity: m.assets.integrity } : null,
    skins: names.map((name) => ({ name, file: (files.find((f) => f.name === name) || {}).file || null })),
    usesPresetSetting: readsPresets,
    presets,
    defaultPreset: old.defaultPreset ?? Object.keys(presets)[0] ?? null,
    layoutKey: old.layoutKey ?? null,
    layout: old.layout ?? null,
    sample: old.sample ?? null,
  };
}

const GAMES_DIR = path.join(SRC_DIR, "games");
export const GAMES = readdirSync(GAMES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(path.join(GAMES_DIR, e.name, "game.toml")))
  .map((e) => e.name)
  .sort()
  .map((n) => readGame(path.join(GAMES_DIR, n), OLD_LAYOUTS[n]));

// The game called `name` or one of its aliases, or null.
export const findGame = (name) =>
  GAMES.find((g) => g.name === name || (g.aliases || []).includes(name)) || null;

export const defaultGame = () => GAMES.find((g) => g.default) || GAMES[0];

// Every game name and older theme name the registry knows.
export const gameNames = () => GAMES.flatMap((g) => [g.name, ...(g.aliases || [])]);

// Every bundled skin, game by game in registry order: [{ name, file | null, game }]. A name two
// games give is the first game's.
export function bundledSkins() {
  const seen = new Set();
  return GAMES.flatMap((game) => game.skins
    .filter((s) => !seen.has(s.name) && seen.add(s.name))
    .map((s) => ({ ...s, game })));
}

// The drawing function for a parsed preset: the game whose layoutKey its [bar] layout names, else
// the default game's.
export function layoutFor(cfg) {
  const key = (cfg.bar || {}).layout;
  return (GAMES.find((g) => g.layoutKey && g.layoutKey === key) || defaultGame()).layout;
}

// The registered preset with this file name ("full.toml"), from any game, or null.
export function registeredPreset(fileName) {
  const m = /^(.+)\.toml$/.exec(fileName);
  if (!m) return null;
  const g = GAMES.find((game) => Object.hasOwn(game.presets, m[1]));
  return g ? g.presets[m[1]] : null;
}

// Where the presets lived before they moved into their games. Installations made before the move
// still point there, at <root>/presets/<name>.toml.
const LEGACY_PRESETS = path.join(PACKAGE_ROOT, "presets");
const sameDir = (a, b) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);

// The file to load for a preset path. A path that exists is used as is. A missing one in the old
// presets folder whose file name is a registered preset loads the registered file. Anything else
// stays as it is, so a moved or deleted preset of the user's own fails to load as it always did
// instead of quietly drawing a bundled one.
export function presetFile(file) {
  if (existsSync(file)) return file;
  if (!sameDir(path.dirname(file), LEGACY_PRESETS)) return file;
  return registeredPreset(path.basename(file)) || file;
}

// The image the glyph test card draws: the first registered game's that has one, or null.
export const sampleImage = () => (GAMES.find((g) => g.sample) || {}).sample || null;
