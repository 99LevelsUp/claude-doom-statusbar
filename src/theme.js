// Themes: which game the HUD dresses up as. Switched live with
//   claude-game-bar theme <name|next>
// The theme is the choice releases before skins saved. A chosen skin (src/skin-select.js) wins over
// it; while none is chosen, the theme picks the game whose default skin is drawn.
//
// The choice lives in a tiny JSON file the statusline reads on every render, so a switch
// shows up on the next refresh (about a second), with no restart and no settings.json edit.
// The themes are the games in the registry (src/games/index.js), in its order. The default game
// is the default theme; a game that uses the preset setting follows GAMEBAR_PRESET, so the
// installer's --preset choice keeps working exactly as before.

import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GAMES, findGame, defaultGame } from "./games/index.js";
import { envGet } from "./platform/env.js";

const gameNamed = (theme) => GAMES.find((g) => g.name === theme);

// theme -> preset file name (null = follow GAMEBAR_PRESET), plus a one-line blurb for the CLI.
// Taken from the registry when this module loads; the functions below read the registry live.
export const THEMES = Object.fromEntries(GAMES.map((g) => [g.name, {
  preset: g.usesPresetSetting ? null : path.basename(g.presets[g.defaultPreset]),
  about: g.about,
}]));
export const THEME_NAMES = Object.keys(THEMES);

// Canonical theme name for `name` (old names, such as 0.12.x's "minecraft-hud", resolved), or null
// if there's no such theme.
export function resolveTheme(name) {
  const g = findGame(name);
  return g ? g.name : null;
}

// The saved choice: GAMEBAR_THEME_FILE when set, else ~/.claude/gamebar-theme.json.
export const themeFile = (env = process.env) =>
  envGet("THEME_FILE", env) || path.join(os.homedir(), ".claude", "gamebar-theme.json");

// The file a release before 1.0.0 saved the choice in, read while the new one is missing. Only
// for the default place: a file named by GAMEBAR_THEME_FILE (or its old name) is the only one.
export const oldThemeFile = (env = process.env) =>
  envGet("THEME_FILE", env) ? null : path.join(os.homedir(), ".claude", "doombar-theme.json");

function savedTheme(env) {
  const read = (file) => JSON.parse(readFileSync(file, "utf8")).theme;
  try { return read(themeFile(env)); } catch (e) {
    const old = oldThemeFile(env);
    if (!e || e.code !== "ENOENT" || !old) return null;
  }
  try { return read(oldThemeFile(env)); } catch { return null; }
}

// Current theme: $GAMEBAR_THEME wins (handy for a one-off), then the saved file, then the default
// game. Anything unknown or unreadable falls back to the default, so a bad file can never blank the HUD.
export function currentTheme(env = process.env) {
  let t = envGet("THEME", env);
  if (!t) t = savedTheme(env);
  return resolveTheme(t) || defaultGame().name;
}

// The preset file to render for `theme`, or null to keep the caller's default (GAMEBAR_PRESET).
export function themePreset(theme) {
  const g = gameNamed(theme);
  return g && !g.usesPresetSetting ? g.presets[g.defaultPreset] : null;
}

// The preset file `theme` renders when nothing else names one.
export function defaultPreset(theme) {
  const g = gameNamed(theme) || defaultGame();
  return g.presets[g.defaultPreset];
}

// The old theme file is not removed here: the old package may still run (`install --keep-old`, or
// an install into a project's settings) and read it. It goes only where the old package goes, with
// removeOldThemeFile. While the new file exists the old one is never read.

// Forget the saved choice, so the default game is the theme again (unless an old file is read in
// place of the missing new one: then the default has to be saved, see saveTheme).
export function clearTheme(env = process.env) {
  rmSync(themeFile(env), { force: true });
}

// Removes the theme file a release before 1.0.0 saved: in `uninstall`, and once `install` has
// removed the old package.
export function removeOldThemeFile(env = process.env) {
  const old = oldThemeFile(env);
  if (old) rmSync(old, { force: true });
}

// Saves `theme`. The default theme is no file at all, except while an old theme file exists: that
// file would be read in place of the missing new one, so the default is written to the new file.
export function saveTheme(theme, env = process.env) {
  const old = oldThemeFile(env);
  if (theme === defaultGame().name && !(old && existsSync(old))) { clearTheme(env); return; }
  const p = themeFile(env);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ theme }) + "\n");
}

// The installer's move of a choice saved before 1.0.0: the old file's theme goes into the new file,
// even the default theme (the old file is still there). A new file that already exists wins and is
// not touched. An old file that cannot be read or names no theme is left as it is, and so is every
// old file (see removeOldThemeFile). Returns the theme moved, or null.
export function migrateTheme(env = process.env) {
  const old = oldThemeFile(env);
  if (!old || existsSync(themeFile(env))) return null;
  let theme;
  try { theme = JSON.parse(readFileSync(old, "utf8")).theme; } catch { return null; }
  const want = resolveTheme(theme);
  if (!want) return null;
  saveTheme(want, env);
  return want;
}

export function nextTheme(theme) {
  const names = GAMES.map((g) => g.name);
  return names[(names.indexOf(theme) + 1) % names.length];
}
