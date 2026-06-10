#!/usr/bin/env node
import { setValues, metricFixedWidth } from "../src/render.js";
let fails = 0;
const ok = (c, m) => { console.log((c?"  ok   ":"  FAIL ")+m); if(!c) fails++; };

// metricFixedWidth handles the object item shape (mark + text), truncated by box later.
setValues({ "act.tasklist": [{ mark:"✓", markRgb:null, text:"render engine" }] });
const w = metricFixedWidth({ id:"act.tasklist", render:"scroll" });
ok(typeof w === "number" && w >= "render engine".length, `scroll width measures mark+text (got ${w})`);

// Empty scroll value -> width is just the (absent) label, and box should be hidden via available.
setValues({});
ok(metricFixedWidth({ id:"act.tasklist", render:"scroll" }) === 0, "empty scroll -> zero width");

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
