#!/usr/bin/env node
// Faces: the built-in converter draws them at the session's glyph step, without starting a process,
// and keeps them in a disk cache that sweeps the caches older converters left behind.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandboxEnv } from "./_sandbox-env.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const glyphs = (f) => new Set(f.flat().map((cell) => cell[0]));

// Before the import: the sandbox is the runtime directory face.js caches its faces in.
const SB = mkdtempSync(path.join(os.tmpdir(), "doombar-face-"));
Object.assign(process.env, { ...sandboxEnv(SB) });
const OLD = path.join(SB, "doombar_faces_000000000000.json");
const RECENT = path.join(SB, "doombar_faces_111111111111.json");
const OTHER = path.join(SB, "doombar_other.json");
for (const f of [OLD, RECENT, OTHER]) writeFileSync(f, "{}");
const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
for (const f of [OLD, OTHER]) utimesSync(f, twoDaysAgo, twoDaysAgo);
const face = await import("../src/games/doom/face.js");

const SPRITE = "STFST01";

try {
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
    const missing = face.loadFace("NOSUCHSPRITE", 5);
    ok(missing.length === 5 && missing.every((r) => r.length === 0), "a missing sprite draws an empty face of the asked height");
  }

  console.log("disk cache:");
  {
    const own = readdirSync(SB).filter((n) => /^doombar_faces_/.test(n) && ![OLD, RECENT].includes(path.join(SB, n)));
    ok(own.length === 1, `the converted faces are written to one cache file (found ${own.join(", ") || "none"})`);
    ok(!existsSync(OLD), "a face cache untouched for a day is removed");
    ok(existsSync(RECENT), "a recent face cache, maybe another installation's, is kept");
    ok(existsSync(OTHER), "files that are not face caches are left alone");

    // A new process (here a fresh copy of the module) reads the faces another one converted.
    const cache = path.join(SB, own[0]);
    const sentinel = [[["X", [1, 2, 3], null]], [], [], [], [], [], [], []];
    const stored = JSON.parse(readFileSync(cache, "utf8"));
    const key = Object.keys(stored).find((k) => k.startsWith(`${SPRITE}@8@octant@`));
    ok(Boolean(key), `the cache holds the octant face under its sprite, rows and step (keys: ${Object.keys(stored).join(", ")})`);
    writeFileSync(cache, JSON.stringify({ ...stored, [key]: sentinel }));
    const fresh = await import("../src/games/doom/face.js?second-process");
    fresh.setFaceOptions({ step: "octant" });
    ok(JSON.stringify(fresh.loadFace(SPRITE, 8)) === JSON.stringify(sentinel), "a face in the disk cache is read, not converted again");

    // A cache file that is not an object of faces is ignored and the face is converted.
    writeFileSync(cache, "[]");
    const third = await import("../src/games/doom/face.js?corrupt-cache");
    third.setFaceOptions({ step: "octant" });
    const redrawn = third.loadFace(SPRITE, 8);
    ok(redrawn.length === 8 && redrawn.every((r) => r.length > 0) && redrawn[0][0][0] !== "X", "a cache file of the wrong shape is ignored and the face converted");
    writeFileSync(cache, "{not json");
    const fourth = await import("../src/games/doom/face.js?broken-cache");
    fourth.setFaceOptions({ step: "octant" });
    ok(fourth.loadFace(SPRITE, 8).every((r) => r.length > 0), "an unreadable cache file is ignored and the face converted");
  }

  console.log("no process:");
  {
    const src = readFileSync(new URL("../src/games/doom/face.js", import.meta.url), "utf8");
    ok(!/child_process/.test(src), "the face loader does not import child_process");
  }
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
