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
import { SAMPLE, setValues, resolvePreset, buildBar } from "../../src/render.js";
import { buildHotbar } from "../../src/games/minecraft/layout.js";
import { setFaceOptions } from "../../src/games/doom/face.js";

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
const idleSprite = (hp) => `STFST${hp}1`;     // the idle face, no reaction

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
for (const preset of ["full", "standard", "minimal"]) {
  for (const width of [80, 120, 200]) {
    setValues(FIXTURE);
    const cfg = loadPreset(preset);
    const selected = resolvePreset(cfg, width, loadPreset, idleSprite);
    const overflow = selected.text_overflow || cfg.text_overflow || "scroll";
    check(`doom-${preset}-${width}`, buildBar(selected, width, idleSprite, 0, overflow).lines);
  }
}

// --- DOOM reactions: the face for each reaction the statusline can choose ------------------
// The sprite names are the ones the statusline picks for a reaction at the given health row.
{
  const reactions = {
    ouch: (hp) => `STFOUCH${hp}`,
    kill: (hp) => `STFKILL${hp}`,
    god: () => "STFGOD0",
    dead: () => "STFDEAD0",
  };
  for (const [name, spriteFor] of Object.entries(reactions)) {
    setValues(FIXTURE);
    const cfg = loadPreset("full");
    const selected = resolvePreset(cfg, 120, loadPreset, spriteFor);
    const overflow = selected.text_overflow || cfg.text_overflow || "scroll";
    check(`doom-full-120-${name}`, buildBar(selected, 120, spriteFor, 0, overflow).lines);
  }
}

// --- Minecraft hotbar -------------------------------------------------------------------
{
  const cfg = loadPreset("minecraft");
  const base = { sprite: "STFST01", exhausted: false, now: NOW, expr: null, exprAge: 999, indent: 2 };
  for (const width of [60, 100, 160]) {
    check(`minecraft-${width}`, buildHotbar(cfg, width, FIXTURE, base).lines);
  }
  // Out of usage: the hearts row turns into "You died!".
  check("minecraft-160-exhausted",
    buildHotbar(cfg, 160, FIXTURE, { ...base, sprite: "STFDEAD0", exhausted: true }).lines);
  // A tool just failed: hearts flash and the selected slot jumps to the errors slot.
  check("minecraft-160-ouch",
    buildHotbar(cfg, 160, FIXTURE, { ...base, sprite: "STFOUCH0", expr: "ouch", exprAge: 1 }).lines);
  // God mode: the hearts turn gold.
  check("minecraft-160-god", buildHotbar(cfg, 160, FIXTURE, { ...base, sprite: "STFGOD0" }).lines);
  // An ouch that has faded from the face (2 s ago) while the errors slot is still held.
  check("minecraft-160-ouch-faded",
    buildHotbar(cfg, 160, FIXTURE, { ...base, sprite: "STFST01", expr: "ouch", exprAge: 2 }).lines);
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
