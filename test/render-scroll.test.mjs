#!/usr/bin/env node
import { setValues, metricFixedWidth, scrollWindow } from "../src/render.js";
let fails = 0;
const ok = (c, m) => { console.log((c?"  ok   ":"  FAIL ")+m); if(!c) fails++; };

// metricFixedWidth handles the object item shape (mark + text), truncated by box later.
setValues({ "act.tasklist": [{ mark:"✓", markRgb:null, text:"render engine" }] });
const w = metricFixedWidth({ id:"act.tasklist", render:"scroll" });
ok(typeof w === "number" && w >= "render engine".length, `scroll width measures mark+text (got ${w})`);

// Empty scroll value -> width is just the (absent) label, and box should be hidden via available.
setValues({});
ok(metricFixedWidth({ id:"act.tasklist", render:"scroll" }) === 0, "empty scroll -> zero width");

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

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
