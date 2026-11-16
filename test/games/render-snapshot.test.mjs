#!/usr/bin/env node
// Snapshot tests: pin what the DOOM skins and the Minecraft skin draw, byte for byte, so a
// refactor can prove it changes nothing on screen.
//
// Only the pure renderers run here, with a fixed fixture and a fixed clock: the statusline
// process reads live CPU, RAM and the time, which change on every run. Every skin is drawn as the
// render daemon draws it: loaded, fitted down its smaller-skin chain, its scripts run, drawn.
//
// Regenerate on purpose with UPDATE_SNAPSHOTS=1. A missing snapshot fails otherwise.

// The DOOM mugshot is drawn by the built-in converter at the glyph step the terminal allows; the
// snapshots pin the richest step, so they do not depend on the terminal that runs the tests.

import "../_temp-sandbox.mjs"; // before the modules that name temp paths
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReaction } from "../../src/metrics/reaction.js";
import { findGame } from "../../src/games/index.js";
import { findSkin } from "../../src/skin-select.js";
import { loadSkin } from "../../src/kit/skin/load.js";
import { fitSkin } from "../../src/kit/skin/fit.js";
import { drawFit } from "../../src/kit/skin/draw.js";
import { runScripts, createScriptPass } from "../../src/kit/skin/scripts.js";
import { createScriptHost } from "../../src/platform/scripts/host.js";
import { createAssetResolver } from "../../src/platform/assets.js";
import { RAW_SAMPLE } from "../_raw-sample.mjs";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SNAP_DIR = path.join(HERE, "snapshots");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const NOW = 1793500000;                       // fixed clock: chat position, idle slot, rainbow

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

// --- skins, fitted down their smaller-skin chain, their scripts run -------------------------
// The session's metric values in their raw form, at the richest glyph step, the clock fixed. The
// scripts get budgets a slow worker start cannot use up, so none is skipped on a loaded machine.
const host = createScriptHost({ callBudgetMs: 2000, graceMs: 2000, startupMs: 10000 });
const loadNamed = (name) => loadSkin(findSkin(name).file).skin;
const reactionTo = (o = {}) => buildReaction({ st: {}, values: RAW_SAMPLE, godUntil: 0, exhausted: false, now: NOW, ...o });
function bar(game, skinName, width, reaction) {
  const { dir } = findGame(game);
  const resolveAsset = createAssetResolver({ folder: dir }).resolve;
  const fit = fitSkin(loadNamed(skinName), { values: RAW_SAMPLE, width, loadSmaller: loadNamed });
  const pass = createScriptPass({ budgetMs: 60000, callBudgetMs: 10000 });
  const run = runScripts(fit, { host, pass, values: RAW_SAMPLE, reaction, now: NOW, tick: 0, folderOf: () => dir, resolveAsset });
  return drawFit(run.fit, { values: RAW_SAMPLE, width, scripts: run.scripts, ctx: { tick: 0, step: "octant", resolveAsset, reaction, now: NOW } });
}

try {
  // DOOM, calm: the idle glance the clock picks.
  for (const size of ["full", "standard", "minimal"]) {
    for (const width of [80, 120, 200]) check(`doom-${size}-${width}`, bar("doom", `doom-${size}`, width, reactionTo()));
  }
  // The face for each reaction the statusline can choose.
  const reactions = {
    ouch: reactionTo({ st: { expr: "ouch", ts: NOW - 0.5 } }),
    kill: reactionTo({ st: { expr: "kill", ts: NOW - 0.5 } }),
    god: reactionTo({ godUntil: NOW + 1 }),
    dead: reactionTo({ exhausted: true }),
  };
  for (const [name, reaction] of Object.entries(reactions)) check(`doom-full-120-${name}`, bar("doom", "doom-full", 120, reaction));

  // Minecraft: the chat with its library, the idle slot the clock picks.
  for (const width of [60, 100, 160]) check(`minecraft-${width}`, bar("minecraft", "minecraft", width, reactionTo()));
  // Out of usage.
  check("minecraft-160-exhausted", bar("minecraft", "minecraft", 160, reactionTo({ exhausted: true })));
  // A tool just failed: the selected slot jumps to the errors slot.
  check("minecraft-160-ouch", bar("minecraft", "minecraft", 160, reactionTo({ st: { expr: "ouch", ts: NOW - 1 } })));
  // God mode.
  check("minecraft-160-god", bar("minecraft", "minecraft", 160, reactionTo({ godUntil: NOW + 1 })));
  // An ouch that has faded from the face (2 s ago) while the errors slot is still held.
  check("minecraft-160-ouch-faded", bar("minecraft", "minecraft", 160, reactionTo({ st: { expr: "ouch", ts: NOW - 2 } })));
} finally {
  host.close();
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
