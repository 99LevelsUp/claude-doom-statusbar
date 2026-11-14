#!/usr/bin/env node
// Snapshot tests: pin what the DOOM presets and the Minecraft hotbar draw today, byte for
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
import { resolvePreset } from "../../src/kit/planner.js";
import { buildBar, mugshotFace } from "../../src/games/doom/layout.js";
import { buildHotbar } from "../../src/games/minecraft/layout.js";
import { buildReaction } from "../../src/metrics/reaction.js";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOOM_PRESETS = path.join(HERE, "..", "src", "games", "doom", "presets");
const MINECRAFT_PRESETS = path.join(HERE, "..", "src", "games", "minecraft", "presets");
const SNAP_DIR = path.join(HERE, "snapshots");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

// A preset by name from a game's folder (DOOM's by default, where the fallback chain looks).
const loadPreset = (name, dir = DOOM_PRESETS) => {
  try { return parseToml(readFileSync(path.join(dir, `${name}.toml`), "utf8")); }
  catch { return null; }
};

// SAMPLE plus the keys the hotbar slots and the chat read that the box presets do not.
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

// --- DOOM presets, through the same fallback chain the statusline uses -------------------
// No reaction and no clock: the calm face that holds still.
for (const preset of ["full", "standard", "minimal"]) {
  for (const width of [80, 120, 200]) {
    const ctx = contextOf();
    const cfg = loadPreset(preset);
    const selected = resolvePreset(ctx, cfg, width, loadPreset, mugshotFace(ctx));
    const overflow = selected.text_overflow || cfg.text_overflow || "scroll";
    check(`doom-${preset}-${width}`, buildBar(selected, width, { ...ctx, overflow }).lines);
  }
}

// --- DOOM reactions: the face for each reaction the statusline can choose ------------------
{
  const reactions = {
    ouch: reactionTo({ st: { expr: "ouch", ts: NOW - 0.5 } }),
    kill: reactionTo({ st: { expr: "kill", ts: NOW - 0.5 } }),
    god: reactionTo({ godUntil: NOW + 1 }),
    dead: reactionTo({ exhausted: true }),
  };
  for (const [name, reaction] of Object.entries(reactions)) {
    const ctx = contextOf({ reaction, now: NOW });
    const cfg = loadPreset("full");
    const selected = resolvePreset(ctx, cfg, 120, loadPreset, mugshotFace(ctx));
    const overflow = selected.text_overflow || cfg.text_overflow || "scroll";
    check(`doom-full-120-${name}`, buildBar(selected, 120, { ...ctx, overflow }).lines);
  }
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
