#!/usr/bin/env node
// Snapshot tests: pin what every bundled skin draws, byte for byte, so a refactor can prove it
// changes nothing on screen, and so the owner can review a deliberate change by eye.
//
// The skins come from the game registry (every bundled skin), plus a user skin fixture that mixes
// two games' parts (test/fixtures/skins/mixed.toml). Each bundled skin is drawn at three terminal
// widths while nothing happens, and every skin at the widest for each of four reactions: ouch, kill,
// god, and dead (out of usage, with the 5h limit used up as the statusline would have it), and once
// more calm with no subagents and no tasks, so the boxes of empty lists are pinned too.
//
// Each skin is drawn as the render daemon draws it: loaded, fitted down its smaller-skin chain, its
// scripts run, drawn. renderSession itself is not called: it reads live CPU, RAM, git and the time,
// which change on every run. Here the metric values are a fixed fixture, the clock is fixed, and the
// DOOM mugshot is drawn at the richest glyph step, so the output does not depend on the terminal.
//
// Some cases draw exactly what another case draws: a DOOM skin too wide for the terminal falls down
// its smaller-skin chain to the skin that fits, and a skin that has no look for a reaction draws it
// calm. Such a case has no file of its own. test/snapshots/index.json maps every case to the file
// it must match, and no two files hold the same drawing, so each file pins something of its own.
//
// Re-record on purpose, never in CI: UPDATE_SNAPSHOTS=1 writes the files and the index, and removes
// files the index no longer names. A missing or stale index or file fails otherwise.

import "../_temp-sandbox.mjs"; // before the modules that name temp paths
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReaction } from "../../src/metrics/reaction.js";
import { bundledSkins } from "../../src/games/index.js";
import { findSkin } from "../../src/skin-select.js";
import { loadSkin } from "../../src/kit/skin/load.js";
import { fitSkin } from "../../src/kit/skin/fit.js";
import { drawFit } from "../../src/kit/skin/draw.js";
import { runScripts, createScriptPass } from "../../src/kit/skin/scripts.js";
import { createScriptHost } from "../../src/platform/scripts/host.js";
import { createAssetResolver } from "../../src/platform/assets.js";
import { RAW_SAMPLE } from "../_raw-sample.mjs";

const TEST_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SNAP_DIR = path.join(TEST_DIR, "snapshots");
const INDEX = path.join(SNAP_DIR, "index.json");
const MIXED = path.join(TEST_DIR, "fixtures", "skins", "mixed.toml");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

if (UPDATE && process.env.CI) {
  console.error("UPDATE_SNAPSHOTS=1 records new snapshots for the owner to review; it does not run in CI.");
  process.exit(1);
}

const NOW = 1793500000;              // fixed clock: chat position, idle slot, idle glance
// The terminal widths a bundled skin is drawn at: narrow (parts dropped, or the narrowest skin cut
// at the edge), middle (parts shrunk) and wide (the whole skin). The reactions are drawn wide.
const WIDTHS = [60, 100, 200];
const REACTION_WIDTH = 200;

// The session at each moment drawn: its metric values and its reaction.
const reactionTo = (o = {}, values = RAW_SAMPLE) => buildReaction({ st: {}, values, godUntil: 0, exhausted: false, now: NOW, ...o });
const EXHAUSTED = Object.freeze({ ...RAW_SAMPLE, "ratelimit.5h": 100 });
const NO_LISTS = Object.freeze({ ...RAW_SAMPLE, "act.subagents": [], "act.tasklist": [] });
const MOMENTS = {
  calm: { values: RAW_SAMPLE, reaction: reactionTo() },
  ouch: { values: RAW_SAMPLE, reaction: reactionTo({ st: { expr: "ouch", ts: NOW - 0.5 } }) },
  kill: { values: RAW_SAMPLE, reaction: reactionTo({ st: { expr: "kill", ts: NOW - 0.5 } }) },
  god: { values: RAW_SAMPLE, reaction: reactionTo({ godUntil: NOW + 1 }) },
  dead: { values: EXHAUSTED, reaction: reactionTo({ exhausted: true }, EXHAUSTED) },
  // No subagents running and no tasks: the boxes of those lists show only their titles.
  "no-lists": { values: NO_LISTS, reaction: reactionTo({}, NO_LISTS) },
};

// Every skin drawn: the bundled ones in registry order, then the mixed user skin. `folder` is where
// the skin's own paths are read from (a bundled skin's game folder, a user skin's own folder). The
// mixed skin is narrower than any of the widths, so it is drawn calm at one width only.
const SKINS = [
  ...bundledSkins().map((s) => ({ name: s.name, file: s.file, folder: s.game.dir, widths: WIDTHS })),
  { name: "mixed", file: MIXED, folder: path.dirname(MIXED), widths: [REACTION_WIDTH] },
];

// Every case: each skin calm at each of its widths, then each reaction at the widest.
const CASES = SKINS.flatMap((skin) => [
  ...skin.widths.map((width) => ({ name: `${skin.name}-${width}`, skin, width, moment: "calm" })),
  ...Object.keys(MOMENTS).filter((m) => m !== "calm")
    .map((moment) => ({ name: `${skin.name}-${REACTION_WIDTH}-${moment}`, skin, width: REACTION_WIDTH, moment })),
]);

// The scripts get budgets a slow worker start cannot use up: one that runs late or is skipped would
// leave its element on its default look, which is not what the snapshot pins.
const host = createScriptHost({ callBudgetMs: 2000, graceMs: 2000, startupMs: 10000 });
const loadNamed = (name) => loadSkin(findSkin(name).file).skin;

// The elements whose scripts did not run: each scripted element needs its script's output, each
// chat one result per conversation library it names. A skipped script gives no warning.
function scriptsNotRun(tree, scripts) {
  const missing = [];
  const walk = (t) => {
    const { node } = t;
    if (typeof node.script === "string" && node.script !== "" && !Object.hasOwn(scripts, t.id)) missing.push(`${t.id} (${node.script})`);
    const libraries = !node.container && typeof node.descriptor.libraries === "function" ? node.descriptor.libraries(node.params) : [];
    if (libraries.length && (scripts[t.id]?.conversations ?? []).length !== libraries.length) missing.push(`${t.id} (conversation libraries)`);
    t.children.forEach(walk);
  };
  if (tree) walk(tree);
  return missing;
}

// One case drawn: its lines, the skin that drew them (the case's own, or one down its smaller-skin
// chain), and what went wrong on the way (warnings, scripts that did not run).
function draw({ skin, width, moment }) {
  const { values, reaction } = MOMENTS[moment];
  const assets = createAssetResolver({ folder: skin.folder });
  const loaded = loadSkin(skin.file);
  const fit = fitSkin(loaded.skin, { values, width, loadSmaller: loadNamed });
  const pass = createScriptPass({ budgetMs: 60000, callBudgetMs: 10000 });
  const run = runScripts(fit, { host, pass, values, reaction, now: NOW, tick: 0, folderOf: () => skin.folder, resolveAsset: assets.resolve });
  const lines = drawFit(run.fit, { values, width, scripts: run.scripts, ctx: { tick: 0, step: "octant", resolveAsset: assets.resolve, reaction, now: NOW } });
  const warnings = [...loaded.warnings, ...fit.warnings, ...run.warnings, ...assets.warnings()].map((w) => w.message);
  return { text: lines.join("\n") + "\n", drawnBy: fit.skin.name, warnings, notRun: scriptsNotRun(run.fit.tree, run.scripts) };
}

const readIndex = () => { try { return JSON.parse(readFileSync(INDEX, "utf8")); } catch { return null; } };
const snapshotFiles = () => (existsSync(SNAP_DIR) ? readdirSync(SNAP_DIR).filter((f) => f.endsWith(".txt")).map((f) => f.slice(0, -4)) : []);

try {
  // Start the worker and load every script once, so no case pays for it.
  for (const skin of SKINS) draw({ skin, width: REACTION_WIDTH, moment: "calm" });

  const drawn = CASES.map((c) => ({ ...c, ...draw(c) }));
  for (const c of drawn) {
    ok(c.warnings.length === 0, `${c.name}: drawn without a warning${c.warnings.length ? ` (${c.warnings.join("; ")})` : ""}`);
    ok(c.notRun.length === 0, `${c.name}: every script ran${c.notRun.length ? ` (not: ${c.notRun.join(", ")})` : ""}`);
  }

  if (UPDATE) {
    // A drawing with a warning or a script that did not run is not recorded for the owner.
    if (fails) throw new Error("not recorded: fix the failures above first");
    // One file per distinct drawing, named after the first case whose own skin drew it.
    const groups = new Map();
    for (const c of drawn) groups.set(c.text, [...(groups.get(c.text) ?? []), c]);
    const index = {};
    mkdirSync(SNAP_DIR, { recursive: true });
    for (const [text, cases] of groups) {
      const file = (cases.find((c) => c.drawnBy === c.skin.name) ?? cases[0]).name;
      writeFileSync(path.join(SNAP_DIR, `${file}.txt`), text);
      for (const c of cases) index[c.name] = file;
    }
    const ordered = Object.fromEntries(CASES.map((c) => [c.name, index[c.name]]));
    writeFileSync(INDEX, JSON.stringify(ordered, null, 2) + "\n");
    const named = new Set(Object.values(ordered));
    for (const f of snapshotFiles()) if (!named.has(f)) rmSync(path.join(SNAP_DIR, `${f}.txt`));
    for (const c of CASES) ok(true, `${c.name}: written to test/snapshots/${ordered[c.name]}.txt`);
  } else {
    const index = readIndex();
    if (!index) {
      ok(false, "no snapshot index at test/snapshots/index.json (run with UPDATE_SNAPSHOTS=1)");
    } else {
      const names = new Set(CASES.map((c) => c.name));
      const unindexed = [...names].filter((n) => !Object.hasOwn(index, n));
      const stale = Object.keys(index).filter((n) => !names.has(n));
      ok(unindexed.length === 0, `every case is in the index${unindexed.length ? ` (missing: ${unindexed.join(", ")})` : ""}`);
      ok(stale.length === 0, `the index names no case that is not drawn${stale.length ? ` (stale: ${stale.join(", ")})` : ""}`);
      for (const c of drawn) {
        const name = index[c.name];
        if (!name) continue;
        const file = path.join(SNAP_DIR, `${name}.txt`);
        if (!existsSync(file)) { ok(false, `${c.name}: no snapshot at test/snapshots/${name}.txt`); continue; }
        const expected = readFileSync(file, "utf8");
        ok(!expected.includes("\r"), `${c.name}: snapshot has LF line endings (.gitattributes keeps it binary)`);
        ok(c.text === expected, `${c.name}: matches test/snapshots/${name}.txt`);
      }
      const named = [...new Set(Object.values(index))];
      const present = named.filter((n) => existsSync(path.join(SNAP_DIR, `${n}.txt`)));
      const contents = new Set(present.map((n) => readFileSync(path.join(SNAP_DIR, `${n}.txt`), "utf8")));
      ok(contents.size === present.length, `no two snapshot files hold the same drawing (${present.length} files, ${contents.size} distinct)`);
      const orphans = snapshotFiles().filter((f) => !named.includes(f));
      ok(orphans.length === 0, `every snapshot file is named in the index${orphans.length ? ` (not: ${orphans.join(", ")})` : ""}`);
    }
  }
} catch (e) {
  ok(false, e.message);
} finally {
  host.close();
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
