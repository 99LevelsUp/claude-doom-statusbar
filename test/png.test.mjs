#!/usr/bin/env node
// PNG decoder: the face sprites decode in-process to RGBA.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "../src/png.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const ALPHA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "images", "mugshot", "alpha");

{
  const img = decodePng(readFileSync(path.join(ALPHA, "STFST01.png")));
  ok(img.width === 24 && img.height === 29, `STFST01 is 24x29 (got ${img.width}x${img.height})`);
  ok(img.rgba.length === 24 * 29 * 4, "RGBA holds four bytes per pixel");
  const alphaAt = (x, y) => img.rgba[(y * img.width + x) * 4 + 3];
  ok(alphaAt(0, 0) === 0, "the top-left corner around the face is transparent");
  ok(alphaAt(12, 15) === 255, "the middle of the face is opaque");
}

{
  const files = readdirSync(ALPHA).filter((f) => f.endsWith(".png"));
  let decoded = 0;
  for (const f of files) {
    try {
      const img = decodePng(readFileSync(path.join(ALPHA, f)));
      if (img.width > 0 && img.height > 0 && img.rgba.length === img.width * img.height * 4) decoded++;
    } catch { /* counted as not decoded */ }
  }
  ok(files.length === 42 && decoded === 42, `all 42 alpha sprites decode (${decoded} of ${files.length})`);
}

{
  // A 16-bit PNG: signature, an IHDR chunk with bit depth 16, IEND. The decoder must refuse it.
  const chunk = (tag, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(tag, 4, "latin1");
    data.copy(b, 8);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 16; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
  let msg = "";
  try { decodePng(png); } catch (e) { msg = e.message; }
  ok(/unsupported PNG/.test(msg), `a 16-bit PNG is refused with a clear error (${msg})`);
  let notPng = "";
  try { decodePng(Buffer.from("GIF89a....")); } catch (e) { notPng = e.message; }
  ok(notPng === "not a PNG", "a non-PNG buffer is refused");
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
