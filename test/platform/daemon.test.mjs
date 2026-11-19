#!/usr/bin/env node
// The render daemon: one process per installation renders every active session and keeps its
// frame and the daemon heartbeat fresh.
//
// Most cases drive one loop pass at a time (runPass) with a simulated clock, in this process.
// The cases that are about real processes (one daemon per installation, idle exit, exit on a
// source change) start `node src/daemon.js` from copies of the package, so every copy has its
// own install hash and pipe and never meets the live bar of this machine.
//
// Everything that changes on its own between two renders is pinned, as in
// render-session.test.mjs: RAM, CPU and disk usage, and the temp dir (a sandbox).

import { spawn } from "node:child_process";
import fs, {
  mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync,
  cpSync, symlinkSync, appendFileSync, unlinkSync, statSync, renameSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";

const ROOT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..");
const PRESETS = path.join(ROOT, "src", "games", "doom", "presets");
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

os.freemem = () => 4 * 2 ** 30;
os.totalmem = () => 16 * 2 ** 30;
os.cpus = () => [0, 1, 2, 3].map((i) => ({ model: "x", speed: 1, times: { user: 100 * (i + 1), nice: 0, sys: 50, idle: 1000, irq: 0 } }));
fs.statfsSync = () => ({ blocks: 1000, bfree: 400, bavail: 400, bsize: 4096, type: 0, files: 0, ffree: 0 });
syncBuiltinESMExports();

const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-daemon-"));
const TMPDIR = path.join(SB, "tmp");
for (const d of ["tmp", "tasks", "proj"]) mkdirSync(path.join(SB, d), { recursive: true });
// Before the imports, so any path the render modules take when they load comes from the sandbox.
const SANDBOX_ENV = {
  ...sandboxEnv(TMPDIR), PATH: "", GAMEBAR_MSYS_REAP: "0", GAMEBAR_THEME: "doom",
  GAMEBAR_THEME_FILE: path.join(SB, "no-theme.json"), GAMEBAR_RATELIMITS_SHARE: "0",
  GAMEBAR_RATELIMITS: path.join(SB, "rl.json"), GAMEBAR_TASKS_DIR: path.join(SB, "tasks"),
  GAMEBAR_EVENTS: path.join(SB, "events.jsonl"), GAMEBAR_LLMLINGUA: path.join(SB, "ling.json"),
  GAMEBAR_PRESET: path.join(PRESETS, "minimal.toml"), GAMEBAR_USER_DIR: path.join(SB, "user"),
};
Object.assign(process.env, SANDBOX_ENV);
// The terminal that runs the tests must not pick the mugshot's glyphs for one side of a comparison.
for (const k of ["WT_SESSION", "TERM_PROGRAM", "TERM", "TMUX", "VTE_VERSION", "GAMEBAR_GLYPHS"]) delete process.env[k];
const { renderSession } = await import("../../src/render.js");
const { sessionPaths, daemonPaths, rootHash, daemonSocket, procStartTicks } = await import("../../src/platform/runtime.js");
const { parseFrame } = await import("../../src/platform/frame.js");
const { envGet } = await import("../../src/platform/env.js");
const { createState, runPass, pipePath, maybeStartReaper, FORWARDED_ENV } = await import("../../src/daemon.js");
const { createScriptHost } = await import("../../src/platform/scripts/host.js");
const { createScriptPass } = await import("../../src/kit/skin/scripts.js");

// The skins compared below run scripts (doom-full's mugshot names one). A comparison needs every
// script to run on both sides, so the daemon and renderSession each get a host and a pass no
// loaded machine runs a trivial call past; only the cases about the scripts' time keep the
// product's budgets.
const ROOMY = { callBudgetMs: 2000, graceMs: 2000, startupMs: 10000 };
const DAEMON_HOST = createScriptHost(ROOMY);
const RENDER_HOST = createScriptHost(ROOMY);
const roomyState = (options) => createState({ version: VERSION, scriptHost: DAEMON_HOST, scriptPassMs: 60000, callBudgetMs: 10000, ...options });
const renderAt = (data, env, nowMs) => renderSession({ data, env, now: nowMs / 1000,
  scripts: { host: RENDER_HOST, pass: createScriptPass({ budgetMs: 60000, callBudgetMs: 10000 }), state: new Map() } });

const HASH = rootHash();
const OTHER = rootHash(path.join(SB, "elsewhere"));

// What the bash client writes: the environment line, then the stdin JSON as received.
const payloadText = (data, env) =>
  ["gamebar-env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`)].join("\t") + "\n" + JSON.stringify(data);
const payloadFile = (key, hash = HASH, dir = TMPDIR) => path.join(dir, path.basename(sessionPaths(key, hash).payload));
const frameFile = (key, hash = HASH, dir = TMPDIR) => path.join(dir, path.basename(sessionPaths(key, hash).frame));
const heartbeatFile = (hash = HASH, dir = TMPDIR) => path.join(dir, path.basename(daemonPaths(hash).heartbeat));

// A session as the client hands it over; `bump` forces a new mtime so a rewrite is always seen.
let bumps = 0;
function session(key, { label = key, env = {}, hash = HASH, dir = TMPDIR } = {}) {
  const fwd = { COLUMNS: "250", GAMEBAR_PRESET: path.join(PRESETS, "full.toml"),
    GAMEBAR_STATE: path.join(SB, `state-${key}.json`),
    GAMEBAR_EVENTS: SANDBOX_ENV.GAMEBAR_EVENTS, GAMEBAR_LLMLINGUA: SANDBOX_ENV.GAMEBAR_LLMLINGUA, ...env };
  const data = {
    session_id: key, session_name: `${label}-run`, cwd: path.join(SB, "proj"),
    model: { display_name: "Opus 5.5" }, context_window: { used_percentage: 42, context_window_size: 1000000 },
    cost: { total_cost_usd: 1.5, total_duration_ms: 3725000 },
  };
  const s = { key, data, fwd, hash, dir };
  s.write = (text = payloadText(s.data, s.fwd)) => {
    const f = payloadFile(key, hash, dir);
    writeFileSync(f, text);
    const t = new Date(Date.now() + 1000 * ++bumps);
    utimesSync(f, t, t);
  };
  s.write();
  return s;
}
const heartbeat = (hash, dir) => { try { return JSON.parse(readFileSync(heartbeatFile(hash, dir), "utf8")); } catch { return null; } };
const expected = (s, nowMs) => renderAt(s.data, { ...process.env, ...s.fwd }, nowMs);
const readFrame = (s) => { try { return readFileSync(frameFile(s.key, s.hash, s.dir), "utf8"); } catch { return null; } };
const frameOf = (s) => parseFrame(readFrame(s) ?? "");
// Compares two frames' lines, and notes any warning line either carries: a compared frame with a
// warning means a script failed on one side, and two equal frames would then prove little.
const warned = new Set();
const sameLines = (a, b) => {
  for (const l of [...(a || []), ...(b || [])]) if (strip(l).includes("gamebar:")) warned.add(strip(l).trim());
  return JSON.stringify(a) === JSON.stringify(b);
};
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

const children = [];
async function stopAll() {
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) { c.kill(); await c.exited; }
  }
}

try {
  // The CPU sample is throttled on the real clock (1 s), so a daemon render and the comparison
  // render right after it could straddle a new sample. Hold one cached sample for the whole run.
  writeFileSync(path.join(TMPDIR, "gamebar_cpu.json"), JSON.stringify({
    ts: Date.now() + 864e5, total: 0, idle: 0, cores: [], result: { cpu: 12, cores: [0.1, 0.2, 0.3, 0.4] } }));

  // A new session gets a frame within one pass, and the frame is what renderSession prints.
  {
    const s = session("first");
    const now = Date.now();
    const state = roomyState({ now });
    runPass(state, { dir: TMPDIR, hash: HASH, now });
    const f = frameOf(s);
    ok(f !== null, "a payload for a new session produces a frame in one pass");
    ok(f && f.slots.length === 1 && f.slots[0].start === now * 1000, "the frame has one slot that starts now (µs)");
    ok(f && f.deadline === now * 1000 + 3e6, "the deadline is now plus the default 3 s window");
    ok(f && f.daemon === VERSION, "the frame names the daemon's version");
    ok(f && sameLines(f.slots[0].lines, expected(s, now)), "the frame body is exactly what renderSession returns");
    const hb = heartbeat();
    ok(hb && hb.pid === process.pid && hb.version === VERSION && hb.window === 3 && hb.renewed === now
      && hb.renameFailures === 0 && typeof hb.start === "number" && hb.start <= now, "the pass writes the heartbeat");
    unlinkSync(payloadFile("first"));
  }

  // An unchanged payload for 60 simulated seconds: every pass renews the deadline, and the body
  // still follows the clock (crossing a minute boundary) and matches renderSession at that moment.
  {
    const a = session("steady");
    const b = session("wide", { env: { GAMEBAR_FRAME_WINDOW: "5" } });
    const t0 = Math.ceil(Date.now() / 60000) * 60000 - 20000;
    const state = roomyState({ now: t0 });
    let renewed = true, matches = true, wide = true, prev = -1;
    const clocks = new Set();
    for (let now = t0; now <= t0 + 60000; now += 500) {
      runPass(state, { dir: TMPDIR, hash: HASH, now });
      const f = frameOf(a), g = frameOf(b);
      if (!f || f.deadline !== now * 1000 + 3e6 || f.deadline <= prev) renewed = false;
      if (!g || g.deadline !== now * 1000 + 5e6) wide = false;
      prev = f ? f.deadline : prev;
      if (!f || !sameLines(f.slots[0].lines, expected(a, now))) matches = false;
      if (f && strip(f.slots[0].lines.join("\n")).includes(hhmm(now))) clocks.add(hhmm(now));
    }
    ok(renewed, "every pass over 60 s renews the deadline of an unchanged payload");
    ok(wide, "a forwarded GAMEBAR_FRAME_WINDOW sets that session's window");
    ok(matches, "every pass renders afresh: the body equals renderSession at that pass's moment");
    ok(clocks.size === 2, "the body follows the clock across a minute boundary without a new payload");
    const hb = heartbeat();
    ok(hb?.window === 5, "the heartbeat records the largest window in use");
    unlinkSync(payloadFile("steady"));
    unlinkSync(payloadFile("wide"));
  }

  // A session whose render throws keeps its old frame without renewal; the other one renews,
  // and the failing one renews again once it renders.
  {
    const good = session("good"), bad = session("bad");
    const t0 = Date.now();
    const state = roomyState({ now: t0 });
    runPass(state, { dir: TMPDIR, hash: HASH, now: t0 });
    const before = readFrame(bad);
    // A payload whose cost is not an object: renderSession throws.
    const cost = bad.data.cost;
    bad.data.cost = "not an object";
    ok((() => { try { renderSession({ data: bad.data, env: { ...process.env, ...bad.fwd } }); return false; } catch { return true; } })(),
      "renderSession throws on that payload (the checks below can fail)");
    bad.write();
    let kept = true, others = true;
    for (let i = 1; i <= 6; i++) {
      const now = t0 + i * 500;
      runPass(state, { dir: TMPDIR, hash: HASH, now });
      if (readFrame(bad) !== before) kept = false;
      const g = frameOf(good);
      if (!g || g.deadline !== now * 1000 + 3e6) others = false;
    }
    ok(before !== null && kept, "the failing session keeps its previous frame, deadline included");
    ok(others, "the other session keeps renewing while one session's render throws");
    bad.data.cost = cost;
    bad.write();
    const now = t0 + 4000;
    runPass(state, { dir: TMPDIR, hash: HASH, now });
    ok(frameOf(bad)?.deadline === now * 1000 + 3e6, "the session renews again once it renders");
    unlinkSync(payloadFile("good"));
    unlinkSync(payloadFile("bad"));
  }

  // A half-written payload is ignored; the last one that parsed is used.
  {
    const s = session("half", { label: "whole" });
    const t0 = Date.now();
    const state = roomyState({ now: t0 });
    runPass(state, { dir: TMPDIR, hash: HASH, now: t0 });
    const full = payloadText(s.data, s.fwd);
    let used = true;
    const cuts = [full.slice(0, full.indexOf("\n") - 3), full.slice(0, full.length - 9), full.split("\n")[0] + "\n"];
    cuts.forEach((cut, i) => {
      s.write(cut);
      const now = t0 + (i + 1) * 500;
      runPass(state, { dir: TMPDIR, hash: HASH, now });
      const f = frameOf(s);
      if (!f || f.deadline !== now * 1000 + 3e6 || !sameLines(f.slots[0].lines, expected(s, now))) used = false;
    });
    ok(used, "a half-written payload is ignored and the previous payload keeps rendering");
    s.data.session_name = "fresh-run";
    s.write();
    const now = t0 + 3000;
    runPass(state, { dir: TMPDIR, hash: HASH, now });
    const f = frameOf(s);
    ok(f && strip(f.slots[0].lines.join("\n")).includes("fresh-run"), "a complete payload written after it is picked up");
    ok(f && sameLines(f.slots[0].lines, expected(s, now)), "and the frame matches renderSession for it");
    unlinkSync(payloadFile("half"));
  }

  // Only this installation's payloads: a payload carrying another install hash gets no frame.
  {
    const other = session("foreign", { hash: OTHER });
    const now = Date.now();
    const state = roomyState({ now });
    runPass(state, { dir: TMPDIR, hash: HASH, now });
    ok(!existsSync(frameFile("foreign", OTHER)) && !existsSync(frameFile("foreign", HASH)),
      "a payload with another install's hash is neither rendered nor answered");
    unlinkSync(payloadFile("foreign", OTHER));
  }

  // A forwarded variable the session leaves unset stays unset for that session's render, even
  // when the daemon's own environment (inherited from whichever session's hook started it) sets it.
  {
    const saved = { theme: process.env.GAMEBAR_THEME, state: process.env.GAMEBAR_STATE, wt: process.env.WT_SESSION };
    process.env.GAMEBAR_THEME = "minecraft";
    process.env.GAMEBAR_STATE = path.join(SB, "spawner-state.json");
    process.env.WT_SESSION = "spawner-terminal";
    try {
      const s = session("unset");
      delete s.fwd.GAMEBAR_STATE;
      s.write();
      const now = Date.now();
      const state = roomyState({ now });
      runPass(state, { dir: TMPDIR, hash: HASH, now });
      const own = { ...process.env, ...s.fwd };
      delete own.GAMEBAR_THEME;
      delete own.GAMEBAR_STATE;
      delete own.WT_SESSION;
      const want = renderAt(s.data, own, now);
      const inherited = renderAt(s.data, { ...process.env, ...s.fwd }, now);
      ok(!sameLines(want, inherited), "the daemon's own GAMEBAR_THEME would change the render (so the next case can tell)");
      ok(sameLines(frameOf(s)?.slots[0].lines, want), "a session without GAMEBAR_THEME renders the default theme, not the daemon's");
      ok(state.sessions.get("unset")?.env.GAMEBAR_STATE === undefined,
        "a session without GAMEBAR_STATE does not take the daemon's checkpoint path");
      ok(state.sessions.get("unset")?.env.WT_SESSION === undefined,
        "a session without WT_SESSION does not take the terminal of the session that started the daemon");
    } finally {
      if (saved.wt === undefined) delete process.env.WT_SESSION; else process.env.WT_SESSION = saved.wt;
      process.env.GAMEBAR_THEME = saved.theme;
      if (saved.state === undefined) delete process.env.GAMEBAR_STATE; else process.env.GAMEBAR_STATE = saved.state;
      try { unlinkSync(payloadFile("unset")); } catch {}
    }
  }

  // The savings files are the session's own too (S-8): what the daemon inherited, under either
  // name, never reaches a session, and a session's old name is read when it sets only that one.
  {
    const names = ["GAMEBAR_EVENTS", "DOOMBAR_EVENTS", "GAMEBAR_LLMLINGUA", "DOOMBAR_LLMLINGUA",
      "GAMEBAR_SAVINGS_STATE", "DOOMBAR_SAVINGS_STATE"];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    process.env.GAMEBAR_EVENTS = path.join(SB, "spawner-events.jsonl");
    process.env.DOOMBAR_LLMLINGUA = path.join(SB, "spawner-ling.json");
    process.env.GAMEBAR_SAVINGS_STATE = path.join(SB, "spawner-savings.json");
    try {
      const own = { events: path.join(SB, "own-events.jsonl"), ling: path.join(SB, "own-ling.json") };
      const s = session("savings-own");
      delete s.fwd.GAMEBAR_EVENTS;
      delete s.fwd.GAMEBAR_LLMLINGUA;
      Object.assign(s.fwd, { DOOMBAR_EVENTS: own.events, GAMEBAR_LLMLINGUA: own.ling });
      s.write();
      const now = Date.now();
      const state = roomyState({ now });
      runPass(state, { dir: TMPDIR, hash: HASH, now });
      const env = state.sessions.get("savings-own")?.env ?? {};
      ok(envGet("EVENTS", env) === own.events, `a session's own DOOMBAR_EVENTS wins over the daemon's GAMEBAR_EVENTS (got ${envGet("EVENTS", env)})`);
      ok(envGet("LLMLINGUA", env) === own.ling, `a session's own GAMEBAR_LLMLINGUA wins over the daemon's DOOMBAR_LLMLINGUA (got ${envGet("LLMLINGUA", env)})`);
      ok(envGet("SAVINGS_STATE", env) === undefined,
        "a session without GAMEBAR_SAVINGS_STATE does not take the daemon's savings file");
    } finally {
      for (const n of names) if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n];
      try { unlinkSync(payloadFile("savings-own")); } catch {}
    }
  }

  // A setting has two names (src/platform/env.js), and the daemon drops both from its own
  // environment: a session that sets only one of them renders with it, even when the daemon
  // inherited the other name with another value.
  {
    const saved = { now: process.env.GAMEBAR_PRESET, old: process.env.DOOMBAR_PRESET };
    const full = path.join(PRESETS, "full.toml"), minimal = path.join(PRESETS, "minimal.toml");
    try {
      for (const [inherited, forwarded] of [["GAMEBAR_PRESET", "DOOMBAR_PRESET"], ["DOOMBAR_PRESET", "GAMEBAR_PRESET"]]) {
        delete process.env.GAMEBAR_PRESET;
        delete process.env.DOOMBAR_PRESET;
        process.env[inherited] = full;
        const s = session(`only-${forwarded}`);
        delete s.fwd.GAMEBAR_PRESET;
        s.fwd[forwarded] = minimal;
        s.write();
        const now = Date.now();
        const state = roomyState({ now });
        runPass(state, { dir: TMPDIR, hash: HASH, now });
        const base = { ...process.env, ...s.fwd };
        delete base.GAMEBAR_PRESET;
        delete base.DOOMBAR_PRESET;
        const want = renderAt(s.data, { ...base, GAMEBAR_PRESET: minimal }, now);
        const other = renderAt(s.data, { ...base, GAMEBAR_PRESET: full }, now);
        ok(!sameLines(want, other), `the inherited ${inherited} would change the render (so the next case can tell)`);
        ok(sameLines(frameOf(s)?.slots[0].lines, want),
          `a session forwarding only ${forwarded} renders with it, though the daemon inherited a different ${inherited}`);
        unlinkSync(payloadFile(`only-${forwarded}`));
      }
      // Nor does an old name the daemon inherited reach a session that sets neither name (which
      // draws the default skin, the full one).
      delete process.env.GAMEBAR_PRESET;
      process.env.DOOMBAR_PRESET = minimal;
      const s = session("neither");
      delete s.fwd.GAMEBAR_PRESET;
      s.write();
      const now = Date.now();
      runPass(roomyState({ now }), { dir: TMPDIR, hash: HASH, now });
      const base = { ...process.env, ...s.fwd };
      delete base.GAMEBAR_PRESET;
      delete base.DOOMBAR_PRESET;
      const want = renderAt(s.data, base, now);
      ok(!sameLines(want, renderAt(s.data, { ...base, DOOMBAR_PRESET: minimal }, now)),
        "the inherited DOOMBAR_PRESET would change the render (so the next case can tell)");
      ok(sameLines(frameOf(s)?.slots[0].lines, want), "a session that sets neither name does not take the daemon's DOOMBAR_PRESET");
      unlinkSync(payloadFile("neither"));
    } finally {
      if (saved.now === undefined) delete process.env.GAMEBAR_PRESET; else process.env.GAMEBAR_PRESET = saved.now;
      if (saved.old === undefined) delete process.env.DOOMBAR_PRESET; else process.env.DOOMBAR_PRESET = saved.old;
    }
  }

  // The skin is the session's own: one session's GAMEBAR_SKIN draws that skin, and a session without
  // one never takes the GAMEBAR_SKIN the daemon inherited.
  {
    const { defaultGame } = await import("../../src/games/index.js");
    const sizes = defaultGame().presetSkins;
    const saved = process.env.GAMEBAR_SKIN;
    process.env.GAMEBAR_SKIN = sizes.minimal;
    try {
      const own = session("skin-own", { env: { GAMEBAR_SKIN: sizes.standard } });
      const none = session("skin-none");
      const now = Date.now();
      runPass(roomyState({ now }), { dir: TMPDIR, hash: HASH, now });
      const base = { ...process.env };
      delete base.GAMEBAR_SKIN;
      const render = (s, env = {}) => renderAt(s.data, { ...base, ...s.fwd, ...env }, now);
      ok(!sameLines(render(own), render(own, { GAMEBAR_SKIN: sizes.minimal })),
        "the daemon's own GAMEBAR_SKIN would change the render (so the next cases can tell)");
      ok(sameLines(frameOf(own)?.slots[0].lines, render(own)), `a session forwarding GAMEBAR_SKIN=${sizes.standard} draws that skin`);
      ok(sameLines(frameOf(none)?.slots[0].lines, render(none)), "a session without GAMEBAR_SKIN does not take the daemon's");
      unlinkSync(payloadFile("skin-own"));
      unlinkSync(payloadFile("skin-none"));
    } finally {
      if (saved === undefined) delete process.env.GAMEBAR_SKIN; else process.env.GAMEBAR_SKIN = saved;
    }
  }

  ok(warned.size === 0, `no compared frame carries a warning line, so every script ran on both sides${warned.size ? ` (${[...warned].join("; ")})` : ""}`);

  // Skin scripts run in the daemon's one script worker, under a time budget for the whole pass that
  // every session shares. The order in which sessions get their scripts run turns from pass to
  // pass, so none of them is always last.
  {
    // A user skin of text elements bound to the model's name, each running `script` from the skin's
    // folder.
    const scripted = (name, source, count = 1) => {
      const dir = path.join(SANDBOX_ENV.GAMEBAR_USER_DIR, "skins", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "s.js"), source);
      const ids = Array.from({ length: count }, (_, i) => `e${i}`);
      writeFileSync(path.join(dir, `${name}.toml`), [
        "version = 1", 'root = "bar"', "[element.bar]", 'kind = "row"', `children = ${JSON.stringify(ids)}`,
        ...ids.flatMap((id) => [`[element.${id}]`, 'kind = "text"', 'metric = "model.name"', "width = 12", "min_width = 12", 'script = "s.js"']),
      ].join("\n"));
      return path.join(dir, "s.js");
    };
    const text = (s) => strip((frameOf(s)?.slots[0].lines || []).join("\n"));
    const timed = (state, now) => { const t = performance.now(); runPass(state, { dir: TMPDIR, hash: HASH, now }); return performance.now() - t; };

    // Three sessions, each with a script that picks what to show from the time (a looping
    // animation): every pass renews every session's frame with what its script returned, and the
    // pass stays within its budget (plus the backstop's grace for the last batch).
    {
      scripted("ticker", 'function render(i) { return { params: { icon: "T" + (i.tick % 10) + " " } }; }');
      const ss = ["tick-a", "tick-b", "tick-c"].map((k) => session(k, { env: { GAMEBAR_SKIN: "ticker" } }));
      const t0 = Date.now();
      const state = createState({ version: VERSION, now: t0 });
      let renewed = true, drawn = true, slowest = 0;
      for (let k = 0; k < 6; k++) {
        const now = t0 + k * 1000;
        slowest = Math.max(slowest, timed(state, now));
        const tick = Math.floor(now / 1000) % 10;
        for (const s of ss) {
          if (frameOf(s)?.deadline !== now * 1000 + 3e6) renewed = false;
          if (!text(s).includes(`T${tick} `)) drawn = false;
        }
      }
      ok(renewed, "with a script in each of three sessions, every pass renews every frame within its window");
      ok(drawn, "and every frame shows what its session's script returned for that pass");
      ok(slowest < 200 + 40 + 100, `and the pass stays within its budget (slowest ${slowest.toFixed(0)} ms)`);
      state.scripts.host.close();
      for (const s of ss) unlinkSync(payloadFile(s.key));
    }

    // A script stuck where its timeout cannot reach it: the backstop restarts the worker, which uses
    // up the pass. The next session's healthy script draws its default for that pass, with no
    // warning, and runs on the following pass.
    {
      const hang = scripted("stuck", 'function render() { return { params: { icon: "NEVER" } }; }');
      scripted("calm", 'function render() { return { params: { icon: "CALM " } }; }');
      const host = createScriptHost({ simulateNativeHang: hang });
      const a = session("a-stuck", { env: { GAMEBAR_SKIN: "stuck" } });
      const b = session("b-calm", { env: { GAMEBAR_SKIN: "calm" } });
      const t0 = Date.now();
      const state = createState({ version: VERSION, now: t0, scriptHost: host, scriptPassMs: 20 });
      timed(state, t0);
      ok(/gamebar: .*s\.js/.test(text(a)) && !text(a).includes("NEVER"), "the stuck script's element draws its default and a warning shows");
      ok(!text(b).includes("CALM") && !text(b).includes("gamebar:") && host.spawns === 2,
        "the next session's script is skipped for that pass, with no warning, once the restart used up the pass");
      timed(state, t0 + 1000);
      ok(text(b).includes("CALM"), "and runs on the following pass");
      host.close();
      unlinkSync(payloadFile(a.key));
      unlinkSync(payloadFile(b.key));
    }

    // Two sessions whose scripts each need most of the pass: over successive passes both get them
    // run, because the session that went last goes first on the next pass. The pass's budget is
    // what is tested; each call's own budget is one no stall of the machine runs a 15 ms call past,
    // so no script is turned off for a cooldown, and the host's grace stays the product's, so the
    // pass still cuts the second session short.
    {
      scripted("hog", 'function render(i) { var t = Date.now(); while (Date.now() - t < 15) {} return { params: { icon: "R" + (i.tick % 10) + " " } }; }', 4);
      const ss = ["hog-x", "hog-y"].map((k) => session(k, { env: { GAMEBAR_SKIN: "hog" } }));
      const t0 = Date.now();
      const host = createScriptHost({ callBudgetMs: 2000, startupMs: 10000 });
      const state = createState({ version: VERSION, now: t0, scriptHost: host, scriptPassMs: 70, callBudgetMs: 40 });
      const full = new Map(ss.map((s) => [s.key, 0]));
      for (let k = 0; k < 4; k++) {
        const now = t0 + k * 1000;
        timed(state, now);
        const want = `R${Math.floor(now / 1000) % 10} `;
        for (const s of ss) if (text(s).split(want).length - 1 === 4) full.set(s.key, full.get(s.key) + 1);
      }
      // Each goes first in every other pass; going last, its scripts would not fit after the other's.
      ok([...full.values()].every((n) => n >= 2), `both sessions get all their scripts run in every other pass at least (${[...full.entries()].map(([k, n]) => `${k} ${n}`).join(", ")})`);
      host.close();
      for (const s of ss) unlinkSync(payloadFile(s.key));
    }
  }

  // A payload the client has not rewritten for the idle period (a session that ended without
  // SessionEnd) gets no frame after a daemon start and does not keep the daemon alive. A payload
  // written within the idle period still renders.
  {
    const idleMs = 10000;
    const t0 = Date.now();
    const orphan = session("orphan");
    const old = new Date(t0 - 2 * idleMs);
    utimesSync(payloadFile("orphan"), old, old);
    const state = createState({ version: VERSION, now: t0 - idleMs, idleMs });
    const r = runPass(state, { dir: TMPDIR, hash: HASH, now: t0 });
    ok(readFrame(orphan) === null && r.rendered === 0, "a payload older than the idle period gets no frame");
    ok(r.idle === true, "and it does not keep the daemon alive: the pass reports idle");
    unlinkSync(payloadFile("orphan"));
    const recent = session("recent");
    const written = new Date(t0 - 2000);
    utimesSync(payloadFile("recent"), written, written);
    const fresh = createState({ version: VERSION, now: t0 - idleMs, idleMs });
    const r2 = runPass(fresh, { dir: TMPDIR, hash: HASH, now: t0 });
    ok(r2.rendered === 1 && r2.idle === false && frameOf(recent)?.deadline === t0 * 1000 + 3e6,
      "a payload written within the idle period still renders");
    unlinkSync(payloadFile("recent"));
  }

  // Session lifecycle: a deleted payload ends the session; no payload for the idle period ends it
  // too, and the pass reports idle once no session has been active for that long.
  {
    const gone = session("gone"), quiet = session("quiet");
    const t0 = Date.now();
    const state = createState({ version: VERSION, now: t0, idleMs: 10000 });
    let r = runPass(state, { dir: TMPDIR, hash: HASH, now: t0 });
    ok(r.idle === false, "a pass with active sessions is not idle");
    const goneBefore = readFrame(gone);
    unlinkSync(payloadFile("gone"));
    r = runPass(state, { dir: TMPDIR, hash: HASH, now: t0 + 500 });
    ok(readFrame(gone) === goneBefore, "a session whose payload file disappeared is no longer renewed (its frame is left alone)");
    ok(frameOf(quiet)?.deadline === (t0 + 500) * 1000 + 3e6, "the other session is still renewed");
    r = runPass(state, { dir: TMPDIR, hash: HASH, now: t0 + 9500 });
    ok(r.idle === false && frameOf(quiet)?.deadline === (t0 + 9500) * 1000 + 3e6, "inside the idle period the session is still served");
    const quietBefore = readFrame(quiet);
    r = runPass(state, { dir: TMPDIR, hash: HASH, now: t0 + 10500 });
    ok(readFrame(quiet) === quietBefore, "a session with no new payload for the idle period is no longer served");
    ok(r.idle === true, "with no active session for the idle period the pass reports idle");
    quiet.write();
    r = runPass(state, { dir: TMPDIR, hash: HASH, now: t0 + 11000 });
    ok(r.idle === false && frameOf(quiet)?.deadline === (t0 + 11000) * 1000 + 3e6, "a new payload brings the session back");
    unlinkSync(payloadFile("quiet"));
    const empty = createState({ version: VERSION, now: t0, idleMs: 10000 });
    ok(runPass(empty, { dir: TMPDIR, hash: HASH, now: t0 + 9000 }).idle === false
      && runPass(empty, { dir: TMPDIR, hash: HASH, now: t0 + 10000 }).idle === true,
    "a daemon that never gets a payload is idle once the idle period since its start has passed");
  }

  // GAMEBAR_COLLECT_MS in the render's environment sets how long one CPU sample is reused.
  {
    const cache = path.join(TMPDIR, "gamebar_cpu.json");
    const pinned = readFileSync(cache, "utf8");
    const realNow = Date.now;
    const s = session("collect", { env: { GAMEBAR_COLLECT_MS: "5000" } });
    const plain = { ...s, fwd: { ...s.fwd } };
    delete plain.fwd.GAMEBAR_COLLECT_MS;
    const sampledAt = () => JSON.parse(readFileSync(cache, "utf8")).ts;
    try {
      let t = realNow();
      Date.now = () => t;
      rmSync(cache);
      expected(s, t);
      const first = sampledAt();
      t += 2000;
      expected(s, t);
      ok(first === t - 2000 && sampledAt() === first, "with GAMEBAR_COLLECT_MS=5000 two renders 2 s apart reuse one CPU sample");
      t += 2000;
      expected(plain, t);
      ok(sampledAt() === t, "without it the default 1 s interval takes a new sample");
    } finally {
      Date.now = realNow;
      writeFileSync(cache, pinned);
      unlinkSync(payloadFile("collect"));
    }
  }

  // The daemon starts the detached reaper (`node src/hook.js --reap`) on its own timer: at most one
  // per GAMEBAR_REAP_TICK (default 15 s), on Windows only, never with GAMEBAR_MSYS_REAP=0, and
  // never waits for it. Driven with a simulated clock and a recording spawn, so no reaper runs.
  {
    const fakeSpawn = () => {
      const calls = [];
      const fn = (cmd, args, opts) => {
        const child = { unrefd: false, unref() { this.unrefd = true; }, on() { return this; } };
        calls.push({ cmd, args, opts, child });
        return child;
      };
      return { fn, calls };
    };
    const drive = ({ env = {}, platform = "win32", ms = 60000 } = {}) => {
      const sp = fakeSpawn();
      const t0 = Date.now();
      const state = createState({ version: VERSION, now: t0 });
      for (let now = t0; now <= t0 + ms; now += 500) maybeStartReaper(state, { now, env, platform, spawn: sp.fn });
      return sp.calls;
    };
    const calls = drive();
    ok(calls.length === 5, `over 60 s the default 15 s tick starts one reaper per interval (got ${calls.length})`);
    const c = calls[0];
    ok(c && c.cmd === process.execPath && /[\\/]src[\\/]hook\.js$/.test(c.args[0]) && c.args[1] === "--reap"
      && c.args.length === 2, "the reaper is `node src/hook.js --reap`");
    ok(c && c.opts.detached === true && c.opts.stdio === "ignore" && c.opts.windowsHide === true && c.child.unrefd,
      "it is detached, silent and unref'd, so the daemon never waits for it");
    ok(drive({ env: { GAMEBAR_REAP_TICK: "1000" }, ms: 10000 }).length === 11, "GAMEBAR_REAP_TICK sets the interval");
    ok(drive({ env: { GAMEBAR_MSYS_REAP: "0" } }).length === 0, "GAMEBAR_MSYS_REAP=0 starts no reaper");
    ok(drive({ platform: "linux" }).length === 0, "no reaper outside Windows");
    const throwing = createState({ version: VERSION });
    let threw = false;
    try { maybeStartReaper(throwing, { env: {}, platform: "win32", spawn: () => { throw new Error("spawn failed"); } }); } catch { threw = true; }
    ok(!threw, "a reaper that cannot be spawned never breaks the loop");
    // A reaper that never exits blocks the next interval, but only until it has run for 30 s:
    // then it is killed and the next one starts in the same call.
    const hung = createState({ version: VERSION, now: 0 });
    const reapers = [];
    const hangs = () => {
      const child = { exitCode: null, signalCode: null, kills: 0, on() {}, unref() {}, kill() { this.kills += 1; } };
      reapers.push(child);
      return child;
    };
    for (let now = 0; now <= 30000; now += 500) maybeStartReaper(hung, { now, env: {}, platform: "win32", spawn: hangs });
    ok(reapers.length === 1 && reapers[0].kills === 0,
      `a reaper that never exits blocks the next interval for 30 s (got ${reapers.length} started)`);
    maybeStartReaper(hung, { now: 30500, env: {}, platform: "win32", spawn: hangs });
    ok(reapers[0].kills === 1 && reapers.length === 2, "after 30 s the hung reaper is killed and a new one starts");
    reapers[1].exitCode = 0;
    maybeStartReaper(hung, { now: 45500, env: {}, platform: "win32", spawn: hangs });
    ok(reapers.length === 3 && reapers[1].kills === 0, "once a reaper has exited, the next interval starts a new one without a kill");
    const stuck = createState({ version: VERSION, now: 0 });
    let started = 0;
    const unkillable = () => { started++; return { exitCode: null, signalCode: null, on() {}, unref() {}, kill() { throw new Error("EPERM"); } }; };
    let killThrew = false;
    try {
      for (let now = 0; now <= 31000; now += 500) maybeStartReaper(stuck, { now, env: {}, platform: "win32", spawn: unkillable });
    } catch { killThrew = true; }
    ok(!killThrew && started === 2, `a reaper that cannot be killed never breaks the loop, and the next one still starts (got ${started})`);
  }

  // ---- Real processes -------------------------------------------------------------------------
  // The single-instance address is a named pipe on Windows and a socket file in the runtime
  // directory elsewhere (one per installation and runtime directory there).
  const WIN = process.platform === "win32";
  {
    // A copy of the package: its own install hash, pipe and src/ to watch (src/ carries the games'
    // presets and assets). node_modules is linked, not copied.
    const copyPackage = (name) => {
      const dir = path.join(SB, name);
      mkdirSync(dir);
      cpSync(path.join(ROOT, "src"), path.join(dir, "src"), { recursive: true });
      cpSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
      symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
      return { dir, hash: rootHash(dir) };
    };
    const startDaemon = (pkg, tmp, idleMs = 60000) => {
      const env = { ...SANDBOX_ENV, SystemRoot: process.env.SystemRoot, ...sandboxEnv(tmp),
        GAMEBAR_DAEMON_IDLE_MS: String(idleMs) };
      const c = spawn(process.execPath, [path.join(pkg.dir, "src", "daemon.js")], { env, stdio: ["ignore", "ignore", "pipe"] });
      c.err = "";
      c.stderr.on("data", (d) => { c.err += d; });
      c.exited = new Promise((r) => c.on("exit", (code) => r(code)));
      children.push(c);
      return c;
    };
    const waitFor = async (cond, ms = 10000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (cond()) return true;
      return cond();
    };
    const exitWithin = (c, ms) => Promise.race([c.exited, sleep(ms).then(() => "timeout")]);
    const pipeFree = (hash) => new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(pipePath(hash), () => srv.close(() => resolve(true)));
    });
    const sockOf = (pkg, dir) => daemonSocket(pkg.hash, { GAMEBAR_RUNTIME_DIR: dir });
    const addressFree = async (pkg, dir) => (WIN ? pipeFree(pkg.hash) : !existsSync(sockOf(pkg, dir)));
    const answers = (addr) => new Promise((resolve) => {
      const s = net.connect(addr);
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => resolve(false));
    });

    const A = copyPackage("pkg-a"), B = copyPackage("pkg-b");
    // Last-access times far enough back that NTFS records the next read (it skips updates within
    // about an hour); set before the daemon starts, so its own view of src/ already includes them.
    const srcA = path.join(A.dir, "src");
    const longAgo = new Date(Date.now() - 2 * 3600e3);
    // Every file under src/, subfolders included: the daemon watches them all.
    const srcFiles = readdirSync(srcA, { recursive: true }).map((f) => path.join(srcA, f)).filter((p) => statSync(p).isFile());
    for (const p of srcFiles) utimesSync(p, longAgo, statSync(p).mtime);
    const shared = path.join(SB, "rt-shared");
    mkdirSync(shared);

    const a1 = startDaemon(A, shared);
    ok(await waitFor(() => heartbeat(A.hash, shared)?.pid === a1.pid), `the daemon starts and writes its heartbeat ${a1.err}`);
    const hb = heartbeat(A.hash, shared);
    ok(hb && hb.version === VERSION && hb.window === 3 && typeof hb.start === "number" && typeof hb.renewed === "number"
      && hb.renameFailures === 0, "the heartbeat carries pid, start, version, window, renewed and renameFailures");

    // A second daemon for the same installation exits at once and writes nothing.
    const a2 = startDaemon(A, shared);
    const code = await exitWithin(a2, 10000);
    ok(code === 0, `a second daemon for the same install root exits with code 0 (got ${code}) ${a2.err}`);
    ok(heartbeat(A.hash, shared)?.pid === a1.pid, "the first daemon keeps serving");
    const lone = path.join(SB, "rt-second");
    mkdirSync(lone);
    const a3 = startDaemon(A, lone);
    if (WIN) {
      // The pipe is one per installation, whatever the temp directory.
      ok(await exitWithin(a3, 10000) === 0, "on Windows a second daemon of the install exits from another temp dir too");
      ok(readdirSync(lone).length === 0, "the second daemon writes nothing");
    } else {
      ok(await waitFor(() => heartbeat(A.hash, lone)?.pid === a3.pid),
        `on Linux and macOS a daemon of the same install runs in another runtime dir ${a3.err}`);
      a3.kill();
      await a3.exited;
    }

    // Another installation runs beside it, each with its own heartbeat and only its own payloads.
    const b1 = startDaemon(B, shared);
    ok(await waitFor(() => heartbeat(B.hash, shared)?.pid === b1.pid), `a daemon for another install root runs beside it ${b1.err}`);
    session("sa", { hash: A.hash, dir: shared });
    session("sb", { hash: B.hash, dir: shared });
    ok(await waitFor(() => existsSync(frameFile("sa", A.hash, shared)) && existsSync(frameFile("sb", B.hash, shared))),
      "each daemon writes the frame for its own installation's payload");
    await sleep(1500);
    ok(!existsSync(frameFile("sb", A.hash, shared)) && !existsSync(frameFile("sa", B.hash, shared)),
      "neither daemon writes a frame for a payload carrying the other's hash");
    ok(heartbeat(A.hash, shared)?.pid === a1.pid && heartbeat(B.hash, shared)?.pid === b1.pid, "each keeps its own heartbeat");

    // Reading src/ is not a change, even when it updates the files' last-access time: the daemon
    // keeps running past its next look at src/.
    for (const p of srcFiles) readFileSync(p);
    await sleep(3000);
    ok(a1.exitCode === null, "reading the files under src/ does not make the daemon exit");

    // Touching a file under the daemon's own src/ makes it exit.
    appendFileSync(path.join(A.dir, "src", "kit", "ansi.js"), "\n// touched\n");
    ok(await exitWithin(a1, 10000) !== "timeout", "a change under the daemon's own src/ makes it exit");
    // Session "sa" still uses the bar, so the daemon started its successor from the new source:
    // a new pid renews the heartbeat and keeps the session's frame fresh (#65).
    ok(await waitFor(() => { const hb = heartbeat(A.hash, shared); return hb && hb.pid !== a1.pid; }, 10000),
      "while a session uses the bar, the daemon starts its successor from the changed source");
    const successor = heartbeat(A.hash, shared)?.pid;
    if (successor) {
      try { process.kill(successor); } catch {}
      ok(await waitFor(() => { try { process.kill(successor, 0); return false; } catch { return true; } }, 10000), "the successor is ended for the next cases");
    }
    ok(b1.exitCode === null, "the other installation's daemon keeps running");
    b1.kill();
    await b1.exited;

    // A change to a file in a subfolder of src/ makes the daemon exit too: the source is split
    // into folders, and a running daemon must pick up a change anywhere in it.
    {
      const E = copyPackage("pkg-e");
      mkdirSync(path.join(E.dir, "src", "nested"));
      writeFileSync(path.join(E.dir, "src", "nested", "probe.js"), "export const probe = 1;\n");
      const rtE = path.join(SB, "rt-nested");
      mkdirSync(rtE);
      const e1 = startDaemon(E, rtE);
      ok(await waitFor(() => heartbeat(E.hash, rtE)?.pid === e1.pid), `the nested-source daemon starts ${e1.err}`);
      appendFileSync(path.join(E.dir, "src", "nested", "probe.js"), "// touched\n");
      ok(await exitWithin(e1, 10000) !== "timeout", "a change in a subfolder of the daemon's src/ makes it exit");
    }

    // With no payload for the idle period, the daemon exits and removes its pipe and heartbeat,
    // nothing else.
    const idle = path.join(SB, "rt-idle");
    mkdirSync(idle);
    writeFileSync(path.join(idle, "unrelated.txt"), "x");
    const listing = () => readdirSync(idle).sort().join(",");
    const before = listing();
    const c1 = startDaemon(B, idle, 1500);
    ok(await waitFor(() => heartbeat(B.hash, idle)?.pid === c1.pid), "the idle-test daemon starts");
    const idleCode = await exitWithin(c1, 15000);
    ok(idleCode === 0, `with no payload for the idle period the daemon exits with code 0 (got ${idleCode}) ${c1.err}`);
    ok(listing() === before, "its heartbeat and socket are gone and nothing else in the runtime dir changed");
    ok(await addressFree(B, idle), "its address is released");

    // The daemon holds no handle inside its package: the package directory can be renamed while
    // it runs (npm moves the old copy aside on an upgrade), and the daemon then leaves.
    const C = copyPackage("pkg-c");
    const moveTmp = path.join(SB, "rt-move");
    mkdirSync(moveTmp);
    const m1 = startDaemon(C, moveTmp);
    ok(await waitFor(() => heartbeat(C.hash, moveTmp)?.pid === m1.pid), "the rename-test daemon starts");
    let renamed = true;
    try { renameSync(C.dir, C.dir + "-moved"); } catch (e) { renamed = e.code; }
    ok(renamed === true, `the package directory of a running daemon can be renamed (got ${renamed})`);
    ok(await exitWithin(m1, 10000) === 0, "the daemon exits once its src/ is gone");

    if (!WIN) {
      // A daemon killed outright leaves its socket file; the next one takes it over.
      const D = copyPackage("pkg-d");
      const st = path.join(SB, "rt-stale");
      mkdirSync(st);
      const sock = sockOf(D, st);
      const d1 = startDaemon(D, st);
      ok(await waitFor(() => heartbeat(D.hash, st)?.pid === d1.pid), `the stale-socket daemon starts ${d1.err}`);
      if (process.platform === "linux") {
        ok(heartbeat(D.hash, st)?.startTicks === procStartTicks(d1.pid),
          `the heartbeat carries the daemon's start time from /proc (${heartbeat(D.hash, st)?.startTicks})`);
      }
      d1.kill("SIGKILL");
      await d1.exited;
      ok(existsSync(sock), "a daemon killed with SIGKILL leaves its socket file");
      const d2 = startDaemon(D, st);
      ok(await waitFor(() => heartbeat(D.hash, st)?.pid === d2.pid), `a new daemon takes the stale socket over ${d2.err}`);
      ok(!existsSync(`${sock}.lock`), "and leaves no takeover lock behind");
      session("sd", { hash: D.hash, dir: st });
      ok(await waitFor(() => existsSync(frameFile("sd", D.hash, st))), "and renders");

      // A daemon whose socket file was deleted steps aside.
      unlinkSync(sock);
      ok(await exitWithin(d2, 6000) !== "timeout", "a daemon whose socket file was deleted exits");

      // SIGTERM (what uninstall sends) leaves neither socket nor heartbeat behind.
      const d3 = startDaemon(D, st);
      ok(await waitFor(() => heartbeat(D.hash, st)?.pid === d3.pid), "the SIGTERM-test daemon starts");
      d3.kill("SIGTERM");
      ok(await exitWithin(d3, 5000) === 0, "SIGTERM makes the daemon exit with code 0");
      ok(!existsSync(sock) && !existsSync(heartbeatFile(D.hash, st)), "and it leaves neither socket nor heartbeat");

      // Daemons that find the same stale socket at once take it over one at a time (a lock beside
      // the socket) and settle on one, which keeps its socket.
      const d4 = startDaemon(D, st);
      ok(await waitFor(() => heartbeat(D.hash, st)?.pid === d4.pid), "the race-test daemon starts");
      d4.kill("SIGKILL");
      await d4.exited;
      const racers = [startDaemon(D, st), startDaemon(D, st), startDaemon(D, st), startDaemon(D, st)];
      await sleep(5000);
      const alive = racers.filter((c) => c.exitCode === null && c.signalCode === null);
      ok(alive.length === 1, `four daemons on one stale socket leave exactly one running (got ${alive.length})`);
      ok(!existsSync(`${sock}.lock`), "and no takeover lock is left behind");
      ok(alive.length === 1 && await answers(sock), "and that one still answers on the socket");
      ok(alive.length === 1 && await waitFor(() => heartbeat(D.hash, st)?.pid === alive[0].pid, 2000),
        "and it is the one writing the heartbeat");
    }
  }
} finally {
  DAEMON_HOST.close();
  RENDER_HOST.close();
  await stopAll();
  rmSync(SB, { recursive: true, force: true });
}

// The names the daemon takes from a session's payload are exactly the names the client writes:
// one missing on either side would render that session with the daemon's own value.
{
  const src = readFileSync(path.join(ROOT, "src", "gamebar-client.sh"), "utf8");
  const m = /for name in ([\s\S]*?); do/.exec(src);
  const clientNames = m ? m[1].replace(/\\\r?\n/g, " ").trim().split(/\s+/).sort() : [];
  const daemonNames = [...FORWARDED_ENV].sort();
  ok(clientNames.length > 0 && JSON.stringify(clientNames) === JSON.stringify(daemonNames),
    `the client forwards exactly FORWARDED_ENV (client ${clientNames.join(",")}; daemon ${daemonNames.join(",")})`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
