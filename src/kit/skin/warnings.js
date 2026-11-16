// The warning line: one dim line under the bar while anything needs the user's attention. Skin parts
// that were skipped, asset packages that are missing and scripts that failed are collected during
// the render as warnings ({ key, message, ... }, the form src/kit/skin/load.js gives them); the
// line names the first cause and counts the others. A cause shows for 60 seconds after it first
// appeared, then stays quiet while it lasts.
//
// When a cause first appeared is kept in a store the caller owns:
//   memoryStore()     for the render daemon, for as long as it lives
//   fileStore(file)   for the one-shot renderer, a JSON file every render reads and adds to
// A store answers firstSeen(keys, now) with a Map of each key to the time it was first seen,
// recording `now` for the keys it has not seen before.

import { readFileSync } from "node:fs";
import { RESET } from "../ansi.js";
import { vlen, marquee } from "../text.js";
import { writeAtomic } from "../../platform/runtime.js";

export const WARNING_SECONDS = 60;
const DIM = "\x1b[2m";

export function memoryStore() {
  const seen = new Map();
  return {
    firstSeen(keys, now) {
      for (const k of keys) if (!seen.has(k)) seen.set(k, now);
      return new Map(keys.map((k) => [k, seen.get(k)]));
    },
  };
}

// A file that cannot be read or does not parse counts as nothing seen yet; one that cannot be
// written leaves every cause new on the next render, never the line missing.
export function fileStore(file) {
  return {
    firstSeen(keys, now) {
      const seen = Object.create(null);
      try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        if (data && typeof data === "object" && !Array.isArray(data)) {
          for (const [k, t] of Object.entries(data)) if (typeof t === "number") seen[k] = t;
        }
      } catch { /* nothing seen yet */ }
      let changed = false;
      for (const k of keys) {
        if (seen[k] === undefined) { seen[k] = now; changed = true; }
      }
      if (changed) {
        try { writeAtomic(file, JSON.stringify(seen)); } catch { /* shown again as new next time */ }
      }
      return new Map(keys.map((k) => [k, seen[k]]));
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
