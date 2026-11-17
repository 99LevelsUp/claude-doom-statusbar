#!/usr/bin/env node
// The fit: a loaded skin, the session's values and the terminal's width and height become the tree
// that is drawn. Elements take their natural widths when there is room, shrink towards their minimum
// when there is not, then drop by the skin's priorities, lowest first; a skin that still does not
// fit, or is taller than the rows it may take, gives way to the smaller skin it names, and the last
// skin of that chain is drawn as it is (clipped when it is too wide).

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-skin-fit-"));
Object.assign(process.env, { ...sandboxEnv(SB) });

const { loadSkin, buildSkin } = await import("../../src/kit/skin/load.js");
const { fitSkin, isEmptyValue } = await import("../../src/kit/skin/fit.js");

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "skins");
const fixture = (name) => path.join(FIX, name);
const byName = (name) => loadSkin(fixture(`${name}.toml`)).skin;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (got, want) => (same(got, want) ? "" : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
// Ids of the fitted tree in depth-first order, and the width each one got.
const ids = (t) => (t ? [t.id, ...t.children.flatMap(ids)] : []);
const widths = (t) => (t ? { [t.id]: t.width, ...Object.assign({}, ...t.children.map(widths)) } : {});
// A skin from a table of elements, root "bar".
const inline = (element, extra = {}) => {
  const { skin, warnings } = buildSkin({ version: 1, root: "bar", ...extra, element });
  if (warnings.length) throw new Error(JSON.stringify(warnings));
  return skin;
};
const txt = (metric, w, more = {}) => ({ kind: "text", metric, width: w, min_width: w, ...more });

const VALUES = { "model.name": "Opus", "model.window": "1M", "act.subagents": [["review", "12s"]] };

try {
  console.log("a skin that needs 140 columns at its minimum, AGENTS at the lowest priority");
  {
    const wide = byName("fit-wide");
    const fit = (width) => fitSkin(wide, { values: VALUES, width, loadSmaller: byName });

    const at200 = fit(200);
    ok(at200.skin === wide && same(at200.dropped, []) && !at200.clipped, "at 200 columns the skin is drawn whole");
    const natural = { bar: 150, model: 50, "model-name": 48, context: 40, window: 38, agents: 60, subagents: 58 };
    ok(at200.width === 150 && same(widths(at200.tree), natural),
      `at 200 columns every element takes its natural width${show(widths(at200.tree), natural)}`);

    const at145 = fit(145);
    ok(same(at145.dropped, []) && at145.width === 145 && at145.tree.children[0].width === 45,
      "at 145 columns nothing drops; the elastic text shrinks towards its minimum instead");

    const at120 = fit(120);
    ok(at120.skin === wide && same(at120.dropped, ["agents"]), `at 120 columns the AGENTS box is dropped first${show(at120.dropped, ["agents"])}`);
    ok(same(ids(at120.tree), ["bar", "model", "model-name", "context", "window"]) && at120.width === 90,
      "the dropped box takes its list with it, and the rest is back at its natural width");

    const at60 = fit(60);
    ok(at60.skin.name === "fit-narrow" && !at60.clipped, `at 60 columns, nothing droppable left, the smaller skin is drawn${show(at60.skin?.name, "fit-narrow")}`);
    ok(same(ids(at60.tree), ["bar", "model-name"]) && at60.width === 30, "the smaller skin is fitted on its own, at its natural width");
    ok(same(at60.warnings, []), "following the smaller skin warns about nothing");

    const at10 = fit(10);
    ok(at10.skin.name === "fit-narrow" && at10.clipped && at10.width === 20,
      "at 10 columns the last skin of the chain is drawn at its minimum width, clipped");
  }

  console.log("two elements with the same priority");
  {
    const skin = inline({
      bar: { kind: "row", children: ["a", "b", "c"] },
      a: txt("model.name", 10, { priority: 1 }),
      b: txt("model.window", 10, { priority: 1 }),
      c: txt("git.branch", 10, { priority: 2 }),
    });
    const values = { "model.name": "x", "model.window": "y", "git.branch": "z" };
    const fit = fitSkin(skin, { values, width: 25 });
    ok(same(fit.dropped, ["b"]) && same(ids(fit.tree), ["bar", "a", "c"]), `the later one in document order drops first${show(fit.dropped, ["b"])}`);
    const tighter = fitSkin(skin, { values, width: 15 });
    ok(same(tighter.dropped, ["b", "a"]), `then the earlier one, before any higher priority${show(tighter.dropped, ["b", "a"])}`);
  }

  console.log("\"keep\", and containers emptied by drops");
  {
    const skin = inline({
      bar: { kind: "row", children: ["kept", "low"] },
      kept: txt("model.name", 30, { priority: "keep" }),
      low: txt("model.window", 10, { priority: 1 }),
    });
    const fit = fitSkin(skin, { values: { "model.name": "x", "model.window": "y" }, width: 20 });
    ok(same(fit.dropped, ["low"]) && same(ids(fit.tree), ["bar", "kept"]) && fit.clipped,
      "an element marked keep is not dropped on its own, even when the bar is drawn clipped");

    const nested = inline({
      bar: { kind: "row", children: ["group", "other"] },
      group: { kind: "row", children: ["kept", "inner"], priority: 1 },
      kept: txt("model.name", 10, { priority: "keep" }),
      inner: txt("model.window", 10, { priority: 5 }),
      other: txt("git.branch", 10, { priority: 2 }),
    });
    const values = { "model.name": "x", "model.window": "y", "git.branch": "z" };
    const n = fitSkin(nested, { values, width: 15 });
    ok(same(n.dropped, ["group"]) && same(ids(n.tree), ["bar", "other"]), `a kept element goes when its container drops${show(n.dropped, ["group"])}`);

    const emptied = inline({
      bar: { kind: "row", children: ["box", "stay"] },
      box: { kind: "row", children: ["m", "k"], frame: { kind: "box", padding: 3 } },
      m: txt("model.name", 10, { priority: 1 }),
      k: txt("model.window", 10, { priority: 2 }),
      stay: txt("git.branch", 10, { priority: "keep" }),
    });
    const e = fitSkin(emptied, { values, width: 12 });
    ok(same(e.dropped, ["m", "k", "box"]) && same(ids(e.tree), ["bar", "stay"]) && e.width === 10 && !e.clipped,
      `a container whose children all dropped drops too, its frame with it${show(e.dropped, ["m", "k", "box"])}`);
  }

  console.log("a smaller-skin chain that comes back to itself");
  {
    const calls = [];
    const load = (name) => { calls.push(name); return byName(name); };
    const fit = fitSkin(byName("cycle-a"), { values: VALUES, width: 60, loadSmaller: load });
    ok(same(calls, ["cycle-b"]), `the chain stops at the repeat, never loading a skin twice${show(calls, ["cycle-b"])}`);
    ok(fit.skin.name === "cycle-b" && fit.clipped && fit.width === 70, "the last skin tried is drawn clipped");
    ok(fit.warnings.length === 1 && fit.warnings[0].cause === "smaller-cycle" && fit.warnings[0].subject === "cycle-a"
      && fit.warnings[0].skin === fixture("cycle-b.toml") && fit.warnings[0].message.includes("cycle-a"),
      `one warning names the cycle (${fit.warnings.map((w) => w.message).join("; ")})`);
    ok(same(fitSkin(byName("cycle-a"), { values: VALUES, width: 60, loadSmaller: byName }).warnings[0].key, fit.warnings[0].key),
      "the warning has the same key on every render");
    const missing = fitSkin(byName("cycle-a"), { values: VALUES, width: 60, loadSmaller: () => null });
    ok(missing.skin.name === "cycle-a" && missing.clipped, "a smaller skin that cannot be loaded ends the chain at the skin before it");
  }

  console.log("a skin too tall for the rows goes down its chain");
  {
    // tall: a column of four rows, 10 columns wide; low: the same in one row, 23 columns wide.
    const four = { a: txt("model.name", 10), b: txt("model.window", 10), c: txt("model.name", 10), d: txt("model.window", 10) };
    const tall = inline({ bar: { kind: "column", children: ["a", "b", "c", "d"] }, ...four }, { name: "tall", smaller: "low" });
    const low = inline({ bar: { kind: "row", separator: " ", children: ["a", "b"] }, a: four.a, b: four.b }, { name: "low" });
    const chain = (name) => ({ low }[name] ?? null);
    const fit = (rows, width = 100) => fitSkin(tall, { values: VALUES, width, rows, loadSmaller: chain });
    ok(fitSkin(tall, { values: VALUES, width: 100, loadSmaller: chain }).skin === tall, "without a row limit the height does not count");
    ok(fit(4).skin === tall && fit(4).tree.rows === 4, "a skin exactly as tall as the limit stays");
    const short = fit(3);
    ok(short.skin === low && short.tree.rows === 1 && !short.clipped && same(short.dropped, []),
      "one row too many and the smaller skin is drawn, whole");
    ok(fit(0).skin === low && !fit(0).clipped, "the last skin of the chain is drawn even when it is still too tall");
    ok(fitSkin(tall, { values: VALUES, width: 100, rows: 3 }).skin === tall, "a skin with no smaller skin is drawn as tall as it is");
    // Width and height together: low fits 3 rows but not 15 columns, so it is drawn clipped.
    const both = fit(3, 15);
    ok(both.skin === low && both.clipped, "a smaller skin that is low enough but too wide is drawn clipped");
  }

  console.log("widths do not follow the length of texts or lists");
  {
    const wide = byName("fit-wide");
    const short = fitSkin(wide, { values: VALUES, width: 120, loadSmaller: byName });
    const long = fitSkin(wide, {
      values: { "model.name": "a model name far longer than its box".repeat(3), "model.window": "1M".repeat(40),
        "act.subagents": Array.from({ length: 9 }, (_, i) => [`agent with a long description ${i}`.repeat(4), "1h"]) },
      width: 120, loadSmaller: byName,
    });
    ok(same(short.dropped, long.dropped) && same(widths(short.tree), widths(long.tree)),
      "the same skin and width drop the same elements whatever the length of the texts");
  }

  console.log("metrics the session does not report");
  {
    const skin = inline({
      bar: { kind: "row", children: ["name", "branch", "tasks"] },
      name: txt("model.name", 10),
      branch: txt("git.branch", 10),
      tasks: { kind: "scroll-list", metric: "act.tasklist", width: 12, min_width: 12 },
    });
    const fit = fitSkin(skin, { values: { "model.name": "x" }, width: 100 });
    ok(same(ids(fit.tree), ["bar", "name", "tasks"]) && same(fit.absent, ["branch"]), "an absent metric's element is not in the tree");
    ok(fit.width === 22, "and takes no space; a list with no items keeps its place");

    const boxed = inline({
      bar: { kind: "row", children: ["box", "name"] },
      box: { kind: "row", children: ["branch"], frame: { kind: "box" } },
      branch: txt("git.branch", 10),
      name: txt("model.name", 10),
    });
    const b = fitSkin(boxed, { values: { "model.name": "x" }, width: 100 });
    ok(same(ids(b.tree), ["bar", "name"]) && b.width === 10, "a container left with nothing to show goes with it");
  }

  console.log("an absent metric: hidden by default, kept by when_absent");
  {
    const skin = inline({
      bar: { kind: "row", children: ["hidden", "empty", "full", "name"] },
      hidden: txt("ratelimit.5h", 4),
      empty: { ...txt("ratelimit.7d", 6), when_absent: "empty" },
      full: { kind: "icon-row", metric: "ratelimit.5h", count: 5, when_absent: "full" },
      name: txt("model.name", 3),
    });
    const f = fitSkin(skin, { values: { "model.name": "x" }, width: 100 });
    ok(same(ids(f.tree), ["bar", "empty", "full", "name"]) && same(f.absent, ["hidden"]),
      `hide removes the element, empty and full keep it${show(ids(f.tree), ["bar", "empty", "full", "name"])}`);
    ok(same(widths(f.tree), { bar: 14, empty: 6, full: 5, name: 3 }), "a kept element takes its normal widths");
  }

  console.log("what counts as nothing to show");
  {
    for (const v of [undefined, null, [], ""]) ok(isEmptyValue(v), `${JSON.stringify(v) ?? "undefined"} is nothing to show`);
    for (const v of [0, false, "x", [0], [[]], { text: "", url: null }, { text: "main", url: null }]) ok(!isEmptyValue(v), `${JSON.stringify(v)} is something to show`);
  }

  console.log("a box is never narrower than its title");
  {
    const skin = inline({
      bar: { kind: "row", children: ["box"] },
      box: { kind: "column", frame: { kind: "box", title: "ACTIVITY", padding: 1 }, children: ["n"] },
      n: txt("model.name", 2),
    });
    const wide = fitSkin(skin, { values: { "model.name": "x" }, width: 100 });
    ok(wide.width === 10 && same(widths(wide.tree), { bar: 10, box: 10, n: 2 }),
      `a box whose children are narrower than its title takes the title and its padding${show(widths(wide.tree), { bar: 10, box: 10, n: 2 })}`);
    const narrow = fitSkin(skin, { values: { "model.name": "x" }, width: 6 });
    ok(narrow.clipped && narrow.width === 10, "and that is its minimum too: at 6 columns it is drawn clipped, not narrower");
    const bare = inline({
      bar: { kind: "row", children: ["box"] },
      box: { kind: "column", frame: { kind: "box", title: "ACTIVITY", header: false }, children: ["n"] },
      n: txt("model.name", 2),
    });
    ok(fitSkin(bare, { values: { "model.name": "x" }, width: 100 }).width === 4, "a box that draws no title row is as wide as its children and padding");
  }

  console.log("when_empty: a container with nothing to show");
  {
    const lists = (mode, more = {}) => inline({
      bar: { kind: "row", children: ["agents", "name"] },
      agents: { kind: "row", frame: { kind: "box", title: "AGENTS" }, children: ["list"], ...(mode ? { when_empty: mode } : {}), ...more },
      list: { kind: "scroll-list", metric: "act.subagents", width: 20, min_width: 16, rows: 3 },
      name: txt("model.name", 10),
    });
    const empty = { "model.name": "x", "act.subagents": [] };
    const full = { "model.name": "x", "act.subagents": [["review", "12s"]] };

    const keep = fitSkin(lists(null), { values: empty, width: 100 });
    ok(same(widths(keep.tree), { bar: 32, agents: 22, list: 20, name: 10 }), `keep, the default, holds its fitted width${show(widths(keep.tree), { bar: 32, agents: 22, list: 20, name: 10 })}`);

    const shrink = fitSkin(lists("shrink"), { values: empty, width: 100 });
    ok(same(ids(shrink.tree), ["bar", "agents", "name"]) && same(widths(shrink.tree), { bar: 18, agents: 8, name: 10 }),
      `shrink draws an empty box at its minimum, the title and padding, without its children${show(widths(shrink.tree), { bar: 18, agents: 8, name: 10 })}`);
    ok(shrink.tree.children[0].rows === keep.tree.children[0].rows, "and as many rows tall as with its children, so the bar keeps its height");
    const shown = fitSkin(lists("shrink"), { values: full, width: 100 });
    ok(same(widths(shown.tree), widths(keep.tree)), "with something in its list it takes its fitted width again");
    const absentList = fitSkin(lists("shrink"), { values: { "model.name": "x" }, width: 100 });
    ok(same(widths(absentList.tree), widths(shrink.tree)), "an absent list is nothing to show as well");

    const texts = inline({
      bar: { kind: "row", children: ["box", "name"] },
      box: { kind: "column", frame: { kind: "box", title: "GIT" }, when_empty: "shrink", children: ["branch", "pr"] },
      branch: txt("git.branch", 10),
      pr: txt("pr.state", 10),
      name: txt("model.name", 10),
    });
    const gone = fitSkin(texts, { values: { "model.name": "x" }, width: 100 });
    const there = fitSkin(texts, { values: { "model.name": "x", "git.branch": "main", "pr.state": "#1" }, width: 100 });
    ok(same(ids(gone.tree), ["bar", "box", "name"]) && gone.tree.children[0].width === 5 && gone.tree.children[0].rows === there.tree.children[0].rows,
      `a box shrinks, not vanishes, when its metrics are all absent: its title, as tall as with them${show(ids(gone.tree), ["bar", "box", "name"])}`);

    const hide = fitSkin(lists("hide"), { values: empty, width: 100 });
    ok(same(ids(hide.tree), ["bar", "name"]) && hide.width === 10 && hide.absent.includes("agents"),
      `hide removes it like an absent element, its space going to the others${show(ids(hide.tree), ["bar", "name"])}`);

    const long = { "model.name": "x", "act.subagents": Array.from({ length: 9 }, (_, i) => [`a much longer agent label ${i}`.repeat(3), "1h"]) };
    ok(same(widths(fitSkin(lists("shrink"), { values: long, width: 100 }).tree), widths(shown.tree)),
      "whether a list is empty moves the layout; how long it is or what it says does not");

    const nested = inline({
      bar: { kind: "row", children: ["outer", "name"] },
      outer: { kind: "column", frame: { kind: "box", title: "LISTS" }, when_empty: "shrink", children: ["inner", "tasks"] },
      inner: { kind: "row", when_empty: "hide", children: ["list"] },
      list: { kind: "scroll-list", metric: "act.subagents", width: 20, rows: 1 },
      tasks: { kind: "scroll-list", metric: "act.tasklist", width: 20, rows: 1 },
      name: txt("model.name", 10),
    });
    const n = fitSkin(nested, { values: { ...empty, "act.tasklist": [] }, width: 100 });
    ok(same(ids(n.tree), ["bar", "outer", "name"]) && n.tree.children[0].width === 7,
      `a container whose children are a hidden container and an empty list is empty too${show(ids(n.tree), ["bar", "outer", "name"])}`);

    const standIn = inline({
      bar: { kind: "row", children: ["box", "name"] },
      box: { kind: "row", frame: { kind: "box", title: "XP" }, when_empty: "hide", children: ["xp"] },
      xp: { kind: "progress", metric: "ratelimit.7d", when_absent: "full" },
      name: txt("model.name", 10),
    });
    ok(same(ids(fitSkin(standIn, { values: { "model.name": "x" }, width: 100 }).tree), ["bar", "name"]),
      "an element drawing a when_absent stand-in has nothing to show");

    const own = inline({
      bar: { kind: "row", children: ["box", "name"] },
      box: { kind: "row", frame: { kind: "box", title: "X" }, when_empty: "hide", children: ["label", "list"] },
      label: { kind: "text", width: 4, min_width: 4 },
      list: { kind: "scroll-list", metric: "act.subagents", width: 20, rows: 1 },
      name: txt("model.name", 10),
    });
    ok(same(ids(fitSkin(own, { values: empty, width: 100 }).tree), ["bar", "box", "label", "list", "name"]),
      "an element bound to no metric draws something of its own, so its container is not empty");
  }

  console.log("grow: children given the width a container has to spare");
  {
    const skin = (grow) => inline({
      bar: { kind: "column", ...(grow ? { grow } : {}), children: ["cpu", "disk", "clock"] },
      cpu: { kind: "row", separator: " ", ...(grow ? { grow } : {}), children: ["cores", "total"] },
      cores: { kind: "equalizer", metric: "sys.cores", sizing: "values" },
      total: { kind: "number", metric: "sys.cpu", width: 4, align: "right" },
      disk: { kind: "progress", metric: "sys.disk", icon: "D" },
      clock: txt("sys.clock", 5),
    });
    const values = { "sys.cores": [0.1, 0.2, 0.3, 0.4], "sys.cpu": 12, "sys.disk": 60, "sys.clock": "14:23" };
    const own = fitSkin(skin(null), { values, width: 100 });
    ok(same(widths(own.tree), { bar: 21, cpu: 9, cores: 4, total: 4, disk: 21, clock: 5 }),
      `none, the default: each child of a column keeps its own width${show(widths(own.tree), { bar: 21, cpu: 9, cores: 4, total: 4, disk: 21, clock: 5 })}`);
    const fill = fitSkin(skin("fill"), { values, width: 100 });
    ok(same(widths(fill.tree), { bar: 21, cpu: 21, cores: 4, total: 16, disk: 21, clock: 21 }),
      `fill: every child of the column takes its width; in the row the surplus goes to the children that can grow${show(widths(fill.tree), { bar: 21, cpu: 21, cores: 4, total: 16, disk: 21, clock: 21 })}`);
  }
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
