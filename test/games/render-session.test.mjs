#!/usr/bin/env node
// renderSession renders one session from its payload, its own environment and a given moment.
// The one-shot command (main) and a long-lived renderer serving many sessions both go through
// it, so this pins: main prints exactly what renderSession returns, the passed environment wins
// over process.env, sessions rendered back to back never see each other's values, and the
// session's MUGSHOT_STATE decides where its checkpoint lives.
//
// Everything that changes on its own between two renders is pinned: the clock (passed as `now`,
// or faked in the child process), RAM, CPU and disk usage, and the temp dir (a sandbox, so the
// test never touches the files of the live bar on this machine).

import { execFileSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";

const ROOT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..");
const STATUSLINE = path.join(ROOT, "src", "statusline.js");
const PRESETS = path.join(ROOT, "presets");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");

// Machine metrics, pinned the same way here and (through PIN below) in child processes.
const PIN_METRICS = `
os.freemem = () => 4 * 2 ** 30;
os.totalmem = () => 16 * 2 ** 30;
os.cpus = () => [0, 1, 2, 3].map((i) => ({ model: "x", speed: 1, times: { user: 100 * (i + 1), nice: 0, sys: 50, idle: 1000, irq: 0 } }));
fs.statfsSync = () => ({ blocks: 1000, bfree: 400, bavail: 400, bsize: 4096, type: 0, files: 0, ffree: 0 });
`;
new Function("os", "fs", PIN_METRICS)(os, fs);
syncBuiltinESMExports();

const SB = mkdtempSync(path.join(os.tmpdir(), "doombar-session-"));
const TMPDIR = path.join(SB, "tmp");
mkdirSync(TMPDIR, { recursive: true });
// Before the import: the sandbox is the runtime directory for the renders. The terminal that runs the
// tests must not pick the mugshot's glyphs, so its identifying variables go.
Object.assign(process.env, { ...sandboxEnv(TMPDIR), PATH: "", DOOMBAR_MSYS_REAP: "0",
  DOOMBAR_THEME: "doom", DOOMBAR_RATELIMITS_SHARE: "0", DOOMBAR_PRESET: path.join(PRESETS, "minimal.toml") });
for (const k of ["WT_SESSION", "TERM_PROGRAM", "TERM", "TMUX", "VTE_VERSION", "DOOMBAR_GLYPHS"]) delete process.env[k];
const { renderSession } = await import("../../src/render.js");

const NOW_MS = 1793500000123;
const NOW = NOW_MS / 1000;

// Child-process preload: the same metrics, plus a fixed clock for main()'s Date.now().
const PIN = path.join(SB, "pin.mjs");
writeFileSync(PIN, `import fs from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(${NOW_MS}); else super(...a); }
  static now() { return ${NOW_MS}; }
};
${PIN_METRICS}
syncBuiltinESMExports();
`);

// A fresh session directory with its own task list, savings stats and checkpoint location.
function session(name, label, usd = 1) {
  const dir = path.join(SB, name);
  rmSync(dir, { recursive: true, force: true });
  for (const d of ["tasks", "proj", "state"]) mkdirSync(path.join(dir, d), { recursive: true });
  writeFileSync(path.join(dir, "tasks", "1.json"), JSON.stringify({ id: "1", subject: `${label} task`, status: "in_progress" }));
  writeFileSync(path.join(dir, "ling.json"), JSON.stringify({ sessions: { [`sid-${name}`]: { tokens_saved: 4321, last_saved_pct: 37 } } }));
  const env = {
    COLUMNS: "200", DOOMBAR_THEME: "doom", DOOMBAR_THEME_FILE: path.join(dir, "no-theme.json"),
    DOOMBAR_PRESET: path.join(PRESETS, "standard.toml"), DOOMBAR_RATELIMITS_SHARE: "0",
    MUGSHOT_STATE: path.join(dir, "state", "checkpoint.json"), DOOMBAR_TASKS_DIR: path.join(dir, "tasks"),
    DOOMBAR_EVENTS: path.join(dir, "events.jsonl"), DOOMBAR_LLMLINGUA: path.join(dir, "ling.json"),
    DOOMBAR_RATELIMITS: path.join(dir, "rl.json"),
  };
  const data = {
    session_id: `sid-${name}`, session_name: `${label}-run`, cwd: path.join(dir, "proj"),
    model: { display_name: "Opus 5.5" }, context_window: { used_percentage: 42, context_window_size: 1000000 },
    cost: { total_cost_usd: usd, total_duration_ms: 3725000 },
  };
  return { dir, env, data };
}
const render = (s, over = {}) => renderSession({ data: s.data, env: { ...s.env, ...over }, now: NOW }).join("\n") + "\n";

try {
  // The first render after start-up has no earlier CPU sample to diff against; take it here, so
  // every render below sees the same (pinned) CPU values.
  render(session("warmup", "warmup"));

  // main() prints what renderSession returns, byte for byte. Each path renders twice in a fresh
  // copy of the same session directory, the second time over the state the first one wrote.
  for (const [name, over] of [["doom", {}], ["hotbar", { DOOMBAR_THEME: "minecraft", COLUMNS: "160", DOOMBAR_INDENT: "4" }]]) {
    let s = session(`same-${name}`, "same");
    const childEnv = { ...s.env, ...over, SystemRoot: process.env.SystemRoot, PATH: "",
      ...sandboxEnv(TMPDIR), DOOMBAR_MSYS_REAP: "0" };
    rmSync(path.join(TMPDIR, "mugshot_cpu.json"), { force: true });
    const viaMain = [1, 2].map(() => execFileSync(process.execPath, ["--import", pathToFileURL(PIN).href, STATUSLINE],
      { input: JSON.stringify(s.data), env: childEnv }).toString("utf8"));
    s = session(`same-${name}`, "same");
    rmSync(path.join(TMPDIR, "mugshot_cpu.json"), { force: true });
    const viaRender = [1, 2].map(() => render(s, over));
    ok(viaMain[0] === viaRender[0] && viaMain[1] === viaRender[1],
      `${name}: main() prints exactly what renderSession returns (two renders in a row)`);
  }
  render(session("warmup", "warmup")); // the comparison above reset the CPU sample

  // The passed environment's preset wins over process.env's (minimal here).
  {
    const s = session("preset", "preset");
    const full = render(s, { DOOMBAR_PRESET: path.join(PRESETS, "full.toml"), COLUMNS: "250" });
    const minimal = render(s, { DOOMBAR_PRESET: path.join(PRESETS, "minimal.toml"), COLUMNS: "250" });
    ok(full !== minimal, "the full and the minimal preset draw differently (the check below can fail)");
    // Without `env`, renderSession reads process.env: set the same settings there and compare.
    const saved = { ...process.env };
    Object.assign(process.env, s.env, { DOOMBAR_PRESET: path.join(PRESETS, "full.toml"), COLUMNS: "250" });
    const viaProcess = renderSession({ data: s.data, now: NOW }).join("\n") + "\n";
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    ok(full === viaProcess, "a preset passed in env renders the same as that preset set in process.env");
    ok(render(s, { COLUMNS: "250" }) !== minimal, "process.env's minimal preset does not leak into a session that names its own");
  }

  // Sessions rendered back to back keep their own values.
  {
    const a = session("alpha", "alpha", 1.11), b = session("bravo", "bravo", 2.22);
    const a1 = render(a), b1 = render(b), a2 = render(a);
    const has = (out, w) => strip(out).includes(w);
    ok(has(a1, "alpha-run") && !has(a1, "bravo-run"), "the first session shows its own name");
    ok(has(b1, "bravo-run") && !has(b1, "alpha-run"), "the second session shows its own name, not the first one's");
    ok(has(a1, "$1.11") && !has(a1, "$2.22") && has(b1, "$2.22") && !has(b1, "$1.11"), "each session shows its own cost");
    ok(has(b1, "bravo task") && !has(b1, "alpha task"), "each session reads its own task list");
    ok(a1 === a2, "rendering another session in between changes nothing in the first one");
  }

  // The mugshot's glyph step comes from the session's own environment, capped by the preset's
  // [mugshot] glyphs key: one daemon draws each session with the glyphs its terminal can show.
  {
    const s = session("glyphs", "glyphs");
    const half = render(s, { DOOMBAR_GLYPHS: "half" });
    const octant = render(s, { DOOMBAR_GLYPHS: "octant" });
    ok(half !== octant, "a session asking for half blocks draws a different face than one asking for octants");
    ok(render(s, { DOOMBAR_GLYPHS: "half" }) === half, "the same session settings draw the same face again");
    const capped = path.join(s.dir, "capped.toml");
    const preset = readFileSync(path.join(PRESETS, "standard.toml"), "utf8");
    ok(/^glyphs = "octant"$/m.test(preset), "the standard preset names its mugshot glyph step (the check below can fail)");
    writeFileSync(capped, preset.replace(/^glyphs = "octant"$/m, 'glyphs = "half"'));
    ok(render(s, { DOOMBAR_PRESET: capped, DOOMBAR_GLYPHS: "octant" }) === half,
      "a preset that caps the mugshot at half blocks wins over a terminal that draws octants");
    ok(render(s, { WT_SESSION: "x" }) === octant, "a Windows Terminal session gets octants without any setting");
  }

  // MUGSHOT_STATE in the passed env decides where the checkpoint is read and written.
  {
    const s = session("state", "state");
    const journal = s.env.MUGSHOT_STATE + ".jsonl";
    const line = JSON.stringify({ ts: 1, name: "Notification", ev: { permission_mode: "plan" } }) + "\n";
    writeFileSync(journal, line);
    render(s);
    ok(existsSync(s.env.MUGSHOT_STATE), "the checkpoint is written where the session's MUGSHOT_STATE points");
    const cp = JSON.parse(readFileSync(s.env.MUGSHOT_STATE, "utf8"));
    ok(cp.mode === "plan" && cp.offset === Buffer.byteLength(line), "the journal next to it is the one folded");
    ok(!existsSync(path.join(os.tmpdir(), `mugshot_${s.data.session_id}.json`)), "no checkpoint at the default location");
  }
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
