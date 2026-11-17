// Render one session's bar. The skin selection (src/skin-select.js) names the skin; it is loaded,
// fitted to the width and drawn (src/kit/skin/), with a warning line under it while any part of it
// needs the user's attention. A skin that cannot be loaded gives way to the default game's default
// skin, with a warning. The fit takes the terminal's width and height (rowsOf). The skin's scripts run through the runner the caller passes: src/render.js
// passes the script pass (src/kit/skin/scripts.js) for the render daemon; the one-shot status line
// (statusline.js), which runs no scripts, imports this module directly so it never loads the
// script host.

import path from "node:path";
import { effectiveStep } from "./kit/raster/glyph-level.js";
import { loadSkin } from "./kit/skin/load.js";
import { fitSkin } from "./kit/skin/fit.js";
import { drawFit } from "./kit/skin/draw.js";
import { warningLine, memoryStore, makeWarning } from "./kit/skin/warnings.js";
import { createAssetResolver, recordUsage } from "./platform/assets.js";
import { chainGames } from "./skin-assets.js";
import { defaultGame } from "./games/index.js";
import { selectSkin, findSkin } from "./skin-select.js";
import { collectValues } from "./metrics/index.js";
import { buildReaction } from "./metrics/reaction.js";
import { envGet } from "./platform/env.js";
import { isPlainObject } from "./kit/is.js";

// When each warning first appeared, for as long as this process lives: the render daemon's store.
// The one-shot status line, a new process every render, passes a store kept in a file instead.
const processStore = memoryStore();

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
// The rows the bar may take: GAMEBAR_MAX_ROWS when set, else a third of the terminal's height
// (LINES, which Claude Code sets before it runs the status line), else no limit, so a terminal that
// gives no height draws as before. A skin taller than this goes down its smaller-skin chain. The
// warning line under the bar does not count: it comes and goes, and the bar must not change skin
// with it.
export function rowsOf(env) {
  const max = parseInt(envGet("MAX_ROWS", env) ?? "", 10);
  if (max > 0) return max;
  const lines = parseInt(env.LINES ?? "", 10);
  return lines > 0 ? Math.max(1, Math.floor(lines / 3)) : Infinity;
}

// Returns the bar's lines, without trailing newlines. Everything about the session the drawing
// reads is built here for this render only, so sessions rendered in turn by the daemon never see
// each other's values or settings. `warningStore` keeps when each warning under the bar first
// appeared (src/kit/skin/warnings.js); by default this process's memory.
//
// `scripts` says how the skin's scripts run (src/kit/skin/scripts.js):
//   false                    not at all: the one-shot status line, a new process every render,
//                            would pay a worker start and a full timeout on every one
//   { host, pass, state }    the render daemon's: its one script host, the time left in its
//                            current pass, and this session's script state
//   omitted                  this process's shared host, a pass of this render's own, and no
//                            state kept between renders
// `runScripts` is the script pass (runScripts of src/kit/skin/scripts.js); null when `scripts` is
// false.
export function renderSessionWith(runScripts, { data, env = process.env, now = Date.now() / 1000, warningStore = processStore, scripts = {} }) {
  // A shallow copy: the rate-limit merge in collectValues rewrites data.rate_limits, and a caller
  // that keeps the payload between renders must not see it change.
  if (isPlainObject(data)) data = { ...data };

  const selected = selectSkin(env);
  return renderSkin({ selected, data, env, now, warningStore, scripts, runScripts }) ?? [`gamebar: skin ${selected.name} cannot be drawn`];
}

// The selected skin, fitted, its scripts run and drawn, or null when nothing of it (nor of the
// default skin) can be drawn. An element whose asset is missing draws its default, and the warning
// line names the missing package (src/platform/assets.js).
function renderSkin({ selected, data, env, now, warningStore, scripts, runScripts }) {
  // The folder each skin's own script paths are read from: a user skin's folder, a bundled skin's
  // game folder.
  const folders = new Map();
  const note = (s) => {
    if (s && s.file) folders.set(s.file, !s.user && s.game && s.game.dir ? s.game.dir : path.dirname(s.file));
    return s;
  };
  note(selected);
  // The default skin's file, looked up only when the selected skin has no file or does not load.
  let fallbackFile;
  const fallback = () => {
    if (fallbackFile === undefined) fallbackFile = note(findSkin(defaultGame().defaultSkin, env))?.file || null;
    return fallbackFile;
  };
  const warnings = [...selected.warnings];
  let file = selected.file;
  if (!file) {
    file = fallback();
    // A skin a game's manifest names but whose file is missing draws the default skin.
    if (file) {
      warnings.push(makeWarning({ key: `selection|no-file|${selected.name}`, cause: "no-file", subject: selected.name,
        message: `skin ${selected.name} has no file; drawing ${defaultGame().defaultSkin}` }));
    }
  }
  if (!file) return null;
  let loaded = loadSkin(file);
  if (!loaded.skin && fallback() !== file) loaded = loadSkin(file, { fallback: fallback() });
  if (!loaded.skin) return null;
  warnings.push(...loaded.warnings);
  const { values, reaction } = sessionValues(data, env, now);
  const width = Math.max(0, columnsOf(env) - indentOf(env));
  const loadSmaller = (name) => {
    const s = note(findSkin(name, env));
    if (!s || !s.file) {
      warnings.push(makeWarning({ key: `selection|smaller|${name}`, cause: "unknown-smaller", skin: loaded.skin.file,
        subject: name, message: `no skin is called ${name} (the smaller skin of ${loaded.skin.name})` }));
      return null;
    }
    const r = loadSkin(s.file);
    warnings.push(...r.warnings);
    return r.skin;
  };
  const fitted = fitSkin(loaded.skin, { values, width, rows: rowsOf(env), loadSmaller });
  warnings.push(...fitted.warnings);
  // Assets come through the asset store: the drawn skin's own references from its folder, a game's
  // from the checkout or the installed package. Every game the whole smaller chain uses is looked
  // up now, so a missing package starts installing before a narrower terminal needs it.
  const drawn = fitted.skin || loaded.skin;
  const assets = createAssetResolver({ env, now: now * 1000, folder: folders.get(drawn.file) ?? path.dirname(drawn.file) });
  for (const game of chainGames(loaded.skin, env)) assets.need(game);
  const ctx = { tick: Math.floor(now), step: effectiveStep(env), resolveAsset: assets.resolve, reaction, now };
  let fit = fitted, outputs = {};
  if (scripts !== false) {
    const run = runScripts(fitted, {
      host: scripts.host, pass: scripts.pass, state: scripts.state, values, reaction, now, tick: ctx.tick,
      folderOf: (skin) => folders.get(skin.file) ?? path.dirname(skin.file), resolveAsset: ctx.resolveAsset,
    });
    fit = run.fit;
    outputs = run.scripts;
    warnings.push(...run.warnings);
  }
  const lines = drawFit(fit, { values, width, ctx, scripts: outputs });
  warnings.push(...assets.warnings());
  recordUsage(selected.name, assets.packages(), { env, now: now * 1000 });
  const line = warningLine(warnings, { store: warningStore, now, width });
  return line ? [...lines, line] : lines;
}
