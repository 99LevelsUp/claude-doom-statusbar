#!/usr/bin/env node
// Faces without blocking: a long-lived process must never wait on chafa.

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as face from "../src/face.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };

const SPRITE = "STFST01";
const ORIG_PATH = process.env.PATH;

const hasChafa = (() => {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["chafa"], { stdio: "ignore" });
  return !r.error && r.status === 0;
})();

// Reference faces from fresh module instances on the synchronous path.
async function refFace(tag, rows, pathValue) {
  const mod = await import(new URL(`../src/face.js?ref-${tag}`, import.meta.url));
  process.env.PATH = pathValue;
  try { return mod.loadFace(SPRITE, rows); } finally { process.env.PATH = ORIG_PATH; }
}

console.log("no-spawn mode, chafa absent:");
{
  const rows = 6;
  const ansFace = await refFace("ans6", rows, "");
  face.setFaceNoSpawn(true);
  process.env.PATH = ""; // the warm-up spawn reads PATH when it starts
  const before = face.faceWarmupsStarted();
  const got = face.loadFace(SPRITE, rows);
  ok(same(got, ansFace), "a cache miss returns the .ans face");
  ok(face.faceWarmupsStarted() === before + 1, "the miss starts one warm-up");
  let threw = false, warmed;
  try { warmed = await face.warmFace(SPRITE, rows); } catch { threw = true; }
  process.env.PATH = ORIG_PATH;
  ok(!threw && warmed === false, "the warm-up fails quietly (resolves false)");
  const after = face.faceWarmupsStarted();
  ok(same(face.loadFace(SPRITE, rows), ansFace), "the .ans face stays after the failed warm-up");
  ok(face.faceWarmupsStarted() === after, "a later request does not retry the warm-up");
}

console.log("no-spawn mode, chafa present:");
if (!hasChafa) {
  console.log("  skip chafa is not on PATH; the warm-up-to-chafa assertions need it");
} else {
  const rows = 3; // the .ans set holds chafa renders for 4..16; below 4 the two differ
  const ansFace = await refFace("ans3", rows, "");
  const chafaFace = await refFace("chafa3", rows, ORIG_PATH);
  ok(!same(ansFace, chafaFace), "precondition: the chafa and .ans faces differ at this height");
  face.setFaceNoSpawn(true);
  const before = face.faceWarmupsStarted();
  const first = face.loadFace(SPRITE, rows);
  ok(same(first, ansFace), "a cache miss returns the .ans face even though chafa is available");
  const second = face.loadFace(SPRITE, rows);
  ok(same(second, ansFace), "a second request before the warm-up lands still gets the .ans face");
  const p1 = face.warmFace(SPRITE, rows);
  const p2 = face.warmFace(SPRITE, rows);
  ok(p1 === p2, "concurrent warm-ups for one key share one promise");
  ok(face.faceWarmupsStarted() === before + 1, "concurrent misses start only one warm-up");
  ok((await p1) === true, "the warm-up completes");
  ok(same(face.loadFace(SPRITE, rows), chafaFace), "after the warm-up the same request returns the chafa face");
}

console.log("default synchronous path:");
if (!hasChafa) {
  console.log("  skip chafa is not on PATH; the synchronous chafa assertion needs it");
} else {
  const rows = 2;
  const ansFace = await refFace("ans2", rows, "");
  const chafaFace = await refFace("chafa2", rows, ORIG_PATH);
  ok(!same(ansFace, chafaFace), "precondition: the chafa and .ans faces differ at this height");
  face.setFaceNoSpawn(false);
  const before = face.faceWarmupsStarted();
  ok(same(face.loadFace(SPRITE, rows), chafaFace), "with no-spawn off a miss returns the chafa face synchronously");
  ok(face.faceWarmupsStarted() === before, "the synchronous path starts no warm-up");
}

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
