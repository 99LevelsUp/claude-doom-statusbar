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
// its file is missing; the bar then draws the default skin with a warning.
//
// An entry of the list:
//   name, description, about (the same blurb), aliases, default, dir, defaultSkin, readsPresets,
//   presetSkins (preset name -> skin name), assets, skins ([{ name, file | null }], in the order
//   the manifest names them, then the other skin files)
//   usesPresetSetting  the same as readsPresets
//   presets            preset name -> absolute path of its .toml file in the game's presets/, where
//                      an installer before skins pointed the preset setting; no game ships these
//                      files any more, the paths only recognise the old settings
//   defaultPreset      the first preset the manifest names
//
// The list is plain data. A test may add an entry (readGame of a folder of its own) and take it out
// again; the lookups below read the list each time they are called.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { SRC_DIR } from "../package-root.js";

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

// The registry entry for the game folder `dir`, read from its game.toml.
export function readGame(dir) {
  const m = parseToml(readFileSync(path.join(dir, "game.toml"), "utf8"));
  const legacy = m.legacy || {};
  const presetSkins = { ...(legacy.presets || {}) };
  const presets = Object.fromEntries(Object.keys(presetSkins).map((n) => [n, path.join(dir, "presets", `${n}.toml`)]));
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
    defaultPreset: Object.keys(presets)[0] ?? null,
  };
}

const GAMES_DIR = path.join(SRC_DIR, "games");
export const GAMES = readdirSync(GAMES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(path.join(GAMES_DIR, e.name, "game.toml")))
  .map((e) => e.name)
  .sort()
  .map((n) => readGame(path.join(GAMES_DIR, n)));

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

// The registered preset with this file name ("full.toml"), from any game, or null: where the
// installer of a release before skins pointed the preset setting.
export function registeredPreset(fileName) {
  const m = /^(.+)\.toml$/.exec(fileName);
  if (!m) return null;
  const g = GAMES.find((game) => Object.hasOwn(game.presets, m[1]));
  return g ? g.presets[m[1]] : null;
}
