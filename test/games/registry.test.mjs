#!/usr/bin/env node
// The game registry (src/games/index.js): a game is its folder plus one registry entry.
//
// The fixture game in ./fixture-game is a layout, one preset and the entry that names them. This
// test adds the entry to the registry's list and renders it through renderSession, the same call
// the one-shot status line and the render daemon make: nothing outside the fixture's folder and that
// one registration is needed. It also pins the production list (themes cycle doom -> minecraft ->
// doom, the old minecraft-hud name still resolves), the glyph test card's sample lookup, and the
// fallback for preset paths written before the presets moved into their games.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const FIXTURE_DIR = path.join(HERE, "fixture-game");
const DOOM_PRESETS = path.join(ROOT, "src", "games", "doom", "presets");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const inside = (dir, p) => !path.relative(dir, p).startsWith("..") && !path.isAbsolute(path.relative(dir, p));

const SB = mkdtempSync(path.join(os.tmpdir(), "doombar-registry-"));
const TMPDIR = path.join(SB, "tmp");
mkdirSync(TMPDIR, { recursive: true });
// Before the imports: the sandbox is the runtime directory, and the terminal running the tests must
// not pick the mugshot's glyphs.
Object.assign(process.env, { ...sandboxEnv(TMPDIR), PATH: "", DOOMBAR_MSYS_REAP: "0", DOOMBAR_RATELIMITS_SHARE: "0" });
for (const k of ["WT_SESSION", "TERM_PROGRAM", "TERM", "TMUX", "VTE_VERSION", "DOOMBAR_GLYPHS", "DOOMBAR_THEME", "DOOMBAR_PRESET"]) delete process.env[k];

const { GAMES, sampleImage, presetFile } = await import("../../src/games/index.js");
const { THEME_NAMES, nextTheme, resolveTheme, currentTheme } = await import("../../src/theme.js");
const { renderSession } = await import("../../src/render.js");
const { FIXTURE_GAME } = await import("./fixture-game/index.js");
const { fixtureLayout } = await import("./fixture-game/layout.js");

const NOW = 1793500000.123;
function session(name) {
  const dir = path.join(SB, name);
  for (const d of ["tasks", "proj", "state"]) mkdirSync(path.join(dir, d), { recursive: true });
  const env = {
    COLUMNS: "120", DOOMBAR_THEME_FILE: path.join(dir, "no-theme.json"), DOOMBAR_RATELIMITS_SHARE: "0",
    MUGSHOT_STATE: path.join(dir, "state", "checkpoint.json"), DOOMBAR_TASKS_DIR: path.join(dir, "tasks"),
    DOOMBAR_EVENTS: path.join(dir, "events.jsonl"), DOOMBAR_LLMLINGUA: path.join(dir, "ling.json"),
    DOOMBAR_RATELIMITS: path.join(dir, "rl.json"),
  };
  const data = {
    session_id: `sid-${name}`, session_name: `${name}-run`, cwd: path.join(dir, "proj"),
    model: { display_name: "Opus 5.5" }, context_window: { used_percentage: 42, context_window_size: 1000000 },
    cost: { total_cost_usd: 1.5, total_duration_ms: 3725000 },
  };
  return { env, data };
}
const render = (s, over = {}) => renderSession({ data: s.data, env: { ...s.env, ...over }, now: NOW }).join("\n");

// Add an entry for the length of `fn`, at the front or the back of the list, and take it out again.
function withGame(entry, fn, { first = false } = {}) {
  if (first) GAMES.unshift(entry); else GAMES.push(entry);
  try { return fn(); } finally { GAMES.splice(GAMES.indexOf(entry), 1); }
}

try {
  render(session("warmup")); // the first render has no earlier CPU sample to diff against

  // The production list.
  ok(GAMES.map((g) => g.name).join(",") === "doom,minecraft", "the registry lists doom, then minecraft");
  ok(THEME_NAMES.join(",") === "doom,minecraft", "the theme names follow the registry's order");
  ok(nextTheme("doom") === "minecraft" && nextTheme("minecraft") === "doom", "theme next cycles doom -> minecraft -> doom");
  ok(resolveTheme("minecraft-hud") === "minecraft", "the old name minecraft-hud still resolves to minecraft");
  ok(resolveTheme("satisfactory") === null, "a name no game registers resolves to nothing");
  for (const g of GAMES) {
    const files = Object.values(g.presets);
    ok(files.length > 0 && files.every((f) => inside(path.join(ROOT, "src", "games", g.name), f) && existsSync(f)),
      `${g.name}: its presets exist inside src/games/${g.name}`);
    ok(Object.hasOwn(g.presets, g.defaultPreset), `${g.name}: its default preset is one of its presets`);
  }

  // The fixture game: its own folder, one registration, and it renders through renderSession.
  {
    const files = readdirSync(FIXTURE_DIR, { recursive: true }).map((f) => f.replace(/\\/g, "/")).sort();
    ok(files.join(",") === "index.js,layout.js,presets,presets/fixture.toml", `the fixture game is a layout, a preset and its entry (${files.join(", ")})`);
    ok(Object.values(FIXTURE_GAME.presets).every((f) => inside(FIXTURE_DIR, f)) && FIXTURE_GAME.layout === fixtureLayout,
      "its entry names only files from its own folder");
    const s = session("fixture");
    const want = "FIXTURE | width 120 | model Opus 5.5 | hp 2";
    ok(render(s, { DOOMBAR_THEME: "fixture" }) !== want, "before it is registered, the fixture theme is not drawn");
    withGame(FIXTURE_GAME, () => {
      ok(resolveTheme("fixture-old") === "fixture", "a registered game's alias resolves");
      const viaTheme = render(s, { DOOMBAR_THEME: "fixture" });
      ok(viaTheme === want, `chosen as a theme, it draws its own preset with its own layout (${JSON.stringify(viaTheme)})`);
      ok(render(s, { DOOMBAR_THEME: "fixture", DOOMBAR_PRESET: path.join(DOOM_PRESETS, "full.toml") }) === want,
        "as a theme with its own preset, it is not swayed by DOOMBAR_PRESET");
      ok(render(s, { DOOMBAR_THEME: "doom", DOOMBAR_PRESET: FIXTURE_GAME.presets.fixture }) === want,
        "its preset chosen through DOOMBAR_PRESET picks its layout by the preset's [bar] layout");
      ok(render(s, { DOOMBAR_THEME: "doom", DOOMBAR_PRESET: path.join(ROOT, "presets", "fixture.toml") }) === want,
        "an old-style path to its preset resolves by file name like the built-in ones");
      ok(currentTheme({ DOOMBAR_THEME: "fixture" }) === "fixture", "the current theme can be the registered game");
    });
    ok(GAMES.map((g) => g.name).join(",") === "doom,minecraft", "taking the entry out leaves the production list as it was");
    ok(render(s, { DOOMBAR_THEME: "doom" }).includes("MODEL"), "with the fixture gone, doom draws its boxes again");
  }

  // The preset decides the layout, not the theme: a preset of one game named through DOOMBAR_PRESET
  // under the other game's theme renders as it always did.
  {
    const s = session("cross");
    const over = { COLUMNS: "160", DOOMBAR_INDENT: "4" };
    const minecraft = render(s, { ...over, DOOMBAR_THEME: "minecraft" });
    ok(minecraft.includes("━") && !minecraft.includes("MODEL"), "the minecraft theme draws the hotbar");
    ok(render(s, { ...over, DOOMBAR_THEME: "doom", DOOMBAR_PRESET: path.join(ROOT, "src", "games", "minecraft", "presets", "minecraft.toml") }) === minecraft,
      "theme doom with the minecraft preset in DOOMBAR_PRESET draws the same hotbar");
    ok(render(s, { ...over, DOOMBAR_THEME: "doom", DOOMBAR_PRESET: path.join(ROOT, "presets", "minecraft.toml") }) === minecraft,
      "and so does the old path to the minecraft preset");
    ok(render(s, { ...over, DOOMBAR_THEME: "minecraft", DOOMBAR_PRESET: path.join(DOOM_PRESETS, "full.toml") }) === minecraft,
      "theme minecraft ignores a DOOM preset in DOOMBAR_PRESET");
  }

  // The glyph test card's sample: the first registered game that has one.
  {
    const doomSample = sampleImage();
    ok(doomSample && existsSync(doomSample) && path.basename(doomSample) === "STFST01.png",
      "the test card's sample is the DOOM idle mugshot, and it exists");
    const first = withGame(FIXTURE_GAME, () => sampleImage(), { first: true });
    ok(first === doomSample, "with a game that has no sample registered first, the card still finds DOOM's");
  }

  // Preset paths written before the presets moved: <root>/presets/<name>.toml.
  {
    const oldFull = path.join(ROOT, "presets", "full.toml");
    const newFull = path.join(DOOM_PRESETS, "full.toml");
    ok(!existsSync(oldFull), "the old preset path no longer exists (the checks below can fail)");
    ok(presetFile(oldFull) === newFull, "an old path to a registered preset resolves to its new file");
    ok(presetFile(newFull) === newFull, "a path that exists is used as is");
    const missing = path.join(SB, "missing.toml");
    ok(presetFile(missing) === missing, "a missing file no game registers stays as it is (and fails to load)");
    const elsewhere = path.join(SB, "full.toml");
    ok(!existsSync(elsewhere) && presetFile(elsewhere) === elsewhere,
      "a missing full.toml outside the old presets folder stays as it is, not swapped for the bundled one");
    const s = session("old-path");
    for (const cols of ["250", "120", "90"]) {
      const viaOld = render(s, { DOOMBAR_THEME: "doom", DOOMBAR_PRESET: oldFull, COLUMNS: cols });
      const viaNew = render(s, { DOOMBAR_THEME: "doom", DOOMBAR_PRESET: newFull, COLUMNS: cols });
      ok(viaOld === viaNew && viaOld.includes("MODEL"), `at ${cols} columns the old path draws DOOM full exactly like the new one`);
    }
    // At 90 columns full does not fit: the fallback chain loads standard (and minimal) beside the
    // file actually loaded. A copy of full.toml alone in a folder has no chain to fall back on.
    const lone = path.join(SB, "lone");
    mkdirSync(lone);
    copyFileSync(newFull, path.join(lone, "full.toml"));
    const narrow = render(s, { DOOMBAR_THEME: "doom", DOOMBAR_PRESET: oldFull, COLUMNS: "90" });
    ok(narrow !== render(s, { DOOMBAR_THEME: "doom", DOOMBAR_PRESET: path.join(lone, "full.toml"), COLUMNS: "90" }),
      "the narrow render really fell back to a sibling preset, found beside the redirected file");
    ok(narrow === render(s, { DOOMBAR_THEME: "doom", DOOMBAR_PRESET: path.join(ROOT, "presets", "standard.toml"), COLUMNS: "90" })
      || narrow === render(s, { DOOMBAR_THEME: "doom", DOOMBAR_PRESET: path.join(DOOM_PRESETS, "minimal.toml"), COLUMNS: "90" }),
      "and it draws what that sibling draws on its own");
  }
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
