#!/usr/bin/env node
// The image-to-glyph cache: images are known by path, size and modification time, so same-named
// images in two folders never share an entry and a rewritten image is drawn anew; converted images
// are kept on disk for the next process.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Before the import: the sandbox is the runtime directory the cache is written to.
const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-raster-"));
Object.assign(process.env, { ...sandboxEnv(SB) });
const OLD = path.join(SB, "gamebar_faces_000000000000.json");
const RECENT = path.join(SB, "gamebar_faces_111111111111.json");
for (const f of [OLD, RECENT]) writeFileSync(f, "{}");
const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
utimesSync(OLD, twoDaysAgo, twoDaysAgo);

const raster = await import("../../src/kit/raster/asset-raster.js");

const SPRITES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "games", "doom", "assets", "mugshot", "alpha");
const A = path.join(SB, "game-a", "STFST01.png");
const B = path.join(SB, "game-b", "STFST01.png");
mkdirSync(path.dirname(A));
mkdirSync(path.dirname(B));
copyFileSync(path.join(SPRITES, "STFST01.png"), A);
copyFileSync(path.join(SPRITES, "STFDEAD0.png"), B);
const OCTANT = { step: "octant", background: [0, 0, 0] };

try {
  console.log("cache keys:");
  {
    const a = raster.rasterize(A, 8, OCTANT);
    const b = raster.rasterize(B, 8, OCTANT);
    ok(a.length === 8 && a.every((r) => r.length > 0), "an image is drawn as the asked rows of cells");
    ok(raster.rasterize(A, 8, OCTANT) === a, "an image drawn once is served from the cache");
    ok(!same(a, b), "two images with the same name in two folders are cached separately");

    // Rewrite B with A's picture and a later time, so the change never rests on the clock's resolution.
    copyFileSync(path.join(SPRITES, "STFST01.png"), B);
    const later = new Date(Date.now() + 60_000);
    utimesSync(B, later, later);
    const b2 = raster.rasterize(B, 8, OCTANT);
    ok(same(b2, a) && !same(b2, b), "a rewritten image is drawn from its new content");
    ok(raster.rasterize(A, 8, OCTANT) === a, "rewriting one image leaves the other's cache entry as it was");

    ok(raster.rasterize(path.join(SB, "game-a", "NOSUCH.png"), 4, OCTANT) === null, "a missing image draws nothing");
    const notPng = path.join(SB, "game-a", "broken.png");
    writeFileSync(notPng, "not a png");
    ok(raster.rasterize(notPng, 4, OCTANT) === null, "a file that is not an image draws nothing");
    const half = raster.rasterize(A, 8, { step: "half", background: [0, 0, 0] });
    ok(half !== a && half.flat().every((cell) => " █▀▄▌▐".includes(cell[0])), "another glyph step is another cache entry");
  }

  console.log("disk cache:");
  {
    const own = readdirSync(SB).filter((n) => /^gamebar_faces_[0-9a-f]{12}\.json$/.test(n) && ![OLD, RECENT].includes(path.join(SB, n)));
    ok(own.length === 1, `converted images are written to one cache file (found ${own.join(", ") || "none"})`);
    ok(!existsSync(OLD), "a cache untouched for a day is removed");
    ok(existsSync(RECENT), "a recent cache, maybe another installation's, is kept");
    const cache = path.join(SB, own[0]);
    const stored = JSON.parse(readFileSync(cache, "utf8"));
    const keysOf = (file) => Object.keys(stored).filter((k) => k.startsWith(`${file}|`));
    ok(keysOf(B).length === 1, `only the rewritten image's current version is kept on disk (${keysOf(B).length} entries)`);
    ok(keysOf(A).length === 2, "the other image keeps its entries");

    // A new process (here a fresh copy of the module) reads the images another one converted.
    const key = keysOf(A).find((k) => k.endsWith("|8@octant@0,0,0"));
    const sentinel = [[["X", [1, 2, 3], null]], [], [], [], [], [], [], []];
    writeFileSync(cache, JSON.stringify({ ...stored, [key]: sentinel }));
    const fresh = await import("../../src/kit/raster/asset-raster.js?second-process");
    ok(same(fresh.rasterize(A, 8, OCTANT), sentinel), "an image in the disk cache is read, not converted again");
    writeFileSync(cache, "{not json");
    const third = await import("../../src/kit/raster/asset-raster.js?broken-cache");
    const redrawn = third.rasterize(A, 8, OCTANT);
    ok(redrawn.length === 8 && redrawn[0][0][0] !== "X", "an unreadable cache file is ignored and the image converted");
  }

  console.log("drawing a row:");
  {
    const cells = [["▀", [255, 0, 0], null], ["█", [0, 255, 0], [0, 0, 255]]];
    const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
    ok(plain(raster.rasterLine(cells, 6, [0, 0, 0])) === "  ▀█  ", "a row is centred in its columns");
    ok(plain(raster.rasterLine(cells, 1, "term-bg")) === "▀", "a row wider than its columns is cut");
  }

  console.log("no process:");
  {
    const src = readFileSync(new URL("../../src/kit/raster/asset-raster.js", import.meta.url), "utf8");
    ok(!/child_process/.test(src), "the cache does not import child_process");
  }
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
