#!/usr/bin/env node
import { resolvePreset, planLayout, setValues, SAMPLE } from "../src/render.js";
import { parse as parseToml } from "smol-toml";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// resolvePreset must fit-test with the SAME sprite buildBar will render. The "turn"
// sprites (STFTL/STFTR) are 1 col wider than idle, so an idle-only fit test would
// under-measure the mugshot column: at the boundary width it keeps `full` even
// though `full` does not fit that sprite. The invariant: any selected preset that
// is not the last resort must itself pass planLayout with the SAME sprite. Without
// the spriteFor thread-through this fails at full's idle-vs-wide boundary width.
{
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "presets");
  const presets = {
    full: parseToml(readFileSync(path.join(root, "full.toml"), "utf8")),
    standard: parseToml(readFileSync(path.join(root, "standard.toml"), "utf8")),
    minimal: parseToml(readFileSync(path.join(root, "minimal.toml"), "utf8")),
  };
  const loadByName = (n) => presets[n] || null;
  const wide = () => "STFTL00"; // widest face (look-around), 1 col wider than idle
  setValues(SAMPLE);
  let consistent = true, degrades = false, prevName = null;
  for (let target = 220; target >= 40; target -= 1) {
    const selected = resolvePreset(presets.full, target, loadByName, wide);
    // Unless minimal is the forced last resort, the pick must actually fit the sprite.
    if (selected !== presets.minimal && !planLayout(selected, target, wide).fits) consistent = false;
    const name = selected === presets.full ? "full" : selected === presets.standard ? "standard" : "minimal";
    if (prevName && name !== prevName) degrades = true; // saw at least one preset switch
    prevName = name;
  }
  ok(consistent, "real path: a non-last-resort pick fits the same sprite it renders with");
  ok(degrades, "real path: the preset degrades as the target shrinks");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
