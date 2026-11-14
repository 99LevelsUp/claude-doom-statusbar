// Render one session's bar: load the preset, collect the metric values, build the session's
// reaction and the lines, drawn by the layout the game registry (src/games/index.js) names for the
// preset. Used by the one-shot status line (statusline.js) and the render daemon.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { renderContext } from "./kit/context.js";
import { rgbOf } from "./kit/meters.js";
import { effectiveStep } from "./kit/raster/glyph-level.js";
import { currentTheme, themePreset, defaultPreset } from "./theme.js";
import { layoutFor, presetFile } from "./games/index.js";
import { collectValues } from "./metrics/index.js";
import { buildReaction } from "./metrics/reaction.js";

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

// Returns the bar's lines, without trailing newlines. Everything about the session the builders
// read travels in one render context (src/kit/context.js), built here for this render only, so
// sessions rendered in turn by the daemon never see each other's values or face settings.
export function renderSession({ data, env = process.env, now = Date.now() / 1000 }) {
  // A shallow copy: the rate-limit merge in collectValues rewrites data.rate_limits, and a caller
  // that keeps the payload between renders must not see it change.
  if (data && typeof data === "object" && !Array.isArray(data)) data = { ...data };

  // A theme with a preset of its own (see theme.js) swaps it in; the others follow DOOMBAR_PRESET,
  // then their default preset. A path that no longer exists but names a registered preset (an
  // installation from before the presets moved into their games) loads the registered file.
  const theme = currentTheme(env);
  const preset = presetFile(themePreset(theme) || env.DOOMBAR_PRESET || defaultPreset(theme));
  const cfg = loadPreset(preset);

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
    overflow: env.DOOMBAR_TEXT_OVERFLOW || undefined, // set: wins over the presets' text_overflow
    indent: Number(env.DOOMBAR_INDENT ?? 2), // Claude Code draws the status line 2 cols in
    presetByName: (name) => {
      try { return loadPreset(path.join(presetDir, `${name}.toml`)); }
      catch { return null; }
    },
  });

  const target = parseInt(env.COLUMNS || "100", 10);
  // The preset's [bar] layout picks the drawing function through the game registry.
  return layoutFor(cfg)(cfg, target, ctx);
}
