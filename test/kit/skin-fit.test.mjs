#!/usr/bin/env node
// The fit: a loaded skin, the session's values and the terminal's width become the tree that is
// drawn. Elements take their natural widths when there is room, shrink towards their minimum when
// there is not, then drop by the skin's priorities, lowest first; a skin that still does not fit
// gives way to the smaller skin it names, and the last skin of that chain is drawn clipped.

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
const { fitSkin } = await import("../../src/kit/skin/fit.js");

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

  console.log("widths come from parameters, not from values");
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
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
