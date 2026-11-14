// The game registry: every game the bar can dress up as, in one list. A game is its folder under
// src/games/ (its layout, presets and assets) plus one entry here. The rest of the code reaches a
// game's code and files only through this list, so adding a game changes nothing outside those two
// places. The order is the order `theme next` cycles through.
//
// An entry:
//   name               the theme name (`claude-doom-statusbar theme <name>`)
//   about              a one-line blurb for the theme list
//   aliases            older names that still choose this game
//   default            the game used when no theme is chosen, or the chosen one is unknown; it also
//                      draws every preset whose [bar] layout no game claims
//   layoutKey          the preset [bar] layout value that selects this game's layout
//   layout             (cfg, target, ctx) -> lines: draws the bar from a parsed preset, the target
//                      width and the render context (src/kit/context.js)
//   presets            preset name -> absolute path of its .toml file
//   defaultPreset      the preset the theme renders
//   usesPresetSetting  the theme renders the user's preset setting (DOOMBAR_PRESET, written by
//                      `install --preset`) and its default preset only when that is unset
//   sample             optional image the glyph test card draws at every glyph step
//
// The list is plain data. A test may add an entry and take it out again; the lookups below read the
// list each time they are called.

import { existsSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT, SRC_DIR } from "../package-root.js";
import { doomLayout } from "./doom/layout.js";
import { ALPHA_DIR } from "./doom/face.js";
import { minecraftLayout } from "./minecraft/layout.js";

const gameDir = (name) => path.join(SRC_DIR, "games", name);
const presetsOf = (game, names) =>
  Object.fromEntries(names.map((n) => [n, path.join(gameDir(game), "presets", `${n}.toml`)]));

export const GAMES = [
  {
    name: "doom",
    about: "DOOM (1993) HUD with the Doomguy mugshot",
    aliases: [],
    default: true,
    layoutKey: "boxes",
    layout: doomLayout,
    presets: presetsOf("doom", ["full", "standard", "minimal"]),
    defaultPreset: "standard",
    usesPresetSetting: true,
    sample: path.join(ALPHA_DIR, "STFST01.png"), // the idle mugshot
  },
  {
    name: "minecraft",
    about: "the in-game look: chat, hearts, hunger, XP bar and a 9-slot hotbar",
    aliases: ["minecraft-hud"], // 0.12.x called this theme "minecraft-hud"
    layoutKey: "hotbar",
    layout: minecraftLayout,
    presets: presetsOf("minecraft", ["minecraft"]),
    defaultPreset: "minecraft",
  },
];

// The game called `name` or one of its aliases, or null.
export const findGame = (name) =>
  GAMES.find((g) => g.name === name || (g.aliases || []).includes(name)) || null;

export const defaultGame = () => GAMES.find((g) => g.default) || GAMES[0];

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
