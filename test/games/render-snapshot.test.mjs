#!/usr/bin/env node
// Snapshot tests: pin what the DOOM skins and the Minecraft hotbar draw today, byte for
// byte, so a refactor can prove it changes nothing on screen.
//
// Only the pure renderers run here, with a fixed fixture and a fixed clock: the statusline
// process reads live CPU, RAM and the time, which change on every run.
//
// Regenerate on purpose with UPDATE_SNAPSHOTS=1. A missing snapshot fails otherwise.

// The DOOM mugshot is drawn by the built-in converter at the glyph step the terminal allows; the
// snapshots pin the richest step, so they do not depend on the terminal that runs the tests.

import "../_temp-sandbox.mjs"; // before the modules that name temp paths
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { SAMPLE } from "../../src/kit/values.js";
import { renderContext } from "../../src/kit/context.js";
import { buildHotbar } from "../../src/games/minecraft/layout.js";
import { buildReaction } from "../../src/metrics/reaction.js";
import { findGame } from "../../src/games/index.js";
import { findSkin } from "../../src/skin-select.js";
import { loadSkin } from "../../src/kit/skin/load.js";
import { fitSkin } from "../../src/kit/skin/fit.js";
import { drawFit } from "../../src/kit/skin/draw.js";
import { runScripts } from "../../src/kit/skin/scripts.js";
import { createScriptHost } from "../../src/platform/scripts/host.js";
import { createAssetResolver } from "../../src/platform/assets.js";
import { RAW_SAMPLE } from "../_raw-sample.mjs";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MINECRAFT_PRESETS = path.join(HERE, "..", "src", "games", "minecraft", "presets");
const SNAP_DIR = path.join(HERE, "snapshots");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

// A Minecraft preset by name.
const loadPreset = (name, dir = MINECRAFT_PRESETS) => {
  try { return parseToml(readFileSync(path.join(dir, `${name}.toml`), "utf8")); }
  catch { return null; }
};

// SAMPLE plus the keys the hotbar slots and the chat read.
const FIXTURE = {
  ...SAMPLE,
  "loc.added": "185",
  "model.effort_level": "high",
  "session.title": "doom-hud-demo",
};
const NOW = 1793500000;                       // fixed clock: chat position, idle slot, rainbow

// A render context over the fixture, at the richest glyph step on a black mugshot background.
const contextOf = (o = {}) => renderContext({ values: FIXTURE, step: "octant", background: [0, 0, 0], ...o });

// The reaction the statusline builds for a session state over the fixture values.
const reactionTo = ({ st = {}, godUntil = 0, exhausted = false, now = NOW } = {}) =>
  buildReaction({ st, values: FIXTURE, godUntil, exhausted, now });

function check(name, lines) {
  const file = path.join(SNAP_DIR, `${name}.txt`);
  const actual = lines.join("\n") + "\n";
  if (UPDATE) {
    mkdirSync(SNAP_DIR, { recursive: true });
    writeFileSync(file, actual);
    ok(true, `${name}: written`);
    return;
  }
  if (!existsSync(file)) {
    ok(false, `${name}: no snapshot at test/snapshots/${name}.txt (run with UPDATE_SNAPSHOTS=1)`);
    return;
  }
  const expected = readFileSync(file, "utf8");
  ok(!expected.includes("\r"), `${name}: snapshot has LF line endings (.gitattributes keeps it binary)`);
  ok(actual === expected, `${name}: matches test/snapshots/${name}.txt`);
}

// --- DOOM skins, fitted down their smaller-skin chain, the mugshot script run ---------------
// The session's metric values in their raw form, at the richest glyph step, the clock fixed.
const doom = findGame("doom");
const resolveAsset = createAssetResolver({ folder: doom.dir }).resolve;
const host = createScriptHost({ callBudgetMs: 2000, graceMs: 2000, startupMs: 5000 });
const loadNamed = (name) => loadSkin(findSkin(name).file).skin;
const doomReaction = (o = {}) => buildReaction({ st: {}, values: RAW_SAMPLE, godUntil: 0, exhausted: false, now: NOW, ...o });
function doomBar(skinName, width, reaction) {
  const fit = fitSkin(loadNamed(skinName), { values: RAW_SAMPLE, width, loadSmaller: loadNamed });
  const run = runScripts(fit, { host, values: RAW_SAMPLE, reaction, now: NOW, tick: 0, folderOf: () => doom.dir, resolveAsset });
  return drawFit(run.fit, { values: RAW_SAMPLE, width, scripts: run.scripts, ctx: { tick: 0, step: "octant", resolveAsset, reaction, now: NOW } });
}

try {
  // Calm: the idle glance the clock picks.
  for (const size of ["full", "standard", "minimal"]) {
    for (const width of [80, 120, 200]) check(`doom-${size}-${width}`, doomBar(`doom-${size}`, width, doomReaction()));
  }
  // The face for each reaction the statusline can choose.
  const reactions = {
    ouch: doomReaction({ st: { expr: "ouch", ts: NOW - 0.5 } }),
    kill: doomReaction({ st: { expr: "kill", ts: NOW - 0.5 } }),
    god: doomReaction({ godUntil: NOW + 1 }),
    dead: doomReaction({ exhausted: true }),
  };
  for (const [name, reaction] of Object.entries(reactions)) check(`doom-full-120-${name}`, doomBar("doom-full", 120, reaction));
} finally {
  host.close();
}

// --- Minecraft hotbar -------------------------------------------------------------------
{
  const cfg = loadPreset("minecraft", MINECRAFT_PRESETS);
  const hud = (width, reaction = reactionTo()) =>
    buildHotbar(cfg, width, contextOf({ reaction, now: NOW }), { indent: 2 }).lines;
  for (const width of [60, 100, 160]) {
    check(`minecraft-${width}`, hud(width));
  }
  // Out of usage: the hearts row turns into "You died!".
  check("minecraft-160-exhausted", hud(160, reactionTo({ exhausted: true })));
  // A tool just failed: hearts flash and the selected slot jumps to the errors slot.
  check("minecraft-160-ouch", hud(160, reactionTo({ st: { expr: "ouch", ts: NOW - 1 } })));
  // God mode: the hearts turn gold.
  check("minecraft-160-god", hud(160, reactionTo({ godUntil: NOW + 1 })));
  // An ouch that has faded from the face (2 s ago) while the errors slot is still held.
  check("minecraft-160-ouch-faded", hud(160, reactionTo({ st: { expr: "ouch", ts: NOW - 2 } })));
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
