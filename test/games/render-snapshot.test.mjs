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
import { SAMPLE, setValues } from "../../src/kit/values.js";
import { resolvePreset } from "../../src/kit/planner.js";
import { buildBar, mugshotFace } from "../../src/games/doom/layout.js";
import { buildHotbar } from "../../src/games/minecraft/layout.js";
import { setFaceOptions } from "../../src/games/doom/face.js";
import { buildReaction } from "../../src/metrics/reaction.js";

setFaceOptions({ step: "octant", background: [0, 0, 0] });

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRESETS = path.join(HERE, "..", "presets");
const SNAP_DIR = path.join(HERE, "snapshots");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const loadPreset = (name) => {
  try { return parseToml(readFileSync(path.join(PRESETS, `${name}.toml`), "utf8")); }
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
    setValues(FIXTURE);
    const cfg = loadPreset(preset);
    const selected = resolvePreset(cfg, width, loadPreset, mugshotFace());
    const overflow = selected.text_overflow || cfg.text_overflow || "scroll";
    check(`doom-${preset}-${width}`, buildBar(selected, width, undefined, 0, overflow).lines);
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
    setValues(FIXTURE);
    const cfg = loadPreset("full");
    const selected = resolvePreset(cfg, 120, loadPreset, mugshotFace(reaction, NOW));
    const overflow = selected.text_overflow || cfg.text_overflow || "scroll";
    check(`doom-full-120-${name}`, buildBar(selected, 120, reaction, 0, overflow, NOW).lines);
  }
}

// --- Minecraft hotbar -------------------------------------------------------------------
{
  const cfg = loadPreset("minecraft");
  const base = { reaction: reactionTo(), now: NOW, indent: 2 };
  for (const width of [60, 100, 160]) {
    check(`minecraft-${width}`, buildHotbar(cfg, width, FIXTURE, base).lines);
  }
  // Out of usage: the hearts row turns into "You died!".
  check("minecraft-160-exhausted",
    buildHotbar(cfg, 160, FIXTURE, { ...base, reaction: reactionTo({ exhausted: true }) }).lines);
  // A tool just failed: hearts flash and the selected slot jumps to the errors slot.
  check("minecraft-160-ouch",
    buildHotbar(cfg, 160, FIXTURE, { ...base, reaction: reactionTo({ st: { expr: "ouch", ts: NOW - 1 } }) }).lines);
  // God mode: the hearts turn gold.
  check("minecraft-160-god",
    buildHotbar(cfg, 160, FIXTURE, { ...base, reaction: reactionTo({ godUntil: NOW + 1 }) }).lines);
  // An ouch that has faded from the face (2 s ago) while the errors slot is still held.
  check("minecraft-160-ouch-faded",
    buildHotbar(cfg, 160, FIXTURE, { ...base, reaction: reactionTo({ st: { expr: "ouch", ts: NOW - 2 } }) }).lines);
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
