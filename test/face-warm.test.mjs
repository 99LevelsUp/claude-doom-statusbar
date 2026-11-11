#!/usr/bin/env node
// Faces: the built-in converter draws them by default and starts no process; chafa runs only when
// asked for, with the session's glyph step, and never makes a long-lived process wait.

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as face from "../src/face.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const glyphs = (f) => new Set(f.flat().map((cell) => cell[0]));

const SPRITE = "STFST01";
const ORIG_PATH = process.env.PATH;
const hasChafa = (() => {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["chafa"], { stdio: "ignore" });
  return !r.error && r.status === 0;
})();

console.log("built-in by default:");
{
  face.setFaceNoSpawn(false);
  face.setFaceOptions({ step: "octant" });
  const before = face.chafaRuns();
  const f = face.loadFace(SPRITE, 8);
  ok(f.length === 8 && f.every((r) => r.length > 0), "an 8-row face has 8 drawn rows");
  ok(face.chafaRuns() === before, "drawing a face starts no chafa process, chafa on PATH or not");
  face.setFaceOptions({ step: "half" });
  const half = face.loadFace(SPRITE, 8);
  ok([...glyphs(half)].every((ch) => " █▀▄▌▐".includes(ch)), "at the half step the face uses half blocks only");
  ok(Math.max(...half.map((r) => r.length)) === Math.max(...f.map((r) => r.length)), "the face is as wide at every step");
}

console.log("chafa on request, chafa missing:");
{
  face.setFaceNoSpawn(false);
  face.setFaceOptions({ step: "sextant" });
  const builtin = face.loadFace(SPRITE, 7);
  face.setFaceOptions({ step: "sextant", renderer: "chafa" });
  process.env.PATH = "";
  try {
    const before = face.chafaRuns();
    const f = face.loadFace(SPRITE, 7);
    ok(face.chafaRuns() === before + 1, "the chafa renderer tries chafa once");
    ok(same(f, builtin), "with chafa missing the face is the built-in one");
  } finally { process.env.PATH = ORIG_PATH; }
}

console.log("chafa on request, no-spawn mode:");
if (!hasChafa) {
  console.log("  skip chafa is not on PATH; the warm-up assertions need it");
} else {
  face.setFaceNoSpawn(true);
  face.setFaceOptions({ step: "half", renderer: "chafa" });
  const rows = 6;
  const first = face.loadFace(SPRITE, rows);
  face.setFaceOptions({ step: "half" });
  ok(same(first, face.loadFace(SPRITE, rows)), "a cache miss returns the built-in face at once");
  face.setFaceOptions({ step: "half", renderer: "chafa" });
  const p1 = face.warmFace(SPRITE, rows);
  ok(p1 === face.warmFace(SPRITE, rows), "concurrent warm-ups for one key share one promise");
  ok((await p1) === true, "the warm-up completes");
  const warmed = face.loadFace(SPRITE, rows);
  ok([...glyphs(warmed)].every((ch) => " █▀▄▌▐".includes(ch)), "chafa at the half step draws half blocks only");
  ok(Math.max(...warmed.map((r) => r.length)) === Math.max(...first.map((r) => r.length)), "chafa draws the face at the same width");
}

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
