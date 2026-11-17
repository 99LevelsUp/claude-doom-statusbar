#!/usr/bin/env node
// Scrolling lists and text that scrolls back and forth, in the DOOM bar: the window a long list
// shows, every row of the bar as wide as the others whatever scrolls, and a linked value that
// scrolls without breaking its hyperlink.
import "../_temp-sandbox.mjs"; // before the modules that name temp paths
import { RAW_SAMPLE } from "../_raw-sample.mjs";
import { scrollWindow, vlen } from "../../src/kit/text.js";
import { findGame } from "../../src/games/index.js";
import { findSkin } from "../../src/skin-select.js";
import { loadSkin } from "../../src/kit/skin/load.js";
import { fitSkin } from "../../src/kit/skin/fit.js";
import { drawFit } from "../../src/kit/skin/draw.js";
import { createAssetResolver } from "../../src/platform/assets.js";

let fails = 0;
const ok = (c, m) => { console.log((c?"  ok   ":"  FAIL ")+m); if(!c) fails++; };

// scrollWindow(n, H, anchor, boundary) -> { start, up, down }
let r = scrollWindow(10, 4, "top", 0);
ok(r.start === 0 && r.down === 6 && r.up === 0, "top: start 0, 6 hidden below");
r = scrollWindow(3, 4, "top", 0);
ok(r.start === 0 && r.down === 0 && r.up === 0, "top: all fit -> no overflow");
r = scrollWindow(9, 5, "boundary", 4);     // B=4, H=5 -> start = 4 - 2 = 2
ok(r.start === 2 && r.up === 2 && r.down === 2, "boundary centered (start 2)");
r = scrollWindow(9, 5, "boundary", 1);     // few settled -> clamp start 0
ok(r.start === 0 && r.up === 0, "few settled -> top clamp");
r = scrollWindow(9, 5, "boundary", 8);     // few open -> clamp start N-H=4
ok(r.start === 4 && r.down === 0, "few open -> bottom clamp");
r = scrollWindow(4, 5, "boundary", 2);     // all fit
ok(r.start === 0 && r.up === 0 && r.down === 0, "boundary all-fit -> top aligned");

// The DOOM full skin drawn with `values` at `width` columns and render tick `tick`.
const doom = findGame("doom");
const resolveAsset = createAssetResolver({ folder: doom.dir }).resolve;
const full = loadSkin(findSkin("doom-full").file).skin;
const smaller = (name) => loadSkin(findSkin(name).file).skin;
function bar(values, width, tick = 0) {
  const fit = fitSkin(full, { values, width, loadSmaller: smaller });
  return drawFit(fit, { values, width, ctx: { tick, step: "octant", resolveAsset } });
}

// Every row of the bar has the same display width, even with an overflow marker (↑k / ↓k) on the
// first or last visible agent row.
{
  const longAgents = [];
  for (let i = 0; i < 12; i++) longAgents.push([`a-really-long-agent-label-${i}`, "1m2s"]);
  const lines = bar({ ...RAW_SAMPLE, "act.subagents": longAgents, "act.tasklist": [{ status: "completed", text: "x" }, { status: "pending", text: "y" }] }, 160);
  const widths = lines.map((l) => vlen(l));
  ok(new Set(widths).size === 1, `all rows equal width with an overflow marker (widths: ${[...new Set(widths)].join(",")})`);
  ok(lines.some((l) => l.includes("↓")), "a list longer than its rows shows how many items are below");
}

// A long scrolled label keeps every row equal width at every tick, and the visible window moves as
// the tick advances.
{
  const values = {
    ...RAW_SAMPLE,
    "act.subagents": [["a-really-long-agent-label-that-overflows-its-box", "1m2s"]],
    "act.tasklist": [{ status: "in_progress", text: "port-PIL-alpha-compositing-into-JS-render" }],
  };
  let uniform = true;
  const frames = new Set();
  for (let t = 0; t < 24; t++) {
    const lines = bar(values, 160, t);
    if (new Set(lines.map((l) => vlen(l))).size !== 1) uniform = false;
    frames.add(lines.join("\n"));
  }
  ok(uniform, "marquee: all rows stay equal width at every tick");
  ok(frames.size > 1, "marquee: the bar changes as the tick advances");
}

// Narrow: the boxes shrink, every row stays equal width across ticks, plain text scrolls, and a
// linked value scrolls too: its visible text is windowed but the hyperlink and its address stay
// whole.
{
  const url = "https://example.com/a/very/long/path";
  const inner = "a-very-long-linked-cwd-name";
  const values = {
    ...RAW_SAMPLE,
    "loc.cwd": { text: inner, url },
    "act.tasklist": [{ status: "in_progress", text: "port-PIL-alpha-compositing-into-JS-render" }],
  };
  let uniform = true;
  const frames = new Set();
  for (let t = 0; t < 18; t++) {
    const lines = bar(values, 120, t);
    if (new Set(lines.map((l) => vlen(l))).size !== 1) uniform = false;
    frames.add(lines.join("\n"));
  }
  ok(uniform, "narrow: all rows equal width across ticks");
  ok(frames.size > 1, "narrow: plain text still scrolls (frames change)");
  const out0 = bar(values, 120, 0).join("\n");
  ok(!out0.includes(`\x1b\\${inner}\x1b]8;;`), "narrow: the linked text is windowed (it scrolls)");
  ok(out0.includes(`\x1b]8;;${url}\x1b\\`) && out0.includes("\x1b]8;;\x1b\\"),
    "narrow: the hyperlink and its address survive the windowing");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
