#!/usr/bin/env node
import { resolvePreset, setValues } from "../src/render.js";
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

// Synthetic presets whose min layout width is pinned by the box min_width, so fit is
// predictable regardless of scale: full ~42, standard ~27, minimal ~14 columns.
setValues({ x: "AA" });
const mk = (min, fallback) => ({
  bar: fallback ? { headers: false, fallback } : { headers: false },
  segment: [{ type: "box", min_width: min, metric: [{ id: "x", render: "text" }] }],
});
const chain = { full: mk(40, "standard"), standard: mk(25, "minimal"), minimal: mk(12, null) };
const load = (n) => chain[n] || null;

// Wide enough -> the chosen preset (ceiling) fits and is returned.
ok(resolvePreset(chain.full, 100, load) === chain.full, "wide -> ceiling (full)");

// Too narrow for full, fits standard -> falls back one step.
ok(resolvePreset(chain.full, 30, load) === chain.standard, "narrow -> standard");

// Narrower still -> falls back to minimal.
ok(resolvePreset(chain.full, 20, load) === chain.minimal, "narrower -> minimal");

// Below everything -> last (smallest) preset in the chain.
ok(resolvePreset(chain.full, 5, load) === chain.minimal, "sub-minimal -> minimal (last reached)");

// Stateless: same chain, different target -> different result, no carried state.
ok(
  resolvePreset(chain.full, 100, load) !== resolvePreset(chain.full, 20, load),
  "stateless: target alone determines the pick",
);

// Cycle guard: a -> b -> a terminates and returns a reached preset (no infinite loop).
{
  const cyc = {
    a: { bar: { headers: false, fallback: "b" }, segment: [{ type: "box", min_width: 200, metric: [{ id: "x", render: "text" }] }] },
    b: { bar: { headers: false, fallback: "a" }, segment: [{ type: "box", min_width: 200, metric: [{ id: "x", render: "text" }] }] },
  };
  const got = resolvePreset(cyc.a, 10, (n) => cyc[n]);
  ok(got === cyc.a || got === cyc.b, "cycle guard: terminates and returns a chain member");
}

// Missing fallback file: loader returns null -> chain ends at the chosen preset.
{
  const orphan = mk(200, "ghost");
  ok(resolvePreset(orphan, 10, () => null) === orphan, "missing fallback -> ends at chosen");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
