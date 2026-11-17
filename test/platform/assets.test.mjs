#!/usr/bin/env node
// The asset store (src/platform/assets.js): a game's assets resolve from the repository's folder in
// a checkout, else from the installed pinned version of the game's npm package. A package that is
// missing is installed in the background, through npm with constant arguments in a fresh directory
// inside the store, checked against the pinned integrity and only then renamed into place. Each
// render records which packages its skin chain uses, and `install` removes the ones nothing used for
// 30 days. npm is the stand-in (test/_npm-stub.mjs): nothing here reaches a registry.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPRITE = path.join(ROOT, "games", "doom", "assets", "images", "mugshot", "STFST01.png");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60 * 1000, DAY = 24 * 3600 * 1000;
const integrity = (s) => `sha512-${createHash("sha512").update(s).digest("base64")}`;
const GOOD = integrity("fixgame");

const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-assets-"));
const LOG = path.join(SB, "npm.log");
const PACKAGES = path.join(SB, "registry");
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GAMEBAR|DOOMBAR|MUGSHOT|NPM_STUB)_/i.test(k)));
const env = { ...base, ...sandboxEnv(SB), NPM_STUB_LOG: LOG, NPM_STUB_PACKAGES: PACKAGES, NPM_STUB_INTEGRITY: GOOD,
  GAMEBAR_MSYS_REAP: "0", GAMEBAR_RATELIMITS_SHARE: "0", COLUMNS: "120",
  GAMEBAR_THEME_FILE: path.join(SB, "theme.json"), GAMEBAR_STATE: path.join(SB, "state.json") };
// Before the imports: modules that read the environment when loaded see the sandbox.
Object.assign(process.env, env);

const assets = { ...(await import("../../src/platform/assets.js")), ...(await import("../../src/skin-assets.js")) };
const { GAMES, readGame } = await import("../../src/games/index.js");
const { renderSession } = await import("../../src/render.js");

const STORE = path.join(env.GAMEBAR_USER_DIR, "assets");
const npmCalls = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const installs = () => npmCalls().filter((c) => c.args[0] === "install");
const storeNames = () => (existsSync(STORE) ? readdirSync(STORE).sort() : []);
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

// A game folder with a manifest pinning `version` and `pin`, read as the registry reads it.
function gameFolder(name, version, pin, folder = name) {
  const dir = path.join(SB, "games", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "game.toml"), [`name = "${name}"`, `description = "a test game"`, `default_skin = "${name}-none"`,
    "[assets]", `package = "@claude-game-bar/${name}"`, `version = "${version}"`, `integrity = "${pin}"`, ""].join("\n"));
  return readGame(dir);
}
// A version of a game's package in the stand-in registry: a package.json and one image.
function publish(name, version) {
  const dir = path.join(PACKAGES, "@claude-game-bar", `${name}@${version}`);
  mkdirSync(path.join(dir, "images"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@claude-game-bar/${name}`, version }));
  copyFileSync(SPRITE, path.join(dir, "images", "face.png"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "pick.js"), "function render(input) { return { frame: \"face\" }; }\n");
}
// A user skin: one animation whose default frame is `frame`, and optionally a smaller skin.
function userSkin(name, frame, smaller = null) {
  const dir = path.join(env.GAMEBAR_USER_DIR, "skins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.toml`), [`version = 1`, `root = "bar"`, ...(smaller ? [`smaller = "${smaller}"`] : []), "",
    "[element.bar]", `kind = "row"`, `children = ["face"]`, "",
    "[element.face]", `kind = "animation"`, `default_frame = "${frame}"`, "width = 9", "rows = 4", ""].join("\n"));
}

const children = [];
try {
  for (const [n, v] of [["fixgame", "1.0.0"], ["fixgame", "2.0.0"], ["fixgame", "3.0.0"], ["fixgame", "4.0.0"], ["fixgame", "5.0.0"],
    ["fixgame", "6.0.0"], ["fixgame", "7.0.0"], ["fixother", "1.0.0"], ["fixsmall", "1.0.0"], ["fixlive", "1.0.0"]]) publish(n, v);

  console.log("a placeholder pin is no package:");
  {
    const placeholder = gameFolder("fixplace", "0.0.0", "");
    ok(assets.pinOf(placeholder) === null, "version 0.0.0 with an empty integrity pins nothing");
    ok(assets.pinOf(gameFolder("fixplace2", "1.0.0", "", "fixplace2")) === null, "an empty integrity pins nothing");
    ok(assets.pinOf(gameFolder("fixplace3", "0.0.0", GOOD, "fixplace3")) === null, "version 0.0.0 pins nothing");
    let started = 0;
    const r = assets.createAssetResolver({ env, now: Date.now(), lookup: () => placeholder, install: () => { started++; } });
    ok(r.resolve("fixplace:images/face.png") === null, "its assets resolve to nothing");
    ok(started === 0 && r.warnings().length === 0, "no install starts and no warning shows");
    ok(r.packages().length === 0, "and no package is recorded as used");
    const res = await assets.installAssets(placeholder, { env });
    ok(res.status === "unpinned" && installs().length === 0 && !existsSync(STORE), `installing it does nothing (${res.status})`);
  }

  console.log("the checkout's folder comes first:");
  {
    const game = gameFolder("fixgame", "1.0.0", GOOD);
    const checkout = path.join(SB, "checkout");
    mkdirSync(path.join(checkout, "fixgame", "assets", "images"), { recursive: true });
    copyFileSync(SPRITE, path.join(checkout, "fixgame", "assets", "images", "face.png"));
    let started = 0;
    const r = assets.createAssetResolver({ env, now: Date.now(), gamesRoot: checkout, lookup: () => game, install: () => { started++; } });
    ok(r.resolve("fixgame:images/face.png") === path.join(checkout, "fixgame", "assets", "images", "face.png"),
      "a game with its folder in the checkout resolves there");
    ok(r.resolve("fixgame:../../outside.png") === null && r.resolve("fixgame:images/none.png") === null,
      "a path out of the game's folder, or one that is not there, resolves to nothing");
    ok(started === 0 && r.warnings().length === 0, "nothing is installed for it");
  }

  console.log("an install: constant npm arguments in a fresh folder inside the store:");
  {
    const game = gameFolder("fixgame", "1.0.0", GOOD);
    const res = await assets.installAssets(game, { env });
    ok(res.status === "installed", `the pinned version installs (${JSON.stringify(res)})`);
    const calls = installs();
    ok(calls.length === 1, `npm ran once (${calls.length})`);
    const call = calls[0] || { args: [], cwd: "", pkg: "{}" };
    ok(JSON.stringify(call.args) === JSON.stringify(["install", "--ignore-scripts", "--no-audit", "--no-fund"]),
      `npm's arguments are exactly install --ignore-scripts --no-audit --no-fund (${JSON.stringify(call.args)})`);
    ok(realpathSync(path.dirname(call.cwd || ".")) === realpathSync(STORE) && path.basename(call.cwd).startsWith(".tmp-"),
      `its working directory is a temporary folder inside the store (${call.cwd})`);
    const deps = JSON.parse(call.pkg || "{}").dependencies || {};
    ok(JSON.stringify(deps) === JSON.stringify({ "@claude-game-bar/fixgame": "1.0.0" }),
      `that folder's package.json depends on the pinned package only (${JSON.stringify(deps)})`);
    const face = path.join(STORE, "fixgame@1.0.0", "node_modules", "@claude-game-bar", "fixgame", "images", "face.png");
    ok(existsSync(face), "the result is the store's fixgame@1.0.0");
    ok(storeNames().every((n) => !n.startsWith(".tmp-")) && !existsSync(path.join(STORE, "install.lock")),
      `no temporary folder and no lock are left (${storeNames().join(", ")})`);
    const r = assets.createAssetResolver({ env, now: Date.now(), gamesRoot: path.join(SB, "no-checkout"), lookup: () => game, install: () => {} });
    ok(r.resolve("fixgame:images/face.png") === face && r.warnings().length === 0, "a reference to it resolves into the store");
    ok(JSON.stringify(r.packages()) === JSON.stringify(["fixgame@1.0.0"]), "and the package is recorded as used");
    const again = await assets.installAssets(game, { env });
    ok(again.status === "present" && installs().length === 1, "an installed version is not installed again");
  }

  console.log("two installations pinning two versions:");
  {
    const one = gameFolder("fixgame", "1.0.0", GOOD);
    const two = gameFolder("fixgame", "2.0.0", GOOD, "fixgame-two");
    const res = await assets.installAssets(two, { env });
    ok(res.status === "installed", "the other version installs beside the first");
    ok(existsSync(path.join(STORE, "fixgame@1.0.0")) && existsSync(path.join(STORE, "fixgame@2.0.0")), "neither replaces the other");
    const at = (game) => assets.createAssetResolver({ env, now: Date.now(), gamesRoot: path.join(SB, "no-checkout"), lookup: () => game, install: () => {} })
      .resolve("fixgame:images/face.png") || "";
    ok(at(one).includes(`${path.sep}fixgame@1.0.0${path.sep}`) && at(two).includes(`${path.sep}fixgame@2.0.0${path.sep}`),
      "each resolves its own version");
  }

  console.log("an integrity that is not the pinned one:");
  {
    const game = gameFolder("fixgame", "3.0.0", integrity("something else"), "fixgame-three");
    const before = Date.now();
    const res = await assets.installAssets(game, { env, now: before });
    ok(res.status === "failed", `the install fails (${JSON.stringify(res)})`);
    ok(!existsSync(path.join(STORE, "fixgame@3.0.0")) && storeNames().every((n) => !n.startsWith(".tmp-")),
      `nothing reaches the store (${storeNames().join(", ")})`);
    ok(existsSync(path.join(STORE, "fixgame@3.0.0.retry")), "a retry-after marker is written");
    let started = 0;
    const r = assets.createAssetResolver({ env, now: before + MIN, gamesRoot: path.join(SB, "no-checkout"), lookup: () => game, install: () => { started++; } });
    ok(r.resolve("fixgame:images/face.png") === null, "its assets resolve to nothing");
    const w = r.warnings();
    ok(w.length === 1 && w[0].message.includes("@claude-game-bar/fixgame@3.0.0") && /fail/.test(w[0].message) && w[0].key,
      `one warning names the package and that it failed (${JSON.stringify(w.map((x) => x.message))})`);
    ok(started === 0, "and no install starts while the marker is fresh");
  }

  console.log("a failed install is retried after 10 minutes, not before:");
  {
    const game = gameFolder("fixgame", "4.0.0", GOOD, "fixgame-four");
    const t0 = Date.now();
    const res = await assets.installAssets(game, { env: { ...env, NPM_STUB_FAIL: "1" }, now: t0 });
    ok(res.status === "failed" && existsSync(path.join(STORE, "fixgame@4.0.0.retry")), "a failed npm writes a retry-after marker");
    const startsAt = (now) => {
      let started = 0;
      assets.createAssetResolver({ env, now, gamesRoot: path.join(SB, "no-checkout"), lookup: () => game, install: () => { started++; } })
        .resolve("fixgame:images/face.png");
      return started;
    };
    ok(startsAt(t0 + 9 * MIN) === 0, "a render 9 minutes later starts no install");
    ok(startsAt(t0 + 11 * MIN) === 1, "one 11 minutes later does");
    ok(assets.startInstall(game, { env, now: t0 + 9 * MIN }) === "retry", "the background start itself also waits out the marker");
    const later = await assets.installAssets(game, { env, now: t0 + 11 * MIN });
    ok(later.status === "installed" && !existsSync(path.join(STORE, "fixgame@4.0.0.retry")), "the retry installs and clears the marker");
  }

  console.log("the install lock:");
  {
    const lock = path.join(STORE, "install.lock");
    const game = gameFolder("fixgame", "5.0.0", GOOD, "fixgame-five");
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), time: Date.now() }));
    const taken = await assets.installAssets(game, { env });
    ok(taken.status === "installed", `a lock whose process is gone is taken over (${taken.status})`);

    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(sleeper);
    const six = gameFolder("fixgame", "6.0.0", GOOD, "fixgame-six");
    const n = installs().length;
    writeFileSync(lock, JSON.stringify({ pid: sleeper.pid, time: Date.now() - 9 * MIN }));
    const held = await assets.installAssets(six, { env });
    ok(held.status === "locked" && installs().length === n && !existsSync(path.join(STORE, "fixgame@6.0.0")),
      `a live lock younger than 10 minutes is respected (${held.status})`);
    ok(JSON.parse(readFileSync(lock, "utf8")).pid === sleeper.pid, "and left as it was");
    writeFileSync(lock, JSON.stringify({ pid: sleeper.pid, time: Date.now() - 11 * MIN }));
    const old = await assets.installAssets(six, { env });
    ok(old.status === "installed", `a lock older than 10 minutes is taken over even while its process lives (${old.status})`);
    rmSync(lock, { force: true });
  }

  console.log("references name a game, never a package:");
  {
    const game = gameFolder("fixgame", "1.0.0", GOOD);
    let started = 0;
    const lookup = (name) => (name === "fixgame" ? game : null);
    const r = assets.createAssetResolver({ env, now: Date.now(), gamesRoot: path.join(SB, "no-checkout"), lookup, install: () => { started++; } });
    ok(r.resolve("@evil/pkg:images/face.png") === null, "a reference naming a package resolves to nothing");
    r.need("@evil/pkg");
    ok(r.resolve("nosuchgame:images/face.png") === null, "a reference to a game that does not exist resolves to nothing");
    const w = r.warnings();
    ok(w.some((x) => x.cause === "asset-package" && x.message.includes("@evil/pkg")), `a warning names the package reference (${JSON.stringify(w.map((x) => x.message))})`);
    ok(w.filter((x) => x.cause === "asset-package").length === 1, "one warning for that reference, however often it is met");
    ok(w.some((x) => x.cause === "unknown-game" && x.message.includes("nosuchgame")), "a warning names the unknown game");
    ok(started === 0, "neither starts an install");
  }

  console.log("a skin whose package is missing (renders):");
  {
    const game = gameFolder("fixlive", "1.0.0", GOOD);
    GAMES.push(game);
    mkdirSync(path.join(STORE, "fixother@1.0.0"), { recursive: true }); // what an earlier skin installed
    userSkin("fixskin", "fixlive:images/face.png");
    const renderEnv = { ...env, GAMEBAR_SKIN: "fixskin", NPM_STUB_DELAY_MS: "3000" };
    const data = { session_id: "assets", model: { display_name: "Opus 5.5" } };
    const n = installs().length;
    const t = performance.now();
    const first = renderSession({ data, env: renderEnv }).map(strip);
    const took = performance.now() - t;
    ok(took < 2000, `the render returns at once (${Math.round(took)} ms) while npm takes 3 s`);
    ok(first.slice(0, 4).every((l) => !/\S/.test(l)), `the animation draws its default, a blank (${JSON.stringify(first)})`);
    const warned = first.filter((l) => l.startsWith("gamebar: "));
    ok(warned.length === 1 && warned[0].includes("@claude-game-bar/fixlive@1.0.0"), `one warning line names the package (${JSON.stringify(warned)})`);
    const lock = path.join(STORE, "install.lock");
    let child = null;
    try { child = JSON.parse(readFileSync(lock, "utf8")).pid; } catch { /* no lock */ }
    ok(Number.isInteger(child) && child !== process.pid, `a background install holds the lock (${child})`);
    renderSession({ data, env: renderEnv });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && (!existsSync(path.join(STORE, "fixlive@1.0.0")) || existsSync(lock))) await sleep(100);
    ok(existsSync(path.join(STORE, "fixlive@1.0.0")), "the background install finishes");
    ok(installs().length === n + 1, `npm ran once for both renders (${installs().length - n})`);
    const after = renderSession({ data, env: renderEnv }).map(strip);
    ok(after.slice(0, 4).some((l) => /\S/.test(l)), `once installed the skin's own look appears (${JSON.stringify(after)})`);
    ok(existsSync(path.join(STORE, "fixother@1.0.0")), "a package an earlier skin used stays");
    // A skin whose frames folder and selection script both come from the game: no default frame,
    // so a drawn face proves the script was found in the store, ran, and its frame was found there.
    const sdir = path.join(env.GAMEBAR_USER_DIR, "skins", "fixscript");
    mkdirSync(sdir, { recursive: true });
    writeFileSync(path.join(sdir, "fixscript.toml"), [`version = 1`, `root = "bar"`, "", "[element.bar]", `kind = "row"`, `children = ["face"]`, "",
      "[element.face]", `kind = "animation"`, `frames = "fixlive:images"`, `script = "fixlive:scripts/pick.js"`, "width = 9", "rows = 4", ""].join("\n"));
    const scripted = renderSession({ data, env: { ...renderEnv, GAMEBAR_SKIN: "fixscript" } }).map(strip);
    ok(scripted.slice(0, 4).some((l) => /\S/.test(l)) && !scripted.some((l) => l.startsWith("gamebar: ")),
      `a game: script reference and a game: frames folder resolve through the store (${JSON.stringify(scripted)})`);
    const usage = readdirSync(env.GAMEBAR_USER_DIR).filter((f) => /^usage-[0-9a-f]+\.json$/.test(f));
    const entry = usage.length === 1 ? JSON.parse(readFileSync(path.join(env.GAMEBAR_USER_DIR, usage[0]), "utf8")).skins?.fixskin : null;
    ok(entry && JSON.stringify(entry.packages) === JSON.stringify(["fixlive@1.0.0"]),
      `the installation's usage file records the skin with its packages (${JSON.stringify(entry)})`);
    if (Number.isInteger(child)) { try { process.kill(child); } catch { /* gone */ } }
  }

  console.log("the usage record:");
  {
    const hash = "aaaaaaaaaa";
    const file = path.join(env.GAMEBAR_USER_DIR, `usage-${hash}.json`);
    const t0 = Date.now();
    ok(assets.recordUsage("one", ["fixgame@1.0.0"], { env, now: t0, hash }) === true && existsSync(file), "a render records its skin");
    ok(assets.recordUsage("one", ["fixgame@1.0.0"], { env, now: t0 + 30 * 1000, hash }) === false, "half a minute later it is not written again");
    ok(assets.recordUsage("one", ["fixgame@1.0.0"], { env, now: t0 + 61 * 1000, hash }) === true, "a minute later it is");
    ok(assets.recordUsage("none", [], { env, now: t0, hash }) === false, "a skin that uses no package records nothing");
    rmSync(file, { force: true });
  }

  console.log("removing what no skin in use references:");
  {
    for (const n of ["fixgame@1.0.0", "fixother@1.0.0", "fixsmall@1.0.0"]) mkdirSync(path.join(STORE, n), { recursive: true });
    const now = Date.now();
    writeFileSync(path.join(env.GAMEBAR_USER_DIR, "usage-bbbbbbbbbb.json"), JSON.stringify({ skins: {
      doom: { time: now - 31 * DAY, packages: ["fixgame@1.0.0"] },
      minecraft: { time: now - 29 * DAY, packages: ["fixother@1.0.0"] },
    } }));
    const deadTmp = path.join(STORE, `.tmp-${deadPid()}-abc`), liveTmp = path.join(STORE, `.tmp-${process.pid}-abc`);
    for (const d of [deadTmp, liveTmp]) mkdirSync(d, { recursive: true });
    const res = assets.removeUnused({ env, now, keep: ["fixsmall@1.0.0"] });
    ok(!existsSync(path.join(STORE, "fixgame@1.0.0")), "a package whose skin was last drawn 31 days ago is removed");
    ok(existsSync(path.join(STORE, "fixother@1.0.0")), "one drawn 29 days ago stays");
    ok(existsSync(path.join(STORE, "fixsmall@1.0.0")), "one the saved skin's chain names stays");
    ok(!existsSync(deadTmp) && existsSync(liveTmp), "a temporary folder of a process that is gone goes, one of a live process stays");
    ok(res.removed.includes("fixgame@1.0.0"), `the removal says what it removed (${JSON.stringify(res.removed)})`);
    rmSync(liveTmp, { recursive: true, force: true });
    rmSync(path.join(env.GAMEBAR_USER_DIR, "usage-bbbbbbbbbb.json"), { force: true });
  }

  console.log("a fresh store ends with the chosen chain's packages and nothing else:");
  {
    rmSync(STORE, { recursive: true, force: true });
    for (const f of readdirSync(env.GAMEBAR_USER_DIR).filter((x) => x.startsWith("usage-"))) rmSync(path.join(env.GAMEBAR_USER_DIR, f));
    GAMES.push(gameFolder("fixsmall", "1.0.0", GOOD), gameFolder("fixgame", "7.0.0", GOOD, "fixgame-seven"));
    userSkin("chainsmall", "fixsmall:images/face.png");
    userSkin("chainbig", "fixgame:images/face.png", "chainsmall");
    mkdirSync(path.join(STORE, "fixother@1.0.0"), { recursive: true });
    const lines = await assets.installSkinAssets("chainbig", { env });
    ok(lines.length === 2, `the chain's two packages are installed in the foreground (${JSON.stringify(lines)})`);
    assets.removeUnused({ env, keep: assets.skinPackages("chainbig", env) });
    ok(JSON.stringify(storeNames()) === JSON.stringify(["fixgame@7.0.0", "fixsmall@1.0.0"]), `the store holds exactly those (${storeNames().join(", ")})`);
  }
} finally {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  await sleep(200);
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
