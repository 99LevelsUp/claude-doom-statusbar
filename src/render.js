// Render one session's bar: load the preset, collect the metric values, build the session's
// reaction and the lines. Used by the one-shot status line (statusline.js) and the render daemon.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { buildBar, mugshotFace } from "./games/doom/layout.js";
import { renderContext } from "./kit/context.js";
import { resolvePreset } from "./kit/planner.js";
import { rgbOf } from "./kit/meters.js";
import { effectiveStep } from "./kit/raster/glyph-level.js";
import { currentTheme, themePreset } from "./theme.js";
import { buildHotbar } from "./games/minecraft/layout.js";
import { PACKAGE_ROOT } from "./package-root.js";
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

  // A non-DOOM theme (see theme.js) swaps in its own preset; doom keeps DOOMBAR_PRESET.
  const preset = themePreset(currentTheme(env))
    || env.DOOMBAR_PRESET || path.join(PACKAGE_ROOT, "presets", "standard.toml");
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
  const ctx = renderContext({
    values, reaction, now,
    tick: Math.floor(now), // one marquee step per refresh (~1s); pure fn of time
    step: effectiveStep(env, mugshot.glyphs),
    background: rgbOf(mugshot.background ?? "#000000"),
  });

  const target = parseInt(env.COLUMNS || "100", 10);
  // The in-game HUD layout (minecraft theme) draws its own screen instead of boxes.
  if ((cfg.bar || {}).layout === "hotbar") {
    const { lines } = buildHotbar(cfg, target, ctx, {
      indent: Number(env.DOOMBAR_INDENT ?? 2), // Claude Code draws the status line 2 cols in
    });
    return lines;
  }
  // Pick the preset that fits the terminal: the chosen preset is the ceiling; if it
  // (at its minimum scale) overflows COLUMNS, fall back down its [bar].fallback chain.
  // Sibling presets resolve relative to the chosen preset's directory.
  const presetDir = path.dirname(preset);
  const loadByName = (name) => {
    try { return loadPreset(path.join(presetDir, `${name}.toml`)); }
    catch { return null; }
  };
  const selected = resolvePreset(ctx, cfg, target, loadByName, mugshotFace(ctx));
  // Text overflow behavior: env wins, then the picked preset's text_overflow, then the chosen
  // one's, default "scroll". It depends on the pick, so the build gets a copy of the context
  // that carries it; the context the planner used stays as it was.
  const overflow = env.DOOMBAR_TEXT_OVERFLOW || selected.text_overflow || cfg.text_overflow || "scroll";
  return buildBar(selected, target, { ...ctx, overflow }).lines;
}
