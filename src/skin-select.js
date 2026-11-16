// Which skin a session draws, read on every render. In order:
//   1. the session's own GAMEBAR_SKIN (forwarded per session by the client, like GAMEBAR_THEME);
//   2. the saved choice, skin.json in the user directory (`claude-game-bar skin <name>`);
//   3. the choice a release before skins left behind: the theme (GAMEBAR_THEME, then the saved
//      theme file) picks the game, and that game's default skin is drawn;
//   4. the default game's default skin (src/games/index.js).
// A preset setting (GAMEBAR_PRESET), as installs before skins wrote it, keeps choosing the size:
// when the session has no GAMEBAR_SKIN, the preset's file name picks the skin of that size of the
// chosen game, whether the game came from the saved choice or the theme, if the game reads presets
// (its manifest says which sizes it has). A file name such a game does not know is a preset the
// user wrote: those no longer draw, so the chosen skin is drawn with a warning naming the file.
//
// The user directory is ~/.claude/claude-game-bar/ (GAMEBAR_USER_DIR overrides it):
//   skin.json            the saved choice, { "skin": "<name>" }
//   skins/<name>/        a skin of the user's own: <name>.toml and its own assets
// A user skin never takes the name of a bundled skin; the bundled one is found first.
//
// A skin: { name, file, game, size, user }. `file` is null for a skin a bundled game names whose file
// it does not ship yet; `game` is the registry entry, null for a user skin; `size` the preset name
// whose skin it is, or null. selectSkin adds `source` ("session", "saved", "preset" when a preset
// changed the saved skin's size, "legacy" for steps 3 and 4) and the `warnings` of the selection, in
// the form the warning line takes (src/kit/skin/warnings.js).

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findGame, defaultGame, bundledSkins } from "./games/index.js";
import { currentTheme } from "./theme.js";
import { envGet } from "./platform/env.js";

export const userDir = (env = process.env) =>
  envGet("USER_DIR", env) || path.join(os.homedir(), ".claude", "claude-game-bar");
export const savedSkinFile = (env = process.env) => path.join(userDir(env), "skin.json");
const userSkinsDir = (env) => path.join(userDir(env), "skins");

// A skin name is one plain word of a file name, never a path.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const validName = (name) => typeof name === "string" && NAME.test(name);

export function savedSkin(env = process.env) {
  try {
    const s = JSON.parse(readFileSync(savedSkinFile(env), "utf8")).skin;
    return validName(s) ? s : null;
  } catch { return null; }
}

export function saveSkin(name, env = process.env) {
  const file = savedSkinFile(env);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ skin: name }) + "\n");
}

export function clearSkin(env = process.env) {
  rmSync(savedSkinFile(env), { force: true });
}

const sizeOf = (game, name) => Object.keys(game.presetSkins).find((k) => game.presetSkins[k] === name) ?? null;
const bundled = (s) => ({ name: s.name, file: s.file, game: s.game, size: sizeOf(s.game, s.name), user: false });

// The user's own skins, sorted by name.
export function userSkins(env = process.env) {
  let names;
  try {
    names = readdirSync(userSkinsDir(env), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; }
  const taken = new Set(bundledSkins().map((s) => s.name));
  return names.filter((n) => validName(n) && !taken.has(n)).map((n) => userSkin(n, env)).filter(Boolean);
}

function userSkin(name, env) {
  const file = path.join(userSkinsDir(env), name, `${name}.toml`);
  return existsSync(file) ? { name, file, game: null, size: null, user: true } : null;
}

// Every skin the user can choose: the bundled ones in registry order, then the user's.
export const listSkins = (env = process.env) => [...bundledSkins().map(bundled), ...userSkins(env)];

// The skin called `name`: a bundled skin, else a user skin, else the default skin of the game (or
// old theme name) `name`. Null when there is none.
export function findSkin(name, env = process.env) {
  if (!validName(name)) return null;
  const b = bundledSkins().find((s) => s.name === name);
  if (b) return bundled(b);
  const own = userSkin(name, env);
  if (own) return own;
  const game = findGame(name);
  return game ? findSkin(game.defaultSkin, env) : null;
}

// The skin after `name` in listSkins order, wrapping; the first skin when `name` is not listed.
export function nextSkin(name, env = process.env) {
  const names = listSkins(env).map((s) => s.name);
  return names[(names.indexOf(name) + 1) % names.length];
}

const warning = (cause, subject, message) => ({ key: `selection|${cause}|${subject}`, cause, skin: null, element: null, subject, message });

// The skin this session draws (see the top of this file).
export function selectSkin(env = process.env) {
  const warnings = [];
  const preset = envGet("PRESET", env) || "";
  const pick = (skin, source) => ({ ...skin, source, warnings });
  // `skin` at the size the preset setting names, when its game reads presets.
  const sized = (skin) => {
    const game = skin.game;
    if (!preset || !game || !game.readsPresets) return skin;
    const size = preset.split(/[\\/]/).pop().replace(/\.toml$/, "");
    const other = Object.hasOwn(game.presetSkins, size) ? findSkin(game.presetSkins[size], env) : null;
    if (other) return other;
    warnings.push(warning("old-preset", preset,
      `the preset ${preset} no longer draws (rebuild it as a skin); drawing ${skin.name}`));
    return skin;
  };

  const asked = envGet("SKIN", env);
  if (asked) {
    const skin = findSkin(asked, env);
    if (skin) return pick(skin, "session");
    warnings.push(warning("unknown-skin", asked, `no skin is called ${asked} (GAMEBAR_SKIN)`));
  }
  const saved = savedSkin(env);
  if (saved) {
    const skin = findSkin(saved, env);
    if (skin) {
      const s = sized(skin);
      return pick(s, s === skin ? "saved" : "preset");
    }
    warnings.push(warning("unknown-skin", saved, `no skin is called ${saved} (the saved skin)`));
  }
  const game = findGame(currentTheme(env)) || defaultGame();
  return pick(sized(findSkin(game.defaultSkin, env)), "legacy");
}
