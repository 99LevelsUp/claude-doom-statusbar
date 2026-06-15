#!/usr/bin/env node
import { statsValues } from "../src/statusline.js";
import { setValues, buildBar, vlen, SAMPLE } from "../src/render.js";
import { parse as parseToml } from "smol-toml";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), "doombar-savings-"));
const MISSING = path.join(tmp, "does-not-exist");

// Each scenario gets an isolated events log + accumulator state file.
let seq = 0;
const scenario = () => {
  const ev = path.join(tmp, `events-${seq}.jsonl`);
  process.env.DOOMBAR_EVENTS = ev;
  process.env.DOOMBAR_SAVINGS_STATE = path.join(tmp, `state-${seq}.json`);
  seq++;
  return ev;
};
// A ToolCall event line (savings-bearing). Omit `p` for a path-less event (ctx_shell).
const tc = (saved, orig, p) => JSON.stringify({ id: 1, kind: { type: "ToolCall", tool: "ctx_read", tokens_saved: saved, tokens_original: orig, ...(p ? { path: p } : {}) } }) + "\n";
const writeJson = (name, obj) => { const p = path.join(tmp, name); writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj)); return p; };

const CWD = "D:/Smeti/Dev/Claude/proj";
const SID = { session_id: "test" };

try {
  // No llmlingua during lean tests.
  process.env.DOOMBAR_LLMLINGUA = MISSING;

  // --- init at EOF: events that predate the session are not counted ---
  let ev = scenario();
  writeFileSync(ev, tc(999, 1000, `${CWD}/old.js`));
  ok(!("save.leanctx" in statsValues(SID, CWD)), "first sight starts accumulator at EOF (pre-session events ignored)");

  // --- delta on append: events under cwd are summed; rate from accumulated totals ---
  appendFileSync(ev, tc(800, 1000, `${CWD}/a.js`));
  ok(statsValues(SID, CWD)["save.leanctx"] === "800 80%", `counts new event under cwd (800/1000) (got ${JSON.stringify(statsValues(SID, CWD)["save.leanctx"])})`);

  // --- events outside cwd, and path-less events, are not counted ---
  ev = scenario();
  writeFileSync(ev, "");
  statsValues(SID, CWD); // init at EOF (empty)
  appendFileSync(ev, tc(800, 1000, `${CWD}/a.js`));
  appendFileSync(ev, tc(5000, 6000, "D:/Karat/other/b.cs")); // outside cwd
  appendFileSync(ev, tc(300, 400)); // path-less (ctx_shell)
  ok(statsValues(SID, CWD)["save.leanctx"] === "800 80%", "outside-cwd and path-less events excluded");

  // --- boundary-safe prefix: a sibling dir sharing a prefix is not counted ---
  ev = scenario();
  writeFileSync(ev, "");
  statsValues(SID, CWD);
  appendFileSync(ev, tc(700, 1000, `${CWD}-sibling/x.js`)); // D:/.../proj-sibling, must NOT match proj
  ok(!("save.leanctx" in statsValues(SID, CWD)), "sibling dir sharing a path prefix is not counted");

  // --- cwd change: accumulator keeps prior total and adds the new location's events ---
  ev = scenario();
  writeFileSync(ev, "");
  statsValues(SID, CWD);
  appendFileSync(ev, tc(800, 1000, `${CWD}/a.js`));
  ok(statsValues(SID, CWD)["save.leanctx"] === "800 80%", "before cwd change: 800 80%");
  const CWD2 = "D:/Karat/other";
  appendFileSync(ev, tc(1200, 2000, `${CWD2}/c.cs`));
  ok(statsValues(SID, CWD2)["save.leanctx"] === "2.0k 67%", `after cwd change accumulates: (800+1200)/(1000+2000)=67% (got ${JSON.stringify(statsValues(SID, CWD2)["save.leanctx"])})`);

  // --- partial trailing line is held until its newline arrives ---
  ev = scenario();
  writeFileSync(ev, "");
  statsValues(SID, CWD);
  appendFileSync(ev, tc(1000, 2000, `${CWD}/a.js`));
  ok(statsValues(SID, CWD)["save.leanctx"] === "1.0k 50%", "full line counted");
  appendFileSync(ev, JSON.stringify({ id: 2, kind: { type: "ToolCall", path: `${CWD}/b.js`, tokens_saved: 500, tokens_original: 500 } })); // no newline
  ok(statsValues(SID, CWD)["save.leanctx"] === "1.0k 50%", "partial line (no newline) not yet consumed");
  appendFileSync(ev, "\n");
  ok(statsValues(SID, CWD)["save.leanctx"] === "1.5k 60%", `partial line consumed after newline: (1000+500)/(2000+500)=60% (got ${JSON.stringify(statsValues(SID, CWD)["save.leanctx"])})`);

  // --- log truncation/rotation (offset > size) resets without crashing ---
  ev = scenario();
  writeFileSync(ev, tc(800, 1000, `${CWD}/a.js`) + tc(800, 1000, `${CWD}/b.js`));
  const statePath = process.env.DOOMBAR_SAVINGS_STATE;
  writeFileSync(statePath, JSON.stringify({ offset: 999999, saved: 1234, original: 2000 })); // stale huge offset
  const after = statsValues(SID, CWD); // must not throw; offset clamps to 0/size
  ok(typeof (after["save.leanctx"]) === "string" || after["save.leanctx"] === undefined, "truncation/rotation handled without crash");

  // --- k() formatting via accumulated savings ---
  ev = scenario();
  writeFileSync(ev, "");
  statsValues(SID, CWD);
  appendFileSync(ev, tc(8263, 13163, `${CWD}/big.js`));
  ok(statsValues(SID, CWD)["save.leanctx"] === "8.3k 63%", `k() abbreviates: 8263 -> 8.3k, 63% (got ${JSON.stringify(statsValues(SID, CWD)["save.leanctx"])})`);
  ev = scenario();
  writeFileSync(ev, "");
  statsValues(SID, CWD);
  appendFileSync(ev, tc(1200000, 2000000, `${CWD}/huge.js`));
  ok(statsValues(SID, CWD)["save.leanctx"] === "1.2M 60%", "k() millions: 1200000 -> 1.2M");

  // --- missing events log -> no key, no throw ---
  process.env.DOOMBAR_EVENTS = MISSING;
  process.env.DOOMBAR_SAVINGS_STATE = path.join(tmp, "state-missing.json");
  ok(!("save.leanctx" in statsValues(SID, CWD)), "missing events log -> save.leanctx omitted, no throw");

  // --- no cwd -> lean omitted (can't attribute) ---
  ok(!("save.leanctx" in statsValues(SID, undefined)), "no cwd -> save.leanctx omitted");

  // === llmlingua (per-session: smart-read keys sessions[sid] by CLAUDE_CODE_SESSION_ID) ===
  process.env.DOOMBAR_EVENTS = MISSING; // keep lean out of the way (SID sanitizes to "test")

  process.env.DOOMBAR_LLMLINGUA = writeJson("ling-nested.json", { sessions: { test: { runs: 3, tokens_saved: 1234, last_ratio: 1.3 } } });
  ok(statsValues(SID, CWD)["save.lingua"] === "1.2k 1.3x", `llmlingua sessions[sid] ratio -> "1.2k 1.3x" (got ${JSON.stringify(statsValues(SID, CWD)["save.lingua"])})`);

  process.env.DOOMBAR_LLMLINGUA = writeJson("ling-pct.json", { sessions: { test: { tokens_saved: 2048, last_saved_pct: 75 } } });
  ok(statsValues(SID, CWD)["save.lingua"] === "2.0k 75%", "llmlingua last_saved_pct wins");

  process.env.DOOMBAR_LLMLINGUA = writeJson("ling-frac.json", { sessions: { test: { tokens_saved: 1234, last_ratio: 1.3333 } } });
  ok(statsValues(SID, CWD)["save.lingua"] === "1.2k 1.3x", "many-decimal ratio normalized to 1 decimal");

  // another session's block must NOT leak into this session's row
  process.env.DOOMBAR_LLMLINGUA = writeJson("ling-other.json", { sessions: { "someone-else": { tokens_saved: 9999, last_ratio: 5.0 } } });
  ok(!("save.lingua" in statsValues(SID, CWD)), "only this session's sessions[sid] is shown, not another session's");

  process.env.DOOMBAR_LLMLINGUA = writeJson("ling-flat.json", { runs: 5, tokens_saved_total: 4242, last_ratio: 2.1 });
  ok(!("save.lingua" in statsValues(SID, CWD)), "flat lifetime-only llmlingua omitted (no sessions map)");

  process.env.DOOMBAR_LLMLINGUA = writeJson("ling-bad.json", "{ not json ");
  ok(!("save.lingua" in statsValues(SID, CWD)), "malformed llmlingua JSON omitted, no throw");

  // lingua lookup uses the RAW session id (smart-read's key), not the filesystem-sanitized one
  const dotted = { session_id: "abc.def:99" }; // chars sanitize would mangle
  process.env.DOOMBAR_LLMLINGUA = writeJson("ling-raw.json", { sessions: { "abc.def:99": { tokens_saved: 1500, last_ratio: 2.0 } } });
  ok(statsValues(dotted, CWD)["save.lingua"] === "1.5k 2.0x", `raw session id used for lingua key (got ${JSON.stringify(statsValues(dotted, CWD)["save.lingua"])})`);

  // === presentation (render.js) ===
  ok(vlen("🪶") === 2, "lean icon 🪶 vlen 2");
  ok(vlen("📜") === 2, "lingua icon 📜 vlen 2");

  // full is the preset that carries the SAVE box (standard/minimal drop it).
  const cfg = parseToml(readFileSync(path.join(HERE, "..", "presets", "full.toml"), "utf8"));
  const noSave = { ...SAMPLE };
  delete noSave["save.leanctx"];
  delete noSave["save.lingua"];
  setValues(noSave);
  let out = buildBar(cfg, 200).lines.join("\n");
  ok(!out.includes("SAVE"), "savings absent -> SAVE box collapses");
  ok(out.includes("USAGE") && out.includes("PROJECT"), "other boxes still render (collapse is targeted, not total)");

  setValues({ ...SAMPLE });
  out = buildBar(cfg, 200).lines.join("\n");
  ok(out.includes("SAVE"), "savings present -> SAVE box renders");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
