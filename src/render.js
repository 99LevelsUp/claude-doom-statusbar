// Render one session's bar: load the preset, collect the metric values, pick the mugshot and
// build the lines. Used by the one-shot status line (statusline.js) and the render daemon.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { buildBar } from "./games/doom/layout.js";
import { setValues } from "./kit/values.js";
import { resolvePreset } from "./kit/planner.js";
import { rgbOf } from "./kit/meters.js";
import { setFaceOptions } from "./games/doom/face.js";
import { effectiveStep } from "./kit/raster/glyph-level.js";
import { currentTheme, themePreset } from "./theme.js";
import { buildHotbar } from "./games/minecraft/layout.js";
import { PACKAGE_ROOT } from "./package-root.js";
import { collectValues } from "./metrics/index.js";

const DECAY = 1.5; // seconds a reaction holds before relaxing to idle
const IDLE_CYCLE = 2; // seconds per idle glance

function _pick(bucket) {
  let x = Math.imul(bucket, 0x9e3779b1) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x85ebca77) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return x % 3;
}

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

// Returns the bar's lines, without trailing newlines. Sessions must render one at a time:
// kit/values.js keeps the values in one module-level slot (setValues).
export function renderSession({ data, env = process.env, now = Date.now() / 1000 }) {
  // A shallow copy: the rate-limit merge in collectValues rewrites data.rate_limits, and a caller
  // that keeps the payload between renders must not see it change.
  if (data && typeof data === "object" && !Array.isArray(data)) data = { ...data };

  // A non-DOOM theme (see theme.js) swaps in its own preset; doom keeps DOOMBAR_PRESET.
  const preset = themePreset(currentTheme(env))
    || env.DOOMBAR_PRESET || path.join(PACKAGE_ROOT, "presets", "standard.toml");
  const cfg = loadPreset(preset);

  const { values, st, god_until } = collectValues(data, env, now);
  // Right before the builders, which read these values: no other session's render may come
  // between this call and the bar it feeds. The face options are the same kind of slot: the glyph
  // step this session's terminal allows for the mugshot, and the background it is fitted against.
  setValues(values);
  const mugshot = cfg.mugshot || {};
  setFaceOptions({
    step: effectiveStep(env, mugshot.glyphs),
    background: rgbOf(mugshot.background ?? "#000000"),
  });

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

  const spriteFor = (hp) => {
    if (exhausted) return "STFDEAD0";
    if (now < god_until) return "STFGOD0";
    if (st.expr && now - (st.ts || 0) < DECAY) {
      const map = {
        ouch: `STFOUCH${hp}`, kill: `STFKILL${hp}`, evl: `STFEVL${hp}`,
        tl: `STFTL${hp}0`, tr: `STFTR${hp}0`,
      };
      return map[st.expr] || `STFST${hp}1`;
    }
    return `STFST${hp}${_pick(Math.floor(now / IDLE_CYCLE))}`;
  };

  const target = parseInt(env.COLUMNS || "100", 10);
  // The in-game HUD layout (minecraft theme) draws its own screen instead of boxes.
  if ((cfg.bar || {}).layout === "hotbar") {
    const { lines } = buildHotbar(cfg, target, values, {
      sprite: spriteFor(0), exhausted, now, expr: st.expr, exprAge: now - (st.ts || 0),
      indent: Number(env.DOOMBAR_INDENT ?? 2), // Claude Code draws the status line 2 cols in
    });
    return lines;
  }
  const tick = Math.floor(now); // one marquee step per refresh (~1s); pure fn of time
  // Pick the preset that fits the terminal: the chosen preset is the ceiling; if it
  // (at its minimum scale) overflows COLUMNS, fall back down its [bar].fallback chain.
  // Sibling presets resolve relative to the chosen preset's directory.
  const presetDir = path.dirname(preset);
  const loadByName = (name) => {
    try { return loadPreset(path.join(presetDir, `${name}.toml`)); }
    catch { return null; }
  };
  const selected = resolvePreset(cfg, target, loadByName, spriteFor);
  // Text overflow behavior: env wins, then the preset's text_overflow, default "scroll".
  const overflow = env.DOOMBAR_TEXT_OVERFLOW || selected.text_overflow || cfg.text_overflow || "scroll";
  return buildBar(selected, target, spriteFor, tick, overflow).lines;
}
