#!/usr/bin/env node
// The game-neutral reaction (src/metrics/reaction.js) and the two games that read it: the
// DOOM portrait's sprite name and the Minecraft hotbar's hearts and reacting slot.
import "../_temp-sandbox.mjs"; // before the modules that name temp paths
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { buildReaction, calmReaction, hpRow, DECAY } from "../../src/metrics/reaction.js";
import { EXPRESSIONS } from "../../src/platform/journal.js";
import { portrait } from "../../src/games/doom/portrait.js";
import { buildHotbar } from "../../src/games/minecraft/layout.js";
import { renderContext } from "../../src/kit/context.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const NOW = 1793500000;
const HP_ROW_1 = { "context.hp": 30 }; // 70% headroom -> health row 1
const react = ({ expr, age = 0, godUntil = 0, exhausted = false, values = HP_ROW_1, now = NOW } = {}) =>
  buildReaction({ st: expr ? { expr, ts: now - age } : {}, values, godUntil, exhausted, now });

// Health row: thresholds 20/40/60/80 on the headroom, rate-limit health first.
ok(hpRow({ "context.hp": 5 }) === 0, "hp: 95% headroom -> row 0");
ok(hpRow({ "context.hp": 30 }) === 1, "hp: 70% headroom -> row 1");
ok(hpRow({ "context.hp": 95 }) === 4, "hp: 5% headroom -> row 4");
ok(hpRow({ "health.headroom": 50, "context.hp": 5 }) === 2, "hp: rate-limit health wins over the context");
ok(hpRow({ "ratelimit.5h": 70, "ratelimit.7d": 10 }) === 3, "hp: without health, the tightest rate-limit budget");
ok(hpRow({}) === 0, "hp: no values -> healthy");

// Each folded expression shows within the decay window, with its age.
ok(EXPRESSIONS.length === 5, `the hook fold has five expressions (${EXPRESSIONS.join(" ")})`);
for (const e of EXPRESSIONS) {
  const r = react({ expr: e, age: 0.5 });
  ok(r.expr === e && r.exprAge === 0.5 && r.flash === e && r.hp === 1 && !r.god && !r.dead,
    `${e}: fresh -> expr ${e}, age 0.5, flash ${e} (${JSON.stringify(r)})`);
}

// After the decay window the flash is gone, but the expression and its age stay.
{
  const r = react({ expr: "ouch", age: DECAY });
  ok(DECAY === 1.5, "the decay window is 1.5 s");
  ok(r.flash === null && r.expr === "ouch" && r.exprAge === DECAY, "ouch at 1.5 s: no flash, expr kept for the hotbar");
}

// An expression outside the known set flashes as "other" inside the window.
ok(react({ expr: "frown", age: 0.5 }).flash === "other", "unknown expression: flash other");
ok(react({ expr: "frown", age: 3 }).flash === null, "unknown expression, decayed: no flash");
ok(react().expr === null && react().flash === null, "no expression: expr null, no flash");

// Exhaustion and the god flash, dead first.
{
  const dead = react({ exhausted: true });
  ok(dead.flash === "dead" && dead.dead && !dead.god, "exhausted -> dead");
  const god = react({ godUntil: NOW + 1 });
  ok(god.flash === "god" && god.god && !god.dead, "active god flash -> god");
  ok(react({ godUntil: NOW }).flash === null, "a god flash that ended at now -> no flash");
  const both = react({ exhausted: true, godUntil: NOW + 1, expr: "ouch", age: 0.1 });
  ok(both.flash === "dead" && both.god && both.dead, "dead wins over god and over a fresh ouch");
  ok(react({ godUntil: NOW + 1, expr: "ouch", age: 0.1 }).flash === "god", "god wins over a fresh ouch");
}

// DOOM portrait: a sprite name per reaction.
{
  const calm = { expr: null, exprAge: Infinity, flash: null, god: false, dead: false };
  ok(portrait({ ...calm, expr: "ouch", flash: "ouch", hp: 2 }, NOW) === "STFOUCH2", "doom: ouch at hp 2 -> STFOUCH2");
  ok(portrait({ ...calm, dead: true, flash: "dead", hp: 3 }, NOW) === "STFDEAD0", "doom: dead -> STFDEAD0");
  ok(portrait({ ...calm, flash: "god", hp: 3 }, NOW) === "STFGOD0", "doom: god -> STFGOD0");
  ok(portrait({ ...calm, flash: "tl", hp: 1 }, NOW) === "STFTL10" && portrait({ ...calm, flash: "tr", hp: 1 }, NOW) === "STFTR10",
    "doom: the look-around faces end in 0");
  for (const e of EXPRESSIONS) {
    ok(portrait({ ...calm, expr: e, flash: e, hp: 2 }, NOW) !== "STFST21", `doom: ${e} has its own face, not the idle fallback`);
  }
  ok(portrait({ ...calm, flash: "other", hp: 2 }, NOW) === "STFST21", "doom: an unknown expression holds the middle idle frame");
  const still = calmReaction({ "context.hp": 95 });
  ok(still.flash === null && still.hp === 4 && portrait(still) === "STFST41", "doom: the calm reaction takes its health from the values");
  ok(portrait({ ...calm, hp: 2 }) === "STFST21", "doom: without a clock the idle face holds the middle frame");
  const idle = new Set();
  for (let t = 0; t < 40; t += 2) idle.add(portrait({ ...calm, hp: 0 }, NOW + t));
  ok([...idle].every((s) => /^STFST0[012]$/.test(s)) && idle.size === 3, `doom: the idle face glances around (${[...idle].join(" ")})`);
  ok(portrait({ ...calm, hp: 0 }, NOW) === portrait({ ...calm, hp: 0 }, NOW + 1.9), "doom: a glance holds for its 2 s bucket");
  const decayed = react({ expr: "ouch", age: 2 });
  ok(/^STFST1[012]$/.test(portrait(decayed, NOW)), "doom: an ouch 2 s ago shows the idle glance");
}

// Minecraft hotbar: hearts flash with the reaction, the reacting slot holds for 6 s.
{
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const cfg = parseToml(readFileSync(path.join(ROOT, "presets", "minecraft.toml"), "utf8"));
  const vals = { "context.hp": 30, "ratelimit.5h": 40, "ratelimit.7d": 20, "act.errors": "1" };
  const errorsSlot = cfg.slot.findIndex((s) => s.id === "act.errors");
  const hud = (reaction) => buildHotbar(cfg, 100, renderContext({ values: vals, reaction, now: NOW }));
  const calmHearts = hud(react({ values: vals })).lines[0];
  const at = (age) => hud(react({ expr: "ouch", age, values: vals }));
  ok(at(1).lines[0] !== calmHearts && at(1).selected === errorsSlot, "hotbar: an ouch 1 s ago flashes the hearts and selects the errors slot");
  ok(at(2).lines[0] === calmHearts && at(2).selected === errorsSlot, "hotbar: at 2 s the hearts are normal again, the errors slot still held");
  ok(at(5).selected === errorsSlot, "hotbar: the errors slot is still held at 5 s");
  ok(at(7).selected === hud(react({ values: vals })).selected, "hotbar: after 6 s the slot goes back to the idle pick");
  ok(hud(react({ expr: "frown", age: 0.5, values: vals })).lines[0] === calmHearts, "hotbar: an unknown expression leaves the hearts normal");
  ok(hud(react({ expr: "frown", age: 0.5, values: vals })).selected === hud(react({ values: vals })).selected,
    "hotbar: an unknown expression selects no reacting slot");
  for (const [e, id] of Object.entries(cfg.hotbar.react)) {
    const slot = cfg.slot.findIndex((s) => s.id === id);
    ok(slot !== hud(react({ values: vals })).selected, `hotbar: the ${e} slot is not the idle pick (the check below can fail)`);
    ok(hud(react({ expr: e, age: 1, values: vals })).selected === slot, `hotbar: ${e} selects its slot (${id})`);
    ok(hud(react({ expr: e, age: 6.5, values: vals })).selected !== slot, `hotbar: ${e} lets its slot go after 6 s`);
  }
  const god = hud(react({ godUntil: NOW + 1, values: vals })).lines[0];
  ok(god !== calmHearts && god !== at(1).lines[0], "hotbar: god turns the hearts another colour");
  ok(hud(react({ exhausted: true, values: vals })).lines[0].includes("You died!"), "hotbar: dead -> You died!");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
