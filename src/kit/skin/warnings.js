// The warning line: one dim line under the bar while anything needs the user's attention. Skin parts
// that were skipped, asset packages that are missing and scripts that failed are collected during
// the render as warnings ({ key, message, ... }, the form src/kit/skin/load.js gives them); the
// line names the first cause and counts the others. A cause shows for 60 seconds after it first
// appeared, then stays quiet while it lasts. A cause not seen for more than those 60 seconds has
// ended: when it comes back, it is new and shows again.
//
// When a cause first and last appeared is kept in a store the caller owns:
//   memoryStore()     for the render daemon, for as long as it lives
//   fileStore(file)   for the one-shot renderer, a JSON file every render reads and rewrites
// A store answers firstSeen(keys, now) with a Map of each key to the time it first appeared in its
// current run, recording `now` as each key's last appearance.

import { readFileSync } from "node:fs";
import { RESET } from "../ansi.js";
import { vlen, marquee } from "../text.js";
import { writeAtomic } from "../../platform/runtime.js";
import { isPlainObject } from "../is.js";

export const WARNING_SECONDS = 60;
const DIM = "\x1b[2m";

export { makeWarning } from "../warning.js";

// A cause seen at `now`: { first, last }, a new run when it was unknown or gone for longer than the
// warning lasts.
const sighting = (e, now) => ({ first: e && now - e.last <= WARNING_SECONDS ? e.first : now, last: now });

export function memoryStore() {
  const seen = new Map();
  return {
    firstSeen(keys, now) {
      for (const k of keys) seen.set(k, sighting(seen.get(k), now));
      return new Map(keys.map((k) => [k, seen.get(k).first]));
    },
  };
}

// The file maps each key to { first, last }. A file written before causes could end maps a key to
// the time it was first seen; that time is read as both. A file that cannot be read or does not
// parse counts as nothing seen yet; one that cannot be written leaves every cause new on the next
// render, never the line missing. Causes not seen for longer than the warning lasts are left out
// when the file is written, so it holds only what is current.
export function fileStore(file) {
  return {
    firstSeen(keys, now) {
      const seen = Object.create(null);
      try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        if (isPlainObject(data)) {
          for (const [k, v] of Object.entries(data)) {
            if (typeof v === "number") seen[k] = { first: v, last: v };
            else if (isPlainObject(v) && typeof v.first === "number" && typeof v.last === "number") seen[k] = { first: v.first, last: v.last };
          }
        }
      } catch { /* nothing seen yet */ }
      for (const k of keys) seen[k] = sighting(seen[k], now);
      const current = Object.fromEntries(Object.entries(seen).filter(([, e]) => now - e.last <= WARNING_SECONDS));
      try { writeAtomic(file, JSON.stringify(current)); } catch { /* shown again as new next time */ }
      return new Map(keys.map((k) => [k, seen[k].first]));
    },
  };
}

// The warning line for this render's `warnings`, or null when no cause is younger than 60 seconds.
// `now` is in seconds; `width` the terminal's columns, the line clipped with an ellipsis to fit.
export function warningLine(warnings, { store, now, width = Infinity }) {
  const unique = [];
  const keys = new Set();
  for (const w of warnings) {
    if (!keys.has(w.key)) { keys.add(w.key); unique.push(w); }
  }
  if (!unique.length) return null;
  const first = store.firstSeen(unique.map((w) => w.key), now);
  const young = unique.filter((w) => now - first.get(w.key) < WARNING_SECONDS);
  if (!young.length) return null;
  const text = `gamebar: ${young[0].message}${young.length > 1 ? ` (+${young.length - 1} more)` : ""}`;
  const shown = vlen(text) <= width ? text : marquee(text, width, 0, "clip");
  return DIM + shown + RESET;
}
