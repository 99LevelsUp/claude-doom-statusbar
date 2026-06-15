#!/usr/bin/env node
import { marquee, vlen } from "../src/render.js";
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

// Fits -> returned verbatim, padded to exactly width, constant across ticks.
ok(marquee("abc", 5, 0) === "abc  ", "short text padded to width");
ok(marquee("abc", 5, 7) === "abc  ", "short text is tick-invariant");
ok(vlen(marquee("abc", 5, 99)) === 5, "fit result is exactly width cols");

// Overflow -> every tick yields exactly `width` columns (row-width invariant).
{
  const text = "ABCDEFGHIJ"; // vlen 10
  const W = 4;
  const widths = new Set();
  const seen = new Set();
  for (let t = 0; t < 60; t++) {
    const out = marquee(text, W, t);
    widths.add(vlen(out));
    seen.add(out);
  }
  ok(widths.size === 1 && widths.has(W), `overflow: every tick is exactly ${W} cols`);
  ok(seen.has("ABCD"), "overflow: reaches the start (ABCD)");
  ok(seen.has("GHIJ"), "overflow: reaches the end (GHIJ)");
  ok(seen.size > 2, "overflow: window actually moves through several positions");
}

// Ping-pong: offset rises to the far end then falls back (not a one-way wrap).
{
  const text = "0123456789";
  const W = 4;            // span = 6
  const at = (t) => marquee(text, W, t);
  // collect the leading-char index across a full cycle to trace direction
  const lead = [];
  for (let t = 0; t < 2 * (3 + 6) + 2; t++) lead.push(text.indexOf(at(t).trim()[0]));
  const maxAt = lead.indexOf(Math.max(...lead));
  const rose = lead.slice(0, maxAt + 1).every((v, i, a) => i === 0 || v >= a[i - 1]);
  const fell = lead.slice(maxAt).every((v, i, a) => i === 0 || v <= a[i - 1]);
  ok(rose && fell, "ping-pong: offset rises to a peak then falls back");
}

// Never splits a 2-col glyph; result stays exactly width across all ticks.
{
  const text = "🤖🤖🤖ab"; // three 2-col emoji + 2 ascii = 8 cols
  let allExact = true;
  for (let t = 0; t < 30; t++) if (vlen(marquee(text, 5, t)) !== 5) allExact = false;
  ok(allExact, "emoji window: exactly 5 cols every tick (no split glyph)");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
