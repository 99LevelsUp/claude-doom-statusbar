#!/usr/bin/env node
// Scripts in the render pass: after the fit, every drawn element with a script is run in one batch
// through the script host, and what the scripts return changes how those elements look, never
// their size. A script that fails or runs past its budget leaves its element on its default
// visual and shows a warning; one that fails is not run again until it or its skin changes, one
// that runs past its budget not until a cooldown ends (src/platform/scripts/host.js) or it or its
// skin changes. The one-shot status line runs no scripts at all.
//
// Checks that need a script to run, not to be timed, give the host a per-call budget and the pass
// a budget no loaded machine uses up; checks that need a script to run past its budget use one
// that loops, which no budget lets finish.

import { TEMP_SANDBOX } from "../_temp-sandbox.mjs";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { loadSkin } = await import("../../src/kit/skin/load.js");
const { fitSkin } = await import("../../src/kit/skin/fit.js");
const { drawFit } = await import("../../src/kit/skin/draw.js");
const { VISUALS } = await import("../../src/kit/elements/index.js");
const { vlen } = await import("../../src/kit/text.js");
const { createScriptHost } = await import("../../src/platform/scripts/host.js");
const { runScripts, createScriptPass } = await import("../../src/kit/skin/scripts.js");
const { renderSession } = await import("../../src/render.js");

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const plain = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WAD = path.join(ROOT, "games", "doom", "assets", "images", "mugshot-wad");
const USER = path.join(TEMP_SANDBOX, "user");

// A skin folder of the user's: the skin file and the scripts beside it.
function userSkin(name, toml, scripts = {}) {
  const dir = path.join(USER, "skins", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, source] of Object.entries(scripts)) writeFileSync(path.join(dir, file), source);
  const file = path.join(dir, `${name}.toml`);
  writeFileSync(file, toml);
  return file;
}
const load = (file) => {
  const { skin, warnings } = loadSkin(file);
  if (warnings.length) throw new Error(JSON.stringify(warnings));
  return skin;
};

const VALUES = { "model.name": "Opus" };
const WIDTH = 80;
const NOW = 1_700_000_000;
const CTX = { tick: NOW, step: "octant", resolveAsset: () => null };

// A row of three cells in a grid frame (a hotbar) beside the model's name.
const hotbar = (script) => `version = 1
root = "bar"
[element.bar]
kind = "row"
children = ["hotbar", "name"]
[element.hotbar]
kind = "row"
frame = { kind = "grid", selected_lines = "╔═╦╗║╚╩╝" }
script = "${script}"
children = ["a", "b", "c"]
[element.a]
kind = "text"
metric = "model.name"
width = 3
min_width = 3
[element.b]
kind = "text"
metric = "model.name"
width = 3
min_width = 3
[element.c]
kind = "text"
metric = "model.name"
width = 3
min_width = 3
[element.name]
kind = "text"
metric = "model.name"
width = 10
min_width = 10
`;

const oneText = (script, { width = 8, icon = "" } = {}) => `version = 1
root = "bar"
[element.bar]
kind = "row"
children = ["name", "tail"]
[element.name]
kind = "text"
metric = "model.name"
width = ${width}
min_width = ${width}
icon = "${icon}"
script = "${script}"
[element.tail]
kind = "text"
metric = "model.name"
width = 6
min_width = 6
`;

const fitOf = (skin, width = WIDTH) => fitSkin(skin, { values: VALUES, width });
const nodeWidth = (fit, id) => {
  const find = (t) => (t.id === id ? t : t.children.map(find).find(Boolean));
  return find(fit.tree).width;
};

const host = createScriptHost({ callBudgetMs: 2000, graceMs: 2000, startupMs: 10000 });
// The product's per-call budget, for the scripts that loop: they run past any budget, so the
// shortest keeps the checks quick. The pass's deadline is long, so the vm timeout, not the
// backstop, stops them however late it fires.
const loopHost = createScriptHost({ startupMs: 10000 });
// The host as runScripts uses it, recording each batch's result statuses.
const spied = (h) => {
  const statuses = [];
  return { statuses, runBatch: (calls, opts) => { const r = h.runBatch(calls, opts); statuses.push(r.map((x) => x.status)); return r; } };
};
// Checks that time the pass give their own; every other check needs its scripts to run.
const run = (fit, opts = {}) => runScripts(fit, {
  host, pass: createScriptPass({ budgetMs: 60000, callBudgetMs: 10000 }), values: VALUES, reaction: null, now: NOW, tick: NOW,
  resolveAsset: () => null, ...opts,
});
const draw = (r) => drawFit(r.fit, { values: VALUES, width: WIDTH, ctx: CTX, scripts: r.scripts });
// A pass and a worker start a loaded machine cannot exhaust, so a slow start never turns a
// pass into "skipped".
const roomyPass = () => createScriptPass({ budgetMs: 60000, callBudgetMs: 10000 });
const roomyHost = () => createScriptHost({ callBudgetMs: 2000, graceMs: 2000, startupMs: 10000 });

try {
  console.log("a script of an element kept without its value");
  {
    const skin = load(userSkin("stand-in", `version = 1
root = "bar"
[element.bar]
kind = "row"
script = "row.js"
children = ["xp", "name"]
[element.xp]
kind = "progress"
metric = "ratelimit.7d"
when_absent = "empty"
script = "echo.js"
[element.name]
kind = "text"
metric = "model.name"
width = 6
min_width = 6
`, {
      "echo.js": "function render(i) { return { state: { value: i.value, standIn: i.standIn } }; }",
      "row.js": "function render(i) { return { state: { children: i.children.map(function (k) { return [k.id, k.value, k.standIn]; }) } }; }",
    }));
    const state = new Map();
    // Generous budgets: the check needs the scripts to run even on a loaded machine.
    const slow = createScriptHost({ callBudgetMs: 2000, graceMs: 2000, startupMs: 10000 });
    let r;
    try { r = run(fitOf(skin), { state, host: slow, pass: createScriptPass({ budgetMs: 60000, callBudgetMs: 10000 }) }); } finally { slow.close(); }
    ok(r.warnings.length === 0 && same(state.get("xp")?.state, { value: null, standIn: "empty" }),
      `the script gets value null and standIn "empty" (${JSON.stringify(state.get("xp"))})`);
    ok(same(state.get("bar")?.state, { children: [["xp", null, "empty"], ["name", "Opus", null]] }),
      "a container's script sees which children draw a stand-in, and null for the others");
  }

  console.log("a hotbar whose highlight script picks a cell");
  {
    const skin = load(userSkin("hotbar-pick", hotbar("pick.js"), { "pick.js": "function render(i) { return { selected: 1 }; }" }));
    const fit = fitOf(skin);
    const bare = drawFit(fit, { values: VALUES, width: WIDTH, ctx: CTX });
    const r = run(fit);
    const lines = draw(r);
    ok(r.warnings.length === 0, "a script that returns draws no warning");
    ok(lines.some((l) => plain(l).includes("═")) && !bare.some((l) => plain(l).includes("═")),
      "the cell the script selects is drawn with the selected lines");
    ok(same(lines.map(vlen), bare.map(vlen)), "and the bar keeps its width");
  }

  console.log("a highlight script that never returns (it loops)");
  {
    const skin = load(userSkin("hotbar-loop", hotbar("loop.js"), { "loop.js": "function render() { for (;;) {} }" }));
    const fit = fitOf(skin);
    const bare = drawFit(fit, { values: VALUES, width: WIDTH, ctx: CTX });
    const spy = spied(loopHost);
    const last = () => spy.statuses[spy.statuses.length - 1];
    const r = run(fit, { host: spy });
    ok(same(last(), ["timeout"]), `the script runs past its budget (${last()})`);
    ok(same(draw(r), bare), "the hotbar draws without a highlighted cell and every other element is unchanged");
    ok(r.warnings.length === 1 && r.warnings[0].element === "hotbar" && /loop\.js/.test(r.warnings[0].message)
      && typeof r.warnings[0].key === "string", `one warning naming the element's script (${r.warnings[0]?.message})`);
    ok(/stopped/.test(r.warnings[0].message) && /for 30 s, then retried/.test(r.warnings[0].message),
      "it says the script was stopped and will be tried again in 30 s");
    const again = run(fit, { host: spy });
    ok(same(draw(again), bare), "on the next pass it still draws its default");
    ok(same(last(), ["disabled"]), `on the next pass the script is not called (${last()})`);
    ok(again.warnings.length === 1 && again.warnings[0].key === r.warnings[0].key,
      "the warning stays the same cause, so it is not shown anew");
    ok(again.warnings[0].message === r.warnings[0].message, `and still says why it failed (${again.warnings[0].message})`);
    // The skin changes: the script runs again (and runs past its budget again).
    const t2 = new Date(Date.now() + 5000);
    utimesSync(skin.file, t2, t2);
    const reloaded = load(skin.file);
    run(fitOf(reloaded), { host: spy });
    ok(same(last(), ["timeout"]), `once the skin changes, the script is run again (${last()})`);
  }

  console.log("a script that returns a frame name");
  {
    const toml = `version = 1
root = "bar"
[element.bar]
kind = "row"
children = ["face"]
[element.face]
kind = "animation"
metric = "model.name"
frames = "mugshot"
default_frame = "idle"
script = "face.js"
`;
    const skin = load(userSkin("face", toml, { "face.js": "function render(i) { return { frame: \"STFKILL0\" }; }" }));
    const fit = fitOf(skin);
    const resolveAsset = (ref) => (ref === "mugshot" ? WAD : ref === "idle" ? path.join(WAD, "STFST01.png") : null);
    const ctx = { ...CTX, resolveAsset };
    const r = run(fit, { resolveAsset });
    const node = fit.tree.children[0];
    const want = VISUALS.animation.draw({ params: node.node.params, width: node.width, height: node.rows, ctx, script: { frame: "STFKILL0" } });
    const idle = VISUALS.animation.draw({ params: node.node.params, width: node.width, height: node.rows, ctx });
    const lines = drawFit(r.fit, { values: VALUES, width: WIDTH, ctx, scripts: r.scripts });
    ok(lines.some((l) => l.includes(want[0])) && !same(want, idle), "the animation draws the frame the script names");

    console.log("one-shot mode: no script runs");
    const oneShot = drawFit(fit, { values: VALUES, width: WIDTH, ctx });
    ok(oneShot.some((l) => l.includes(idle[0])) && idle.some((l) => plain(l).trim()),
      "an animation drawn without its script draws its default frame");
  }

  console.log("a script returning characters wider than its element");
  {
    const skin = load(userSkin("wide", oneText("wide.js"), { "wide.js": "function render() { return { params: { icon: \"ABCDEFGHIJKLMNOPQRSTUVWXYZ\" } }; }" }));
    const fit = fitOf(skin);
    const bare = drawFit(fit, { values: VALUES, width: WIDTH, ctx: CTX });
    const r = run(fit);
    const lines = draw(r);
    ok(plain(lines[0]).includes("ABC"), "the characters the script returns are drawn");
    ok(!plain(lines[0]).includes("ABCDEFGHIJ"), `but only as many as the element's ${nodeWidth(fit, "name")} columns`);
    ok(same(lines.map(vlen), bare.map(vlen)) && plain(lines[0]).trimEnd().endsWith("Opus"), "the bar keeps its width and the next element its place");
  }

  console.log("a script that keeps a counter in its state");
  {
    const counter = "function render(i) { var n = (i.state && i.state.n || 0) + 1; return { params: { icon: \"#\" + n }, state: { n: n } }; }";
    const file = userSkin("counter", oneText("counter.js", { width: 12 }), { "counter.js": counter });
    const shown = (r) => plain(draw(r)[0]);
    const one = new Map(), two = new Map();
    let fit = fitOf(load(file));
    run(fit, { state: one });
    run(fit, { state: one });
    ok(shown(run(fit, { state: one })).includes("#3"), "the counter increases across passes for one session");
    ok(shown(run(fit, { state: two })).includes("#1"), "and starts fresh for another");
    const later = new Date(Date.now() + 9000);
    utimesSync(file, later, later);
    fit = fitOf(load(file));
    ok(shown(run(fit, { state: one })).includes("#1"), "and starts fresh when the skin changes");
  }

  console.log("what a script receives");
  {
    const echo = "function render(i) { return { state: i }; }";
    const skin = load(userSkin("echo", oneText("echo.js", { icon: "*" }), { "echo.js": echo }));
    const fit = fitOf(skin);
    const state = new Map();
    run(fit, { state, reaction: { expr: "grin", flash: null } });
    const got = [...state.values()][0]?.state || {};
    ok(got.value === "Opus" && got.metric === "model.name", "its element's metric and raw value");
    ok(got.params && got.params.icon === "*" && got.width === nodeWidth(fit, "name"), "its parameters and the width it was fitted to");
    ok(got.tick === NOW && got.now === NOW && got.reaction && got.reaction.expr === "grin", "the time, the tick and the reaction");
  }

  console.log("a script outside the skin's folder");
  {
    const fresh = createScriptHost();
    writeFileSync(path.join(USER, "skins", "outside.js"), "function render() { return { params: { icon: \"OUT\" } }; }");
    const skin = load(userSkin("escape", oneText("../outside.js")));
    const fit = fitOf(skin);
    const r = run(fit, { host: fresh });
    ok(r.warnings.length === 1 && /outside/.test(r.warnings[0].message), `is refused with a warning (${r.warnings[0]?.message})`);
    ok(!plain(draw(r)[0]).includes("OUT") && fresh.spawns === 0, "and is never run");
    fresh.close();
  }

  console.log("a script that names a game's asset");
  {
    const fresh = roomyHost();
    const skin = load(userSkin("asset-ref", oneText("doom:scripts/name.js")));
    const fit = fitOf(skin);
    const r = run(fit, { host: fresh });
    ok(r.warnings.length === 0 && fresh.spawns === 0 && same(draw(r), drawFit(fit, { values: VALUES, width: WIDTH, ctx: CTX })),
      "draws its default while the asset cannot be found");
    const script = path.join(USER, "skins", "asset-ref", "found.js");
    writeFileSync(script, "function render() { return { params: { icon: \"FOUND\" } }; }");
    const found = run(fit, { host: fresh, resolveAsset: (ref) => (ref === "doom:scripts/name.js" ? script : null) });
    ok(plain(draw(found)[0]).includes("FOUND"), "and runs it once the asset resolves");
    fresh.close();
  }

  console.log("no budget left in the pass");
  {
    const fresh = roomyHost();
    const skin = load(userSkin("no-budget", oneText("nb.js"), { "nb.js": "function render() { return { params: { icon: \"RAN\" } }; }" }));
    const fit = fitOf(skin);
    const r = run(fit, { host: fresh, pass: createScriptPass({ budgetMs: 0 }) });
    ok(r.warnings.length === 0 && !plain(draw(r)[0]).includes("RAN") && fresh.spawns === 0,
      "every element draws its default, with no warning and nothing run");
    ok(!fresh.isDisabled(path.join(USER, "skins", "no-budget", "nb.js"), "x") && plain(draw(run(fit, { host: fresh, pass: roomyPass() }))[0]).includes("RAN"),
      "and the script runs on the next pass");
    fresh.close();
  }

  console.log("the pass counts only the time scripts take");
  {
    const skin = load(userSkin("rest-of-render", oneText("rr.js"), { "rr.js": "function render() { return { params: { icon: \"RAN\" } }; }" }));
    const fit = fitOf(skin);
    run(fit, { pass: roomyPass() }); // the worker is up
    // A budget a loaded machine cannot use up on one trivial call, and more time than that spent
    // outside the scripts: only the second may not count.
    const pass = createScriptPass({ budgetMs: 1000, callBudgetMs: 1000 });
    const t = performance.now();
    while (performance.now() - t < 1100) { /* the rest of a render, outside the scripts */ }
    const r = run(fit, { pass });
    ok(plain(draw(r)[0]).includes("RAN") && pass.left() > 0 && pass.left() <= 1000,
      `the rest of the render does not use up the scripts' time (${pass.left().toFixed(1)} ms left)`);
  }

  console.log("a skin without scripts");
  {
    const fresh = createScriptHost();
    const skin = load(userSkin("plain", oneText("").replace(/^script = ""\n/m, "")));
    const fit = fitOf(skin);
    const r = run(fit, { host: fresh });
    ok(r.fit === fit && same(r.scripts, {}) && r.warnings.length === 0 && fresh.spawns === 0, "is drawn as fitted, and no worker starts");
    fresh.close();
  }

  console.log("renderSession");
  {
    userSkin("session-loop", oneText("loop.js"), { "loop.js": "function render() { for (;;) {} }" });
    userSkin("session-icon", oneText("icon.js", { width: 12 }), { "icon.js": "function render(i) { return { params: { icon: \"SCRIPTED\" } }; }" });
    const env = { ...process.env, COLUMNS: "120", GAMEBAR_SKIN: "session-icon" };
    const data = { model: { display_name: "Opus" } };
    const scripted = renderSession({ data, env, now: NOW, scripts: { host, pass: roomyPass(), state: new Map() } });
    ok(scripted.some((l) => plain(l).includes("SCRIPTED")), "a skin's script changes the session's bar");
    const skipped = renderSession({ data, env, now: NOW, scripts: false });
    ok(!skipped.some((l) => plain(l).includes("SCRIPTED")), "with scripts turned off nothing runs");
    const loopEnv = { ...env, GAMEBAR_SKIN: "session-loop" };
    const failed = renderSession({ data, env: loopEnv, now: NOW, scripts: { host: loopHost, pass: roomyPass(), state: new Map() } });
    ok(failed.some((l) => /gamebar: .*loop\.js/.test(plain(l))), "a failed script shows on the warning line");

    // The one-shot status line, a new process each render: no script runs and no warning shows.
    const res = spawnSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
      input: JSON.stringify(data), encoding: "utf8", timeout: 20000,
      env: { ...process.env, COLUMNS: "120", GAMEBAR_SKIN: "session-icon", GAMEBAR_MSYS_REAP: "0" },
    });
    ok(res.status === 0 && plain(res.stdout).includes("Opus") && !plain(res.stdout).includes("SCRIPTED"),
      `the one-shot status line draws the skin without running its script (${JSON.stringify(plain(res.stdout).slice(0, 80))})`);
    const res2 = spawnSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
      input: JSON.stringify(data), encoding: "utf8", timeout: 20000,
      env: { ...process.env, COLUMNS: "120", GAMEBAR_SKIN: "session-loop", GAMEBAR_MSYS_REAP: "0" },
    });
    ok(res2.status === 0 && !/gamebar:/.test(plain(res2.stdout)), "and a looping script there shows no warning, since it never runs");
  }
} finally {
  host.close();
  loopHost.close();
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
