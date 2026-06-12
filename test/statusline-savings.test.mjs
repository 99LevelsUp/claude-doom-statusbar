#!/usr/bin/env node
import { statsValues } from "../src/statusline.js";
import { setValues, buildBar, vlen, SAMPLE } from "../src/render.js";
import { parse as parseToml } from "smol-toml";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-savings-"));

// Write a fixture file and point the matching env override at it.
// `content` may be a string (written verbatim, for malformed-JSON tests) or an object.
const fixture = (name, content) => {
  const p = path.join(tmp, name);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
};
const MISSING = path.join(tmp, "does-not-exist.json");

try {
  // --- lean-ctx happy path: saved + compression_rate as a direct percent ---
  process.env.DOOMBAR_LEANCTX = fixture("lean.json", { tokens_saved: 8263, compression_rate: 63 });
  process.env.DOOMBAR_LLMLINGUA = MISSING;
  let v = statsValues();
  ok(v["save.leanctx"] === "8.3k 63%", `lean-ctx -> "8.3k 63%" (got ${JSON.stringify(v["save.leanctx"])})`);
  ok(!("save.lingua" in v), "missing llmlingua file -> save.lingua omitted");

  // --- llmlingua nested session schema (smart-read): ratio when no pct ---
  process.env.DOOMBAR_LEANCTX = MISSING;
  process.env.DOOMBAR_LLMLINGUA = fixture("ling-nested.json", {
    session: { runs: 3, tokens_saved: 1234, last_ratio: 1.3 },
    lifetime: { runs: 99, tokens_saved_total: 99999 },
  });
  v = statsValues();
  ok(v["save.lingua"] === "1.2k 1.3x", `llmlingua session -> "1.2k 1.3x" (got ${JSON.stringify(v["save.lingua"])})`);
  ok(!("save.leanctx" in v), "missing lean-ctx file -> save.leanctx omitted");

  // --- llmlingua nested session with explicit last_saved_pct -> percent wins ---
  process.env.DOOMBAR_LLMLINGUA = fixture("ling-pct.json", {
    session: { runs: 2, tokens_saved: 2048, last_saved_pct: 75, last_ratio: 4.0 },
  });
  v = statsValues();
  ok(v["save.lingua"] === "2.0k 75%", `llmlingua last_saved_pct -> "2.0k 75%" (got ${JSON.stringify(v["save.lingua"])})`);

  // --- llmlingua flat lifetime-only shape (llmlingua_logged.py) -> absent for session view (R6) ---
  process.env.DOOMBAR_LLMLINGUA = fixture("ling-flat.json", { runs: 5, tokens_saved_total: 4242, last_ratio: 2.1 });
  v = statsValues();
  ok(!("save.lingua" in v), "flat lifetime-only llmlingua -> save.lingua omitted (no session block)");

  // --- malformed JSON -> omitted, never throws (R3) ---
  process.env.DOOMBAR_LEANCTX = fixture("lean-bad.json", "{ this is not json ");
  process.env.DOOMBAR_LLMLINGUA = MISSING;
  v = statsValues(); // must not throw
  ok(!("save.leanctx" in v), "malformed JSON -> save.leanctx omitted, no throw");

  // --- zero savings -> omitted, never a misleading "0" row (R4) ---
  process.env.DOOMBAR_LEANCTX = fixture("lean-zero.json", { tokens_saved: 0, compression_rate: 0 });
  v = statsValues();
  ok(!("save.leanctx" in v), "tokens_saved 0 -> save.leanctx omitted");

  // --- key present but tokens_saved missing -> omitted (R3) ---
  process.env.DOOMBAR_LEANCTX = fixture("lean-nokey.json", { compression_rate: 50 });
  v = statsValues();
  ok(!("save.leanctx" in v), "no tokens_saved key -> save.leanctx omitted");

  // --- compression_rate missing -> saved only, no percent ---
  process.env.DOOMBAR_LEANCTX = fixture("lean-nopct.json", { tokens_saved: 8263 });
  v = statsValues();
  ok(v["save.leanctx"] === "8.3k", `lean-ctx no pct -> "8.3k" (got ${JSON.stringify(v["save.leanctx"])})`);

  // --- k() formatter via statsValues output: small / abbreviated / millions ---
  process.env.DOOMBAR_LEANCTX = fixture("lean-512.json", { tokens_saved: 512, compression_rate: 9 });
  ok(statsValues()["save.leanctx"] === "512 9%", "k(): 512 -> '512'");
  process.env.DOOMBAR_LEANCTX = fixture("lean-mil.json", { tokens_saved: 1200000, compression_rate: 88 });
  ok(statsValues()["save.leanctx"] === "1.2M 88%", "k(): 1200000 -> '1.2M'");

  // --- both files absent -> empty object (R8: neither tool installed) ---
  process.env.DOOMBAR_LEANCTX = MISSING;
  process.env.DOOMBAR_LLMLINGUA = MISSING;
  ok(Object.keys(statsValues()).length === 0, "neither file -> {} (no keys emitted)");

  // --- icon widths: both must measure vlen 2 so the two rows align (R10) ---
  ok(vlen("🪶") === 2, "lean icon 🪶 vlen 2");
  ok(vlen("📜") === 2, "lingua icon 📜 vlen 2");

  // --- box collapse is discriminating: other metrics present, save.* absent ---
  const cfg = parseToml(readFileSync(path.join(HERE, "..", "presets", "default.toml"), "utf8"));
  const noSave = { ...SAMPLE };
  delete noSave["save.leanctx"];
  delete noSave["save.lingua"];
  setValues(noSave);
  let out = buildBar(cfg, 120).lines.join("\n");
  ok(!out.includes("SAVE"), "savings absent -> SAVE box collapses");
  ok(out.includes("USAGE") && out.includes("GIT"), "other boxes still render (collapse is targeted, not total)");

  // --- ...and the box appears when savings are present ---
  setValues({ ...SAMPLE }); // SAMPLE carries save.leanctx / save.lingua
  out = buildBar(cfg, 120).lines.join("\n");
  ok(out.includes("SAVE"), "savings present -> SAVE box renders");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
