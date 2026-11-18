#!/usr/bin/env node
// The model family the chat casts from is learned from the models the sessions run: a newer version
// of a tier replaces it, a new tier joins at the end, and what was learned is kept in the user
// directory for every later render.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseModel, learnFamily, modelFamily, SEED_FAMILY, familyFile } from "../../src/metrics/models.js";
import { facts } from "../../src/kit/chat/metrics-library.js";
import { sandboxEnv } from "../_sandbox-env.mjs";

const ROOT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("names:");
ok(same(parseModel("Opus 5.5"), { tier: "opus", version: [5, 5], name: "Opus 5.5" }), "a display name is a tier and a version");
ok(parseModel(" Haiku 4.5 ")?.name === "Haiku 4.5" && parseModel("Sonnet 6")?.version[0] === 6, "spaces around it and a one-part version are fine");
ok(["", "Opus", "claude-opus-5-5", "5.5", "Opus 5.5 beta", null, 42].every((n) => parseModel(n) === null), "anything else is not a model name");

console.log("learning:");
const seed = ["Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"];
ok(same(learnFamily(seed, ["Opus 5.6"]), ["Fable 5.2", "Opus 5.6", "Sonnet 5.5", "Haiku 5.5"]), "a newer version replaces its tier's model, in its place");
ok(same(learnFamily(seed, ["Opus 5.4", "Haiku 4.5"]), seed), "an older version changes nothing");
ok(same(learnFamily(seed, ["Opus 5.10"]), learnFamily(seed, ["Opus 5.10"])) && learnFamily(seed, ["Opus 5.10"])[1] === "Opus 5.10",
  "versions compare by number (5.10 is newer than 5.5)");
ok(same(learnFamily(seed, ["Kite 1.0"]), [...seed, "Kite 1.0"]), "a new tier joins the family at its end");
ok(same(learnFamily(seed, ["opus 5.6"]), ["Fable 5.2", "opus 5.6", "Sonnet 5.5", "Haiku 5.5"]), "the tier is matched whatever its case");
ok(same(learnFamily(seed, [null, "nonsense", undefined]), seed), "names that do not read as models are ignored");

console.log("kept in the user directory:");
const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-models-"));
try {
  const env = { ...process.env, ...sandboxEnv(SB) };
  ok(same(modelFamily([], env), [...SEED_FAMILY]), "with nothing learned the family is the seed");
  ok(same(modelFamily(["Opus 5.6"], env), ["Fable 5.2", "Opus 5.6", "Sonnet 5.5", "Haiku 5.5"]), "a session on Opus 5.6 teaches it");
  ok(same(JSON.parse(readFileSync(familyFile(env), "utf8")).family, ["Fable 5.2", "Opus 5.6", "Sonnet 5.5", "Haiku 5.5"]),
    `and it is kept in ${path.basename(familyFile(env))}`);
  ok(modelFamily(["Opus 5.5"], env)[1] === "Opus 5.6", "a later session on Opus 5.5 keeps the newer one");
  writeFileSync(familyFile(env), "{ broken");
  ok(same(modelFamily([], env), [...SEED_FAMILY]), "an unreadable file starts again from the seed");

  // Through a render: the chat's family fact comes from the learned family.
  const out = (model) => execFileSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
    env: { ...env, COLUMNS: "120", GAMEBAR_SKIN: "minecraft", GAMEBAR_STATE: path.join(SB, "state.json"), GAMEBAR_MSYS_REAP: "0" },
    input: JSON.stringify({ session_id: "m", cwd: SB, model: { display_name: model } }), encoding: "utf8" });
  out("Sonnet 6.0 (1M context)");
  const kept = JSON.parse(readFileSync(familyFile(env), "utf8")).family;
  ok(kept.includes("Sonnet 6.0") && !kept.includes("Sonnet 5.5"), `a render learns the running model (${kept.join(", ")})`);
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log("the chat's fact:");
ok(same(facts({ "model.family": ["Lark 2", "Wren 2"] }).family, ["Lark 2", "Wren 2"]), "the family fact is the learned family");
ok(same(facts({}).family, [...SEED_FAMILY]) && same(facts({ "model.family": [] }).family, [...SEED_FAMILY]), "without one it is the seed");

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
