#!/usr/bin/env node
// The hooks start and restart this installation's render daemon.
//
// Every real-process case runs the hook from a COPY of the package in a sandbox, so the copy has
// its own install hash, pipe, heartbeat and claim and never meets the live bar of this machine.
// In most copies src/daemon.js is replaced by a small fake that logs each start, binds the pipe
// and writes a heartbeat the way the test asks (renewing, stale, or with another version). Counting
// the logged starts is what proves "exactly one spawn": the singleton pipe alone would make the
// number of SURVIVING daemons look right even if every hook had spawned one.
//
// Windows only for the real processes (the pipe is a Windows named pipe); the claim rule is also
// tested in-process everywhere. Every daemon this file starts, directly or through a hook, is
// found by its command line and killed in `finally`.

import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync, symlinkSync, utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SB = mkdtempSync(path.join(os.tmpdir(), "doombar-restart-"));
const { sessionPaths, daemonPaths, rootHash } = await import("../src/fold.js");
const { claimRestart } = await import("../src/hook.js");

const THROTTLE = 500;
const GRACE = 1500;
const SID = "restart-session";

// Stands in for src/daemon.js inside a copy. Logs "spawn <pid>" first thing, then binds this
// copy's pipe (exits quietly if it is taken), logs "bound <pid>" and writes heartbeats:
// FAKE_MODE=stale writes one heartbeat a minute old and never renews (a hung daemon); otherwise
// it renews every 100 ms. FAKE_VERSION overrides the version it reports.
const FAKE_DAEMON = `
import { appendFileSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootHash, daemonPaths } from "./fold.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = rootHash(root);
const log = path.join(os.tmpdir(), "fake-daemon.log");
appendFileSync(log, "spawn " + process.pid + "\\n");
const version = process.env.FAKE_VERSION || JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const hb = daemonPaths(hash).heartbeat;
const start = Math.round(performance.timeOrigin);
const beat = (renewed) => {
  const tmp = hb + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, start, version, window: 1, renewed, renameFailures: 0 }));
  renameSync(tmp, hb);
};
const srv = net.createServer((s) => s.end());
srv.once("error", () => process.exit(0));
srv.listen("\\\\\\\\.\\\\pipe\\\\doombar-" + hash, () => {
  appendFileSync(log, "bound " + process.pid + "\\n");
  if (process.env.FAKE_MODE === "stale") beat(Date.now() - 60000);
  else { beat(Date.now()); setInterval(() => beat(Date.now()), 100); }
});
setTimeout(() => process.exit(0), 60000);
`;

// A node process that runs a file named daemon.js, but not this installation's: it records its
// own pid and start the way a daemon heartbeat would, then sleeps.
const OTHER_DAEMON = `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, start: Math.round(performance.timeOrigin) }));
setTimeout(() => {}, 60000);
`;

let copies = 0;
function copyPackage({ fake = true } = {}) {
  const dir = path.join(SB, `pkg-${++copies}`);
  mkdirSync(dir);
  cpSync(path.join(ROOT, "src"), path.join(dir, "src"), { recursive: true });
  cpSync(path.join(ROOT, "presets"), path.join(dir, "presets"), { recursive: true });
  cpSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  symlinkSync(path.join(ROOT, "assets"), path.join(dir, "assets"), "junction");
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
  if (fake) writeFileSync(path.join(dir, "src", "daemon.js"), FAKE_DAEMON);
  const tmp = path.join(SB, `tmp-${copies}`);
  mkdirSync(tmp);
  const hash = rootHash(dir);
  const inTmp = (p) => path.join(tmp, path.basename(p));
  return {
    dir, tmp, hash,
    heartbeat: inTmp(daemonPaths(hash).heartbeat),
    claim: inTmp(daemonPaths(hash).claim),
    payload: inTmp(sessionPaths(SID, hash).payload),
    log: path.join(tmp, "fake-daemon.log"),
  };
}

const baseEnv = (pkg) => ({
  ...process.env, TEMP: pkg.tmp, TMP: pkg.tmp, TMPDIR: pkg.tmp, MUGSHOT_STATE: "",
  DOOMBAR_MSYS_REAP: "0", DOOMBAR_JOURNAL_TTL: "off", DOOMBAR_DAEMON_IDLE_MS: "20000",
  DOOMBAR_DAEMON_THROTTLE_MS: String(THROTTLE), DOOMBAR_DAEMON_GRACE_MS: String(GRACE),
  FAKE_MODE: "", FAKE_VERSION: "",
});
delete process.env.MUGSHOT_STATE;

// One hook process from the copy. Resolves with its exit code and stderr.
function runHook(pkg, name = "PostToolUse", env = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(pkg.dir, "src", "hook.js")],
      { env: { ...baseEnv(pkg), ...env }, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let err = "";
    c.stderr.on("data", (d) => { err += d; });
    c.on("exit", (code) => resolve({ code, err }));
    c.stdin.end(JSON.stringify({ hook_event_name: name, session_id: SID, tool_name: "Read", cwd: SB }));
  });
}

const children = [];
function startProcess(args, env) {
  const c = spawn(process.execPath, args, { env, stdio: "ignore", windowsHide: true });
  c.exited = new Promise((r) => c.on("exit", (code) => r(code)));
  children.push(c);
  return c;
}
const startFake = (pkg, env = {}) => startProcess([path.join(pkg.dir, "src", "daemon.js")], { ...baseEnv(pkg), ...env });

const lines = (pkg, kind) => { try { return readFileSync(pkg.log, "utf8").split("\n").filter((l) => l.startsWith(kind + " ")); } catch { return []; } };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (cond, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (cond()) return true;
  return cond();
};
const exitWithin = (c, ms) => Promise.race([c.exited, sleep(ms).then(() => "timeout")]);
const writePayload = (pkg) => writeFileSync(pkg.payload, "doombar-env\tCOLUMNS=120\n" + JSON.stringify({ session_id: SID }));

// Every node process whose command line points into the sandbox: the daemons and helpers here.
function sandboxProcesses() {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and " +
    "$_.CommandLine.ToLower().Contains($env:DOOMBAR_TEST_SB) } | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }"],
  { encoding: "utf8", timeout: 15000, windowsHide: true, env: { ...process.env, DOOMBAR_TEST_SB: SB.toLowerCase() } });
  return String(r.stdout || "").split(/\r?\n/).map((l) => /^(\d+)\|(.*)$/.exec(l.trim())).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] }));
}

try {
  // ---- The claim, in-process (every platform) ------------------------------------------------
  {
    const dir = path.join(SB, "claims");
    mkdirSync(dir);
    const f = path.join(dir, "x.claim");
    const now = Date.now();
    ok(claimRestart(f, now, 15000) === true, "with no claim file the restart is claimed");
    ok(readJson(f)?.claimedAt === now, "the claim records when it was taken");
    ok(claimRestart(f, now + 1000, 15000) === false, "a fresh claim blocks a second restart");
    writeFileSync(f, JSON.stringify({ claimedAt: now - 20000 }));
    ok(claimRestart(f, now, 15000) === true && readJson(f)?.claimedAt === now,
      "a claim older than the throttle window is taken over and replaced");
    writeFileSync(f, JSON.stringify({ claimedAt: 0, suspectSince: now - 5000 }));
    ok(claimRestart(f, now, 15000) === true && readJson(f)?.suspectSince === undefined,
      "a claim file holding only a sighting is free, and the restart replaces the sighting");
    ok(!existsSync(f + ".lock"), "no lock file is left behind");

    // A lock left by a hook that died: the next call removes it without entering, the one after
    // claims. A free claim (older than the window) makes the lock the only thing that can refuse.
    const lock = f + ".lock";
    writeFileSync(f, JSON.stringify({ claimedAt: now - 20000 }));
    writeFileSync(lock, "");
    const past = new Date(Date.now() - 10000);
    utimesSync(lock, past, past);
    ok(claimRestart(f, now, 15000) === false && !existsSync(lock),
      "a lock older than its stale limit refuses this call and is removed");
    ok(claimRestart(f, now, 15000) === true && readJson(f)?.claimedAt === now, "the next call claims the restart");
    writeFileSync(f, JSON.stringify({ claimedAt: now - 20000 }));
    writeFileSync(lock, "");
    ok(claimRestart(f, now, 15000) === false && existsSync(lock), "a fresh lock refuses the call and is left in place");
    rmSync(lock);
  }

  if (process.platform !== "win32") {
    console.log("  skip real-process cases: the daemon and its pipe exist on Windows only");
  } else {
    // A session this installation's client does not serve (no payload) starts nothing: SessionStart
    // gives up once its wait for the payload is over, other events do not wait at all.
    {
      const pkg = copyPackage();
      const t0 = Date.now();
      const r = await runHook(pkg, "SessionStart", { DOOMBAR_PAYLOAD_WAIT_MS: "600" });
      const waited = Date.now() - t0;
      const p = await runHook(pkg, "PostToolUse");
      await sleep(800);
      ok(r.code === 0 && p.code === 0 && lines(pkg, "spawn").length === 0,
        `without this session's payload for this installation the hook starts no daemon ${r.err}${p.err}`);
      ok(waited >= 600, `SessionStart waits for the payload before giving up (${waited} ms)`);
    }

    // The morning start: SessionStart runs before the client's first tick has written the payload.
    // The hook waits for it and starts the daemon then, without a tool call or Stop.
    {
      const pkg = copyPackage();
      const hook = runHook(pkg, "SessionStart", { DOOMBAR_PAYLOAD_WAIT_MS: "5000" });
      await sleep(700);
      writePayload(pkg);
      const r = await hook;
      ok(await waitFor(() => lines(pkg, "bound").length > 0), "a payload written after SessionStart still starts the daemon");
      ok(r.code === 0 && lines(pkg, "spawn").length === 1, `SessionStart spawns exactly one daemon ${r.err}`);
    }

    // Pipe unbound, no heartbeat: SessionStart starts the real daemon and kills nothing.
    {
      const pkg = copyPackage({ fake: false });
      writePayload(pkg);
      const bystander = startProcess(["-e", "setTimeout(() => {}, 60000)"], process.env);
      const r = await runHook(pkg, "SessionStart");
      ok(r.code === 0, `the SessionStart hook exits 0 ${r.err}`);
      ok(await waitFor(() => Number.isInteger(readJson(pkg.heartbeat)?.pid), 15000), "a daemon starts and writes its heartbeat");
      const pid = readJson(pkg.heartbeat)?.pid;
      const proc = sandboxProcesses().find((p) => p.pid === pid);
      ok(proc && proc.cmd.toLowerCase().includes(path.join(pkg.dir, "src", "daemon.js").toLowerCase()),
        "the started process is this installation's src/daemon.js");
      ok(alive(bystander.pid), "nothing was killed");
    }

    // Ten concurrent hooks against a dead daemon (and an expired claim) spawn exactly one.
    {
      const pkg = copyPackage();
      writePayload(pkg);
      writeFileSync(pkg.claim, JSON.stringify({ claimedAt: Date.now() - 60000 }));
      const runs = await Promise.all(Array.from({ length: 10 }, () => runHook(pkg, "PreToolUse")));
      await waitFor(() => lines(pkg, "bound").length > 0);
      await sleep(1000);
      ok(runs.every((r) => r.code === 0), "all ten hooks exit 0");
      ok(lines(pkg, "spawn").length === 1, `exactly one daemon is spawned (got ${lines(pkg, "spawn").length})`);
    }

    // A bound pipe with a stale heartbeat (a hung daemon).
    {
      const pkg = copyPackage();
      writePayload(pkg);
      const hung = startFake(pkg, { FAKE_MODE: "stale" });
      ok(await waitFor(() => readJson(pkg.heartbeat)?.pid === hung.pid), "the hung daemon holds the pipe with a stale heartbeat");
      const r1 = await runHook(pkg);
      const sighting = readJson(pkg.claim)?.suspectSince;
      ok(r1.code === 0 && Number.isFinite(sighting), "the first hook records the sighting in the claim file");
      ok(alive(hung.pid) && lines(pkg, "spawn").length === 1, "and neither stops nor starts anything");
      const r2 = await runHook(pkg);
      ok(alive(hung.pid) && lines(pkg, "spawn").length === 1, "a hook inside the grace period does nothing");
      await sleep(GRACE + 200);
      const r3 = await runHook(pkg);
      ok(r2.code === 0 && r3.code === 0, `the later hooks exit 0 ${r3.err}`);
      ok(await exitWithin(hung, 5000) !== "timeout", "after the grace period the hung daemon is stopped");
      ok(await waitFor(() => lines(pkg, "bound").length === 2), "and a new daemon is spawned and binds the pipe");
      // "bound" is logged before the first heartbeat write, so wait for the heartbeat to change hands.
      await waitFor(() => { const h = readJson(pkg.heartbeat); return h && h.pid !== hung.pid; });
      const fresh = readJson(pkg.heartbeat);
      ok(fresh && fresh.pid !== hung.pid && alive(fresh.pid), "the new daemon serves the heartbeat");
    }

    // A stale heartbeat renewed within the grace period after the sighting: no restart.
    {
      const pkg = copyPackage();
      writePayload(pkg);
      const slept = startFake(pkg, { FAKE_MODE: "stale" });
      ok(await waitFor(() => readJson(pkg.heartbeat)?.pid === slept.pid), "the sleeping daemon's heartbeat is stale");
      await runHook(pkg);
      const sighting = readJson(pkg.claim)?.suspectSince;
      ok(Number.isFinite(sighting), "the first hook records the sighting");
      const hb = readJson(pkg.heartbeat);
      const resume = setInterval(() => writeFileSync(pkg.heartbeat, JSON.stringify({ ...hb, renewed: Date.now() })), 100);
      try {
        await sleep(GRACE + 200);
        const r = await runHook(pkg);
        await sleep(500);
        ok(r.code === 0 && alive(slept.pid), "a daemon that renewed after the sighting is left alone");
        ok(lines(pkg, "spawn").length === 1, "and no new daemon is spawned");
      } finally { clearInterval(resume); }
    }

    // An outdated daemon that keeps renewing is replaced once the grace period has passed.
    {
      const pkg = copyPackage();
      writePayload(pkg);
      const old = startFake(pkg, { FAKE_VERSION: "0.0.0-old" });
      ok(await waitFor(() => readJson(pkg.heartbeat)?.version === "0.0.0-old"), "the outdated daemon renews its heartbeat");
      await runHook(pkg);
      ok(Number.isFinite(readJson(pkg.claim)?.suspectSince) && alive(old.pid), "the first hook only records the sighting");
      await sleep(GRACE + 200);
      const r = await runHook(pkg);
      ok(r.code === 0 && await exitWithin(old, 5000) !== "timeout", "the next hook after the grace period stops it");
      ok(await waitFor(() => readJson(pkg.heartbeat)?.version === VERSION), "and the replacement reports the installed version");
    }

    // A heartbeat left from before a reboot names a pid that now belongs to an unrelated process.
    {
      const pkg = copyPackage();
      writePayload(pkg);
      const stranger = startProcess(["-e", "setTimeout(() => {}, 60000)"], process.env);
      await sleep(300);
      writeFileSync(pkg.heartbeat, JSON.stringify({ pid: stranger.pid, start: Date.now() - 300, version: VERSION,
        window: 1, renewed: Date.now() - 3600e3, renameFailures: 0 }));
      const r = await runHook(pkg);
      ok(r.code === 0 && await waitFor(() => lines(pkg, "bound").length === 1), "with the pipe unbound the hook only spawns");
      ok(alive(stranger.pid), "the unrelated process named by the old heartbeat is not killed");
    }

    // A heartbeat pid that is alive and runs a daemon.js, but not this installation's.
    {
      const pkg = copyPackage();
      writePayload(pkg);
      const holder = startFake(pkg, { FAKE_MODE: "stale" });
      ok(await waitFor(() => readJson(pkg.heartbeat)?.pid === holder.pid), "a daemon holds the pipe");
      const otherDir = path.join(SB, "other", "src");
      mkdirSync(otherDir, { recursive: true });
      writeFileSync(path.join(otherDir, "daemon.js"), OTHER_DAEMON);
      const info = path.join(SB, "other", "info.json");
      const other = startProcess([path.join(otherDir, "daemon.js"), info], process.env);
      ok(await waitFor(() => readJson(info)?.pid === other.pid), "another installation's daemon.js runs");
      const { start } = readJson(info);
      writeFileSync(pkg.heartbeat, JSON.stringify({ pid: other.pid, start, version: VERSION, window: 1,
        renewed: Date.now() - 60000, renameFailures: 0 }));
      await runHook(pkg);
      await sleep(GRACE + 200);
      const r = await runHook(pkg);
      await sleep(500);
      ok(r.code === 0 && alive(other.pid), "a pid that is not this installation's daemon.js is not killed");
      ok(alive(holder.pid), "and nothing else is killed either");
    }

    // The right pid and command line, but a start time that does not match the process: the pid
    // was reused after the heartbeat was written, so it is not killed.
    {
      const pkg = copyPackage();
      writePayload(pkg);
      const daemon = startFake(pkg, { FAKE_MODE: "stale" });
      ok(await waitFor(() => readJson(pkg.heartbeat)?.pid === daemon.pid), "a hung daemon holds the pipe");
      const hb = readJson(pkg.heartbeat);
      writeFileSync(pkg.heartbeat, JSON.stringify({ ...hb, start: hb.start - 10000 }));
      await runHook(pkg);
      await sleep(GRACE + 200);
      const r = await runHook(pkg);
      await sleep(500);
      ok(r.code === 0 && alive(daemon.pid), "a process whose start time differs from the heartbeat's is not killed");
    }

    // A fresh claim blocks a start; once it has expired the next hook starts the daemon.
    {
      const pkg = copyPackage();
      writePayload(pkg);
      writeFileSync(pkg.claim, JSON.stringify({ claimedAt: Date.now() }));
      await runHook(pkg, "Stop", { DOOMBAR_DAEMON_THROTTLE_MS: "60000" });
      await sleep(800);
      ok(lines(pkg, "spawn").length === 0, "a fresh claim blocks the start");
      writeFileSync(pkg.claim, JSON.stringify({ claimedAt: Date.now() - 120000 }));
      await runHook(pkg, "Stop", { DOOMBAR_DAEMON_THROTTLE_MS: "60000" });
      ok(await waitFor(() => lines(pkg, "bound").length === 1), "an expired claim is taken over and the daemon starts");
    }

    // A restart path that throws: the claim path is a directory, so replacing the claim fails.
    {
      const pkg = copyPackage();
      writePayload(pkg);
      mkdirSync(pkg.claim);
      const old = new Date(Date.now() - 3600e3);
      utimesSync(pkg.claim, old, old);
      const r = await runHook(pkg, "Stop");
      await sleep(800);
      ok(r.code === 0 && r.err === "", `a hook whose restart path throws still exits 0 quietly (code ${r.code}) ${r.err}`);
      ok(lines(pkg, "spawn").length === 0, "and starts nothing");
    }
  }
} finally {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill();
  if (process.platform === "win32") {
    // Daemons started by a hook are detached: no handle here, so find them by command line.
    for (const p of sandboxProcesses()) spawnSync("taskkill", ["/F", "/PID", String(p.pid)], { windowsHide: true });
    await sleep(500);
    const left = sandboxProcesses();
    ok(left.length === 0, `no daemon or helper process is left running (${left.map((p) => p.pid).join(",")})`);
  }
  for (let i = 0; i < 20; i++) {
    try { rmSync(SB, { recursive: true, force: true }); break; } catch { await sleep(250); }
  }
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
