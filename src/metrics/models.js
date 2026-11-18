// The Claude model family the bar knows: one model per tier (Fable, Opus, Sonnet, Haiku, ...), the
// newest version of each that it has seen. The chat casts its other players from it (the `family`
// fact, src/kit/chat/metrics-library.js), so a new model generation reaches the chat without anyone
// editing a list.
//
// The bar cannot ask Anthropic which models exist (the models API needs an API key). It sees the
// running model's name and the advisor's in every session, so it learns from those: a name of a
// tier it knows with a higher version replaces that tier's model, a name of a new tier joins the
// family at its end. The list below is where it starts; what it has learned is kept in the user
// directory (models.json), shared by every installation, and survives updates of the bar.
//
// A name is "<tier> <version>", the version digits and dots ("Opus 5.5", "Haiku 4.5"); a name that
// does not read that way is not learned. A tier never leaves the family.

import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { userDir, writeAtomic } from "../platform/runtime.js";

export const SEED_FAMILY = Object.freeze(["Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);

const NAME = /^([A-Za-z][A-Za-z-]*)\s+(\d+(?:\.\d+)*)$/;

// Pure: { tier, version: [numbers], name } of a model's display name, or null.
export function parseModel(name) {
  if (typeof name !== "string") return null;
  const m = NAME.exec(name.trim());
  return m ? { tier: m[1].toLowerCase(), version: m[2].split(".").map(Number), name: `${m[1]} ${m[2]}` } : null;
}

const newer = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
};

// Pure: `family` (a list of names) with `seen` names learned into it, in its order, new tiers at
// the end. Names of `family` that do not parse are dropped.
export function learnFamily(family, seen) {
  const out = [];
  const at = new Map();
  for (const n of [...family, ...seen]) {
    const p = parseModel(n);
    if (!p) continue;
    const i = at.get(p.tier);
    if (i === undefined) { at.set(p.tier, out.length); out.push(p); }
    else if (newer(p.version, out[i].version)) out[i] = p;
  }
  return out.map((p) => p.name);
}

export const familyFile = (env = process.env) => path.join(userDir(env), "models.json");

// What this process last read or wrote, by file: { stamp, family }.
const cache = new Map();
const stampOf = (file) => { try { const s = statSync(file); return `${s.size}@${s.mtimeMs}`; } catch { return null; } };

function readFamily(file) {
  const stamp = stampOf(file);
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.family;
  let family = [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(data?.family)) family = data.family.filter((n) => typeof n === "string");
  } catch { /* none learned yet, or unreadable: start from the seed */ }
  cache.set(file, { stamp, family });
  return family;
}

// The family after learning the `seen` names (the running model, the advisor), written back when it
// changed. Never throws: a file that cannot be read or written leaves the family the seed plus what
// this render saw.
export function modelFamily(seen, env = process.env) {
  const file = familyFile(env);
  const known = readFamily(file);
  const family = learnFamily([...SEED_FAMILY, ...known], seen.filter(Boolean));
  if (JSON.stringify(family) !== JSON.stringify(known)) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeAtomic(file, JSON.stringify({ family }));
      cache.set(file, { stamp: stampOf(file), family });
    } catch { /* the next render tries again */ }
  }
  return family;
}
