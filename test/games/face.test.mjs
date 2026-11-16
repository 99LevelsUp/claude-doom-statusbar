#!/usr/bin/env node
// Faces: the DOOM mugshot images, in DOOM's asset package, drawn by the built-in converter
// (src/kit/raster/asset-raster.js) at the session's glyph step without starting a process, and
// every frame the mugshot script can name present among them.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEMP_SANDBOX } from "../_temp-sandbox.mjs"; // before the modules that name temp paths
import { rasterize } from "../../src/kit/raster/asset-raster.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const glyphs = (f) => new Set(f.flat().map((cell) => cell[0]));

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FACES = path.join(ROOT, "games", "doom", "assets", "images", "mugshot");
const IDLE = path.join(FACES, "STFST01.png");

console.log("built-in faces:");
{
  const f = rasterize(IDLE, 8, { step: "octant" });
  ok(f.length === 8 && f.every((r) => r.length > 0), "an 8-row face has 8 drawn rows");
  ok(rasterize(IDLE, 8, { step: "octant" }) === f, "a face drawn once is served from the cache");
  ok(rasterize(IDLE, 8) === f, "with no options the face is drawn at the octant step on black");
  const half = rasterize(IDLE, 8, { step: "half" });
  ok(half !== f, "a face drawn at another step is not served from the octant face's cache entry");
  ok([...glyphs(half)].every((ch) => " █▀▄▌▐".includes(ch)), "at the half step the face uses half blocks only");
  ok(Math.max(...half.map((r) => r.length)) === Math.max(...f.map((r) => r.length)), "the face is as wide at every step");
  const grey = rasterize(IDLE, 8, { background: [128, 128, 128] });
  ok(grey !== f, "a face fitted against another background is not served from the black one's cache entry");
  ok(rasterize(path.join(FACES, "NOSUCHSPRITE.png"), 5) === null, "a missing image draws nothing (its element falls back to its default)");
  const cached = readdirSync(TEMP_SANDBOX).filter((n) => /^gamebar_faces_[0-9a-f]{12}\.json$/.test(n));
  ok(cached.length === 1, `converted faces are kept on disk for the next process (${cached.join(", ") || "none"})`);
}

console.log("the frames:");
{
  const names = new Set(readdirSync(FACES).filter((n) => n.endsWith(".png")).map((n) => n.slice(0, -4)));
  const want = ["STFDEAD0", "STFGOD0"];
  for (let hp = 0; hp <= 4; hp++) {
    want.push(`STFOUCH${hp}`, `STFKILL${hp}`, `STFEVL${hp}`, `STFTL${hp}0`, `STFTR${hp}0`, `STFST${hp}0`, `STFST${hp}1`, `STFST${hp}2`);
  }
  const missing = want.filter((n) => !names.has(n));
  ok(missing.length === 0, `a frame for every reaction at every health row (${want.length} frames${missing.length ? `; missing ${missing.join(", ")}` : ""})`);
  ok(want.every((n) => rasterize(path.join(FACES, `${n}.png`), 4) !== null), "every frame decodes and draws");
}

console.log("no process:");
{
  const src = readFileSync(new URL("../../src/kit/raster/asset-raster.js", import.meta.url), "utf8");
  ok(!/child_process/.test(src), "the image converter does not import child_process");
}

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
