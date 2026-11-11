#!/usr/bin/env node
// Faces: the built-in converter draws them at the session's glyph step, without starting a process.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import * as face from "../src/face.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const glyphs = (f) => new Set(f.flat().map((cell) => cell[0]));

const SPRITE = "STFST01";

console.log("built-in faces:");
{
  face.setFaceOptions({ step: "octant" });
  const f = face.loadFace(SPRITE, 8);
  ok(f.length === 8 && f.every((r) => r.length > 0), "an 8-row face has 8 drawn rows");
  ok(face.loadFace(SPRITE, 8) === f, "a face drawn once is served from the cache");
  face.setFaceOptions({ step: "half" });
  const half = face.loadFace(SPRITE, 8);
  ok([...glyphs(half)].every((ch) => " █▀▄▌▐".includes(ch)), "at the half step the face uses half blocks only");
  ok(Math.max(...half.map((r) => r.length)) === Math.max(...f.map((r) => r.length)), "the face is as wide at every step");
  face.setFaceOptions({ step: "sextant", renderer: "chafa" });
  const asked = face.loadFace(SPRITE, 7);
  face.setFaceOptions({ step: "sextant" });
  ok(same(asked, face.loadFace(SPRITE, 7)), "a chafa renderer setting is ignored: the face is the built-in one");
  const missing = face.loadFace("NOSUCHSPRITE", 5);
  ok(missing.length === 5 && missing.every((r) => r.length === 0), "a missing sprite draws an empty face of the asked height");
}

console.log("no process:");
{
  const src = readFileSync(new URL("../src/face.js", import.meta.url), "utf8");
  ok(!/child_process/.test(src), "the face loader does not import child_process");
}

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
