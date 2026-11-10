// Themes: which game the HUD dresses up as. Switched live with
//   claude-doom-statusbar theme <doom|minecraft|next>
//
// The choice lives in a tiny JSON file the statusline reads on every render, so a switch
// shows up on the next refresh (about a second), with no restart and no settings.json edit.
// "doom" is the default and means "use DOOMBAR_PRESET" (full / standard / minimal), so the
// installer's --preset choice keeps working exactly as before.

import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// theme -> preset file (null = follow DOOMBAR_PRESET), plus a one-line blurb for the CLI.
export const THEMES = {
  doom: { preset: null, about: "DOOM (1993) HUD with the Doomguy mugshot" },
  minecraft: { preset: "minecraft.toml", about: "the in-game look: chat, hearts, hunger, XP bar and a 9-slot hotbar" },
};
export const THEME_NAMES = Object.keys(THEMES);

// Old names that still work. 0.12.x called the hotbar theme "minecraft-hud"; a saved
// choice (or a typed name) using it keeps landing on the same theme.
const ALIASES = { "minecraft-hud": "minecraft" };

// Canonical theme name for `name` (aliases resolved), or null if there's no such theme.
export function resolveTheme(name) {
  const t = ALIASES[name] || name;
  return THEME_NAMES.includes(t) ? t : null;
}

export const themeFile = (env = process.env) =>
  env.DOOMBAR_THEME_FILE || path.join(os.homedir(), ".claude", "doombar-theme.json");

// Current theme: $DOOMBAR_THEME wins (handy for a one-off), then the saved file, then doom.
// Anything unknown or unreadable falls back to doom, so a bad file can never blank the HUD.
// `env` is the session's environment (a long-lived renderer passes each session's own).
export function currentTheme(env = process.env) {
  let t = env.DOOMBAR_THEME;
  if (!t) {
    try { t = JSON.parse(readFileSync(themeFile(env), "utf8")).theme; } catch { t = null; }
  }
  return resolveTheme(t) || "doom";
}

// The preset file to render for `theme`, or null to keep the caller's default.
export function themePreset(theme) {
  const p = (THEMES[theme] || {}).preset;
  return p ? path.join(REPO, "presets", p) : null;
}

export function saveTheme(theme) {
  const p = themeFile();
  if (theme === "doom") { rmSync(p, { force: true }); return; } // default -> no file at all
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ theme }) + "\n");
}

export const nextTheme = (theme) => THEME_NAMES[(THEME_NAMES.indexOf(theme) + 1) % THEME_NAMES.length];
