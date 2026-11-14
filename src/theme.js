// Themes: which game the HUD dresses up as. Switched live with
//   claude-doom-statusbar theme <doom|minecraft|next>
//
// The choice lives in a tiny JSON file the statusline reads on every render, so a switch
// shows up on the next refresh (about a second), with no restart and no settings.json edit.
// The themes are the games in the registry (src/games/index.js), in its order. The default game
// is the default theme; a game that uses the preset setting follows DOOMBAR_PRESET, so the
// installer's --preset choice keeps working exactly as before.

import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GAMES, findGame, defaultGame } from "./games/index.js";

const gameNamed = (theme) => GAMES.find((g) => g.name === theme);

// theme -> preset file name (null = follow DOOMBAR_PRESET), plus a one-line blurb for the CLI.
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

export const themeFile = (env = process.env) =>
  env.DOOMBAR_THEME_FILE || path.join(os.homedir(), ".claude", "doombar-theme.json");

// Current theme: $DOOMBAR_THEME wins (handy for a one-off), then the saved file, then the default
// game. Anything unknown or unreadable falls back to the default, so a bad file can never blank the HUD.
export function currentTheme(env = process.env) {
  let t = env.DOOMBAR_THEME;
  if (!t) {
    try { t = JSON.parse(readFileSync(themeFile(env), "utf8")).theme; } catch { t = null; }
  }
  return resolveTheme(t) || defaultGame().name;
}

// The preset file to render for `theme`, or null to keep the caller's default (DOOMBAR_PRESET).
export function themePreset(theme) {
  const g = gameNamed(theme);
  return g && !g.usesPresetSetting ? g.presets[g.defaultPreset] : null;
}

// The preset file `theme` renders when nothing else names one.
export function defaultPreset(theme) {
  const g = gameNamed(theme) || defaultGame();
  return g.presets[g.defaultPreset];
}

export function saveTheme(theme) {
  const p = themeFile();
  if (theme === defaultGame().name) { rmSync(p, { force: true }); return; } // default -> no file at all
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ theme }) + "\n");
}

export function nextTheme(theme) {
  const names = GAMES.map((g) => g.name);
  return names[(names.indexOf(theme) + 1) % names.length];
}
