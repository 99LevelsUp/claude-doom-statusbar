// Render one session's bar. The skin selection (src/skin-select.js) names the skin; a skin with a
// file is loaded, fitted to the width and drawn (src/kit/skin/), with a warning line under it while
// any part of it needs the user's attention. A skin a game names but does not ship a file for yet
// is drawn the old way: its game's layout from the game registry (src/games/index.js) draws a preset.
// Used by the one-shot status line (statusline.js) and the render daemon.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { renderContext } from "./kit/context.js";
import { rgbOf } from "./kit/meters.js";
import { effectiveStep } from "./kit/raster/glyph-level.js";
import { loadSkin } from "./kit/skin/load.js";
import { fitSkin } from "./kit/skin/fit.js";
import { drawFit } from "./kit/skin/draw.js";
import { warningLine, memoryStore } from "./kit/skin/warnings.js";
import { currentTheme, themePreset, defaultPreset } from "./theme.js";
import { layoutFor, presetFile, defaultGame } from "./games/index.js";
import { selectSkin, findSkin } from "./skin-select.js";
import { collectValues } from "./metrics/index.js";
import { buildReaction } from "./metrics/reaction.js";
import { envGet } from "./platform/env.js";

// When each warning first appeared, for as long as this process lives: the render daemon's store.
// The one-shot status line, a new process every render, passes a store kept in a file instead.
const processStore = memoryStore();

// Parsed presets by file path, re-parsed when the file's mtime or size changes. The builders
// never modify a preset, so one parse serves every render.
const presetCache = new Map();
function loadPreset(file) {
  let st;
  try { st = statSync(file); } catch { return parseToml(readFileSync(file, "utf8")); }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = presetCache.get(file);
  if (hit && hit.key === key) return hit.cfg;
  const cfg = parseToml(readFileSync(file, "utf8"));
  presetCache.set(file, { key, cfg });
  return cfg;
}

// The session's metric values and its reaction.
function sessionValues(data, env, now) {
  const { values, st, god_until } = collectValues(data, env, now);

  let exhausted;
  if ("ratelimit.5h" in values || "ratelimit.7d" in values) {
    const rem = Math.min(
      100 - (values["ratelimit.5h"] || 0),
      "ratelimit.7d" in values ? 100 - values["ratelimit.7d"] : 100,
    );
    exhausted = rem <= 0;
  } else {
    exhausted = (values["context.hp"] || 0) >= 99;
  }

  const reaction = buildReaction({ st, values, godUntil: god_until, exhausted, now });
  return { values, reaction };
}

const indentOf = (env) => Number(envGet("INDENT", env) ?? 2); // Claude Code draws the status line 2 cols in
const columnsOf = (env) => parseInt(env.COLUMNS || "100", 10);

// Returns the bar's lines, without trailing newlines. Everything about the session the drawing
// reads is built here for this render only, so sessions rendered in turn by the daemon never see
// each other's values or settings. `warningStore` keeps when each warning under the bar first
// appeared (src/kit/skin/warnings.js); by default this process's memory.
export function renderSession({ data, env = process.env, now = Date.now() / 1000, warningStore = processStore }) {
  // A shallow copy: the rate-limit merge in collectValues rewrites data.rate_limits, and a caller
  // that keeps the payload between renders must not see it change.
  if (data && typeof data === "object" && !Array.isArray(data)) data = { ...data };

  const selected = selectSkin(env);
  if (selected.file) {
    const lines = renderSkin(selected, data, env, now, warningStore);
    if (lines) return lines;
  }
  return renderPreset(selected, data, env, now);
}

// The selected skin, fitted and drawn, or null when nothing of it (nor of the default skin) can be
// drawn. Scripts and assets are not run or resolved here yet: every element draws its default.
function renderSkin(selected, data, env, now, warningStore) {
  const fallback = findSkin(defaultGame().defaultSkin, env)?.file || null;
  const loaded = loadSkin(selected.file, { fallback: fallback !== selected.file ? fallback : null });
  if (!loaded.skin) return null;
  const warnings = [...selected.warnings, ...loaded.warnings];
  const { values, reaction } = sessionValues(data, env, now);
  const width = Math.max(0, columnsOf(env) - indentOf(env));
  const loadSmaller = (name) => {
    const s = findSkin(name, env);
    if (!s || !s.file) {
      warnings.push({ key: `selection|smaller|${name}`, cause: "unknown-smaller", skin: loaded.skin.file, element: null,
        subject: name, message: `no skin is called ${name} (the smaller skin of ${loaded.skin.name})` });
      return null;
    }
    const r = loadSkin(s.file);
    warnings.push(...r.warnings);
    return r.skin;
  };
  const fit = fitSkin(loaded.skin, { values, width, loadSmaller });
  warnings.push(...fit.warnings);
  const ctx = { tick: Math.floor(now), step: effectiveStep(env), resolveAsset: () => null, reaction, now };
  const lines = drawFit(fit, { values, width, ctx, scripts: {} });
  const line = warningLine(warnings, { store: warningStore, now, width });
  return line ? [...lines, line] : lines;
}

// The old way: a game's layout draws a preset. A skin chosen by name (the session's or the saved
// one) draws its game's preset of the skin's size. A skin the theme and the preset setting chose
// draws exactly what they drew before skins: the theme's own preset, else the preset setting, else
// the theme's default preset.
function renderPreset(selected, data, env, now) {
  const chosen = selected.source !== "legacy" && selected.game;
  const theme = chosen ? selected.game.name : currentTheme(env);
  // A path that no longer exists but names a registered preset (an installation from before the
  // presets moved into their games) loads the registered file.
  const named = chosen ? selected.game.presets[selected.size] : envGet("PRESET", env);
  const preset = presetFile(themePreset(theme) || named || defaultPreset(theme));
  // A preset that does not exist draws one line naming it, in the bar where the user looks, not
  // an ENOENT stack on stderr that Claude Code never shows.
  let cfg;
  try { cfg = loadPreset(preset); } catch (e) {
    if (e?.code === "ENOENT") return [`gamebar: preset not found: ${preset}`];
    throw e;
  }

  const { values, reaction } = sessionValues(data, env, now);

  // The face settings come from the chosen preset's [mugshot]: the glyph step this session's
  // terminal allows, and the background transparent face areas are fitted against.
  const mugshot = cfg.mugshot || {};
  // Sibling presets (the narrow-width fallback chain) resolve in the folder of the file actually
  // loaded, so an old path redirected above finds them beside the registered one.
  const presetDir = path.dirname(preset);
  const ctx = renderContext({
    values, reaction, now,
    tick: Math.floor(now), // one marquee step per refresh (~1s); pure fn of time
    step: effectiveStep(env, mugshot.glyphs),
    background: rgbOf(mugshot.background ?? "#000000"),
    overflow: envGet("TEXT_OVERFLOW", env) || undefined, // set: wins over the presets' text_overflow
    indent: indentOf(env),
    presetByName: (name) => {
      try { return loadPreset(path.join(presetDir, `${name}.toml`)); }
      catch { return null; }
    },
  });

  // The preset's [bar] layout picks the drawing function through the game registry.
  return layoutFor(cfg)(cfg, columnsOf(env), ctx);
}
