// Themes: which game the HUD dresses up as. Switched live with
//   claude-doom-statusbar theme <doom|minecraft|satisfactory|next>
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
  minecraft: { preset: "minecraft.toml", about: "hearts, hunger, XP and a blocky miner" },
  "minecraft-hud": { preset: "minecraft-hud.toml", about: "the in-game look: hearts, hunger, XP bar and a 9-slot hotbar" },
  satisfactory: { preset: "satisfactory.toml", about: "power grid, production and an engineer's helmet" },
};
export const THEME_NAMES = Object.keys(THEMES);

export const themeFile = () =>
  process.env.DOOMBAR_THEME_FILE || path.join(os.homedir(), ".claude", "doombar-theme.json");

// Current theme: $DOOMBAR_THEME wins (handy for a one-off), then the saved file, then doom.
// Anything unknown or unreadable falls back to doom, so a bad file can never blank the HUD.
export function currentTheme() {
  let t = process.env.DOOMBAR_THEME;
  if (!t) {
    try { t = JSON.parse(readFileSync(themeFile(), "utf8")).theme; } catch { t = null; }
  }
  return THEME_NAMES.includes(t) ? t : "doom";
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
