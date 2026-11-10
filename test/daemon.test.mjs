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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRESETS = path.join(ROOT, "presets");
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

const SB = mkdtempSync(path.join(os.tmpdir(), "doombar-daemon-"));
const TMPDIR = path.join(SB, "tmp");
for (const d of ["tmp", "tasks", "proj"]) mkdirSync(path.join(SB, d), { recursive: true });
// Before the imports: statusline.js takes its temp dir when it loads. No chafa on PATH, so every
// render draws the pre-rendered .ans faces.
const SANDBOX_ENV = {
  TEMP: TMPDIR, TMP: TMPDIR, TMPDIR, PATH: "", DOOMBAR_MSYS_REAP: "0", DOOMBAR_THEME: "doom",
  DOOMBAR_THEME_FILE: path.join(SB, "no-theme.json"), DOOMBAR_RATELIMITS_SHARE: "0",
  DOOMBAR_RATELIMITS: path.join(SB, "rl.json"), DOOMBAR_TASKS_DIR: path.join(SB, "tasks"),
  DOOMBAR_EVENTS: path.join(SB, "events.jsonl"), DOOMBAR_LLMLINGUA: path.join(SB, "ling.json"),
  DOOMBAR_PRESET: path.join(PRESETS, "minimal.toml"),
};
Object.assign(process.env, SANDBOX_ENV);
const { renderSession } = await import("../src/statusline.js");
const { sessionPaths, daemonPaths, rootHash } = await import("../src/fold.js");
const { parseFrame } = await import("../src/frame.js");
const { setFaceNoSpawn } = await import("../src/face.js");
const { createState, runPass, pipePath, maybeStartReaper } = await import("../src/daemon.js");
setFaceNoSpawn(true);

const HASH = rootHash();
const OTHER = rootHash(path.join(SB, "elsewhere"));

// What the bash client writes: the environment line, then the stdin JSON as received.
const payloadText = (data, env) =>
  ["doombar-env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`)].join("\t") + "\n" + JSON.stringify(data);
const payloadFile = (key, hash = HASH, dir = TMPDIR) => path.join(dir, path.basename(sessionPaths(key, hash).payload));
const frameFile = (key, hash = HASH, dir = TMPDIR) => path.join(dir, path.basename(sessionPaths(key, hash).frame));
const heartbeatFile = (hash = HASH, dir = TMPDIR) => path.join(dir, path.basename(daemonPaths(hash).heartbeat));

// A session as the client hands it over; `bump` forces a new mtime so a rewrite is always seen.
let bumps = 0;
function session(key, { label = key, env = {}, hash = HASH, dir = TMPDIR } = {}) {
  const fwd = { COLUMNS: "250", DOOMBAR_PRESET: path.join(PRESETS, "full.toml"),
    MUGSHOT_STATE: path.join(SB, `state-${key}.json`), ...env };
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
const expected = (s, nowMs) => renderSession({ data: s.data, env: { ...process.env, ...s.fwd }, now: nowMs / 1000 });
const readFrame = (s) => { try { return readFileSync(frameFile(s.key, s.hash, s.dir), "utf8"); } catch { return null; } };
const frameOf = (s) => parseFrame(readFrame(s) ?? "");
const sameLines = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
  writeFileSync(path.join(TMPDIR, "mugshot_cpu.json"), JSON.stringify({
    ts: Date.now() + 864e5, total: 0, idle: 0, cores: [], result: { cpu: 12, cores: [0.1, 0.2, 0.3, 0.4] } }));

  // A new session gets a frame within one pass, and the frame is what renderSession prints.
  {
    const s = session("first");
    const now = Date.now();
    const state = createState({ version: VERSION, now });
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
    const b = session("wide", { env: { DOOMBAR_FRAME_WINDOW: "5" } });
    const t0 = Math.ceil(Date.now() / 60000) * 60000 - 20000;
    const state = createState({ version: VERSION, now: t0 });
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
    ok(wide, "a forwarded DOOMBAR_FRAME_WINDOW sets that session's window");
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
    const state = createState({ version: VERSION, now: t0 });
    runPass(state, { dir: TMPDIR, hash: HASH, now: t0 });
    const before = readFrame(bad);
    bad.fwd.DOOMBAR_PRESET = path.join(SB, "missing.toml"); // renderSession's readFileSync throws
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
    bad.fwd.DOOMBAR_PRESET = path.join(PRESETS, "full.toml");
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
    const state = createState({ version: VERSION, now: t0 });
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
    const state = createState({ version: VERSION, now });
    runPass(state, { dir: TMPDIR, hash: HASH, now });
    ok(!existsSync(frameFile("foreign", OTHER)) && !existsSync(frameFile("foreign", HASH)),
      "a payload with another install's hash is neither rendered nor answered");
    unlinkSync(payloadFile("foreign", OTHER));
  }

  // A forwarded variable the session leaves unset stays unset for that session's render, even
  // when the daemon's own environment (inherited from whichever session's hook started it) sets it.
  {
    const saved = { theme: process.env.DOOMBAR_THEME, state: process.env.MUGSHOT_STATE };
    process.env.DOOMBAR_THEME = "minecraft";
    process.env.MUGSHOT_STATE = path.join(SB, "spawner-state.json");
    try {
      const s = session("unset");
      delete s.fwd.MUGSHOT_STATE;
      s.write();
      const now = Date.now();
      const state = createState({ version: VERSION, now });
      runPass(state, { dir: TMPDIR, hash: HASH, now });
      const own = { ...process.env, ...s.fwd };
      delete own.DOOMBAR_THEME;
      delete own.MUGSHOT_STATE;
      const want = renderSession({ data: s.data, env: own, now: now / 1000 });
      const inherited = renderSession({ data: s.data, env: { ...process.env, ...s.fwd }, now: now / 1000 });
      ok(!sameLines(want, inherited), "the daemon's own DOOMBAR_THEME would change the render (so the next case can tell)");
      ok(sameLines(frameOf(s)?.slots[0].lines, want), "a session without DOOMBAR_THEME renders the default theme, not the daemon's");
      ok(state.sessions.get("unset")?.env.MUGSHOT_STATE === undefined,
        "a session without MUGSHOT_STATE does not take the daemon's checkpoint path");
    } finally {
      process.env.DOOMBAR_THEME = saved.theme;
      if (saved.state === undefined) delete process.env.MUGSHOT_STATE; else process.env.MUGSHOT_STATE = saved.state;
      try { unlinkSync(payloadFile("unset")); } catch {}
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

  // DOOMBAR_COLLECT_MS in the render's environment sets how long one CPU sample is reused.
  {
    const cache = path.join(TMPDIR, "mugshot_cpu.json");
    const pinned = readFileSync(cache, "utf8");
    const realNow = Date.now;
    const s = session("collect", { env: { DOOMBAR_COLLECT_MS: "5000" } });
    const plain = { ...s, fwd: { ...s.fwd } };
    delete plain.fwd.DOOMBAR_COLLECT_MS;
    const sampledAt = () => JSON.parse(readFileSync(cache, "utf8")).ts;
    try {
      let t = realNow();
      Date.now = () => t;
      rmSync(cache);
      expected(s, t);
      const first = sampledAt();
      t += 2000;
      expected(s, t);
      ok(first === t - 2000 && sampledAt() === first, "with DOOMBAR_COLLECT_MS=5000 two renders 2 s apart reuse one CPU sample");
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
  // per DOOMBAR_REAP_TICK (default 15 s), on Windows only, never with DOOMBAR_MSYS_REAP=0, and
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
    ok(drive({ env: { DOOMBAR_REAP_TICK: "1000" }, ms: 10000 }).length === 11, "DOOMBAR_REAP_TICK sets the interval");
    ok(drive({ env: { DOOMBAR_MSYS_REAP: "0" } }).length === 0, "DOOMBAR_MSYS_REAP=0 starts no reaper");
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
  if (process.platform !== "win32") {
    console.log("  skip real-process cases: the daemon's single-instance pipe is a Windows named pipe");
  } else {
    // A copy of the package: its own install hash, pipe and src/ to watch. assets and
    // node_modules are linked, not copied.
    const copyPackage = (name) => {
      const dir = path.join(SB, name);
      mkdirSync(dir);
      cpSync(path.join(ROOT, "src"), path.join(dir, "src"), { recursive: true });
      cpSync(path.join(ROOT, "presets"), path.join(dir, "presets"), { recursive: true });
      cpSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
      symlinkSync(path.join(ROOT, "assets"), path.join(dir, "assets"), "junction");
      symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
      return { dir, hash: rootHash(dir) };
    };
    const startDaemon = (pkg, tmp, idleMs = 60000) => {
      const env = { ...SANDBOX_ENV, SystemRoot: process.env.SystemRoot, TEMP: tmp, TMP: tmp, TMPDIR: tmp,
        DOOMBAR_DAEMON_IDLE_MS: String(idleMs) };
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

    const A = copyPackage("pkg-a"), B = copyPackage("pkg-b");
    // Last-access times far enough back that NTFS records the next read (it skips updates within
    // about an hour); set before the daemon starts, so its own view of src/ already includes them.
    const srcA = path.join(A.dir, "src");
    const longAgo = new Date(Date.now() - 2 * 3600e3);
    for (const f of readdirSync(srcA)) utimesSync(path.join(srcA, f), longAgo, statSync(path.join(srcA, f)).mtime);
    const shared = path.join(SB, "rt-shared");
    mkdirSync(shared);

    const a1 = startDaemon(A, shared);
    ok(await waitFor(() => heartbeat(A.hash, shared)?.pid === a1.pid), `the daemon starts and writes its heartbeat ${a1.err}`);
    const hb = heartbeat(A.hash, shared);
    ok(hb && hb.version === VERSION && hb.window === 3 && typeof hb.start === "number" && typeof hb.renewed === "number"
      && hb.renameFailures === 0, "the heartbeat carries pid, start, version, window, renewed and renameFailures");

    // A second daemon for the same installation exits at once and writes nothing.
    const lone = path.join(SB, "rt-second");
    mkdirSync(lone);
    const a2 = startDaemon(A, lone);
    const code = await exitWithin(a2, 10000);
    ok(code === 0, `a second daemon for the same install root exits with code 0 (got ${code}) ${a2.err}`);
    ok(readdirSync(lone).length === 0, "the second daemon writes nothing");
    ok(heartbeat(A.hash, shared)?.pid === a1.pid, "the first daemon keeps serving");

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
    for (const f of readdirSync(srcA)) readFileSync(path.join(srcA, f));
    await sleep(3000);
    ok(a1.exitCode === null, "reading the files under src/ does not make the daemon exit");

    // Touching a file under the daemon's own src/ makes it exit.
    appendFileSync(path.join(A.dir, "src", "ansi.js"), "\n// touched\n");
    ok(await exitWithin(a1, 10000) !== "timeout", "a change under the daemon's own src/ makes it exit");
    ok(b1.exitCode === null, "the other installation's daemon keeps running");
    b1.kill();
    await b1.exited;

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
    ok(listing() === before, "its heartbeat is gone and nothing else in the temp dir changed");
    ok(await pipeFree(B.hash), "its pipe is released");

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
  }
} finally {
  await stopAll();
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
