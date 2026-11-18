// The asset store: where a game's assets (images, scripts, conversation libraries) are found, how a
// missing one gets installed, and when an installed one goes.
//
// A skin names an asset as `<game>:<path>`; a path without a game is the skin's own, inside its
// folder. A game's assets are found:
//   1. in a checkout of the repository, in its packages/<game>/ folder;
//   2. else in the store, as the one version of the game's npm package its manifest pins:
//      <user dir>/assets/<game>@<version>/node_modules/@claude-game-bar/<game>/
// Two installations of the bar pinning two versions each use their own; neither touches the other's.
//
// A manifest pins its package by exact version and npm integrity (sha512). A manifest whose version
// is 0.0.0 or whose integrity is not a sha512 one pins nothing: the package is not published yet, so
// that game's assets come from the checkout only, nothing is installed and nothing is reported.
//
// A pinned package that is missing is installed in the background (startInstall: a detached
// `node src/hook.js --assets <game folder>`), while the element that needs it draws its default and
// the bar names the package in a warning. The install (installAssets):
//   - runs under <store>/install.lock, which names its process and the time it was taken; it is
//     stale when that process is gone or after 10 minutes, since an install can take a while;
//   - makes a fresh folder inside the store (so the final rename never crosses a filesystem), writes
//     a package.json there whose only dependency is the pinned package, and runs npm in it with the
//     constant arguments `install --ignore-scripts --no-audit --no-fund`: nothing a skin or a manifest
//     says reaches npm's command line, and no package script runs;
//   - compares the integrity npm recorded (node_modules/.package-lock.json) with the pin, and only
//     then renames the folder to <game>@<version>, never over one that exists. Anything else
//     discards the folder, so a version in the store is always a whole, checked one.

import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT, SRC_DIR } from "../package-root.js";
import { rootHash, writeAtomic, userDir } from "./runtime.js";
import { findGame, readGame } from "../games/index.js";
import { makeWarning } from "../kit/warning.js";

export const RETRY_MS = 10 * 60 * 1000;
export const LOCK_STALE_MS = 10 * 60 * 1000;
export const USAGE_KEEP_MS = 30 * 24 * 3600 * 1000;
export const USAGE_EVERY_MS = 60 * 1000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
export const NPM_ARGS = Object.freeze(["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
export const ASSET_SCOPE = "@claude-game-bar/";

const LOCK_FILE = "install.lock";
const TMP_PREFIX = ".tmp-";
const TMP_DIR = /^\.tmp-(\d+)-/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION_DIR = /^[A-Za-z0-9][A-Za-z0-9_-]*@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const GAME_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// A game asset reference: a game's name, a colon, a path. A drive letter is not a game's name.
const REF_GAME = "[A-Za-z0-9][A-Za-z0-9_-]+";
const GAME_REF = new RegExp(`^(${REF_GAME}):(.*)$`);
// What every game asset reference starts with.
export const GAME_PREFIX = new RegExp(`^${REF_GAME}:`);

export const assetsDir = (env = process.env) => path.join(userDir(env), "assets");
// Where a checkout keeps each game's asset package; an installed package has no such folder.
export const CHECKOUT_PACKAGES = path.join(PACKAGE_ROOT, "packages");

// The package a game's manifest pins: { game, package, version, integrity, key }, key being the
// store folder's name <game>@<version>. Null when the manifest pins nothing usable: a placeholder
// (version 0.0.0, or an integrity that is not sha512), or a package outside the project's scope.
export function pinOf(game) {
  const a = game && game.assets;
  if (!a || !GAME_NAME.test(game.name || "")) return null;
  const { package: pkg, version, integrity } = a;
  if (pkg !== `${ASSET_SCOPE}${game.name}`) return null;
  if (typeof version !== "string" || !VERSION.test(version) || version === "0.0.0") return null;
  if (typeof integrity !== "string" || !INTEGRITY.test(integrity)) return null;
  return { game: game.name, package: pkg, version, integrity, key: `${game.name}@${version}` };
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const packageIn = (folder, pkg) => path.join(folder, "node_modules", ...pkg.split("/"));

// The checkout's folders of assets by game name, for this process: a checkout's folders do not
// come or go while the bar runs.
const checkoutRoots = new Map();

export function checkoutRoot(game, packagesRoot = CHECKOUT_PACKAGES) {
  if (!game || !GAME_NAME.test(game.name || "")) return null;
  const own = packagesRoot === CHECKOUT_PACKAGES;
  if (own && checkoutRoots.has(game.name)) return checkoutRoots.get(game.name);
  const dir = path.join(packagesRoot, game.name);
  const root = isDir(dir) ? dir : null;
  if (own) checkoutRoots.set(game.name, root);
  return root;
}

export function installedRoot(pin, env = process.env) {
  if (!pin) return null;
  const dir = packageIn(path.join(assetsDir(env), pin.key), pin.package);
  return isDir(dir) ? dir : null;
}

// Is `file` (an absolute path) anywhere but strictly inside `root`? `root` itself counts as outside.
export function leadsOutside(root, file) {
  const back = path.relative(root, file);
  return back === "" || back === ".." || back.startsWith(`..${path.sep}`) || path.isAbsolute(back);
}

// `rel` inside `root`, when it exists there; null for a path that leads out of it.
function inside(root, rel) {
  if (!root || typeof rel !== "string" || rel === "" || path.isAbsolute(rel)) return null;
  const file = path.resolve(root, rel);
  if (leadsOutside(root, file)) return null;
  return existsSync(file) ? file : null;
}

// What a reference names: { kind: "game", game, path }, { kind: "package", name } for a reference
// that names an npm package, or { kind: "own", path } for a path in the skin's own folder.
export function parseAssetRef(ref) {
  if (/^npm:/i.test(ref)) return { kind: "package", name: ref.slice(4).split(":")[0] };
  if (ref.startsWith("@")) return { kind: "package", name: ref.split(":")[0] };
  const m = GAME_REF.exec(ref);
  return m ? { kind: "game", game: m[1], path: m[2] } : { kind: "own", path: ref };
}

// The retry-after marker of a failed install: { until, reason } while it holds, else null.
function retryFile(pin, env) { return path.join(assetsDir(env), `${pin.key}.retry`); }
export function retryState(pin, env = process.env, now = Date.now()) {
  try {
    const m = JSON.parse(readFileSync(retryFile(pin, env), "utf8"));
    return Number.isFinite(m.until) && now < m.until ? { until: m.until, reason: String(m.reason || "") } : null;
  } catch { return null; }
}

// Is process `pid` alive? A process of another user still counts.
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function readLock(lock) {
  try { return JSON.parse(readFileSync(lock, "utf8")); } catch { /* fall through */ }
  // Unreadable: just created and not written yet, or broken. Its age decides.
  try { return { pid: null, time: statSync(lock).mtimeMs, unreadable: true }; } catch { return null; }
}

// Takes the store's lock for `pid`, or takes over a stale one. False while another holds it.
function claimLock(lock, pid, now) {
  const body = JSON.stringify({ pid, time: now });
  try { writeFileSync(lock, body, { flag: "wx" }); return true; } catch (e) { if (e.code !== "EEXIST") return false; }
  const held = readLock(lock);
  if (held) {
    const age = held.unreadable ? Date.now() - held.time : now - held.time;
    if ((held.unreadable || alive(held.pid)) && age < LOCK_STALE_MS) return false;
  }
  try { unlinkSync(lock); } catch { /* someone else took it over */ }
  try { writeFileSync(lock, body, { flag: "wx" }); return true; } catch { return false; }
}

function releaseLock(lock, pid) {
  const held = readLock(lock);
  if (held && held.pid === pid) { try { unlinkSync(lock); } catch { /* already gone */ } }
}

// A background install was handed the lock by the process that started it, which writes this
// process's pid into it right after the start. Waits a moment for that.
function lockHandedOver(lock, pid) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 100; i++) {
    const held = readLock(lock);
    if (held && held.pid === pid) return true;
    Atomics.wait(wait, 0, 0, 20);
  }
  return false;
}

// The integrity npm recorded for `pkg` installed in `folder`, with its version, or null.
function installedPin(folder, pkg) {
  try {
    const lock = JSON.parse(readFileSync(path.join(folder, "node_modules", ".package-lock.json"), "utf8"));
    const entry = (lock.packages || {})[`node_modules/${pkg}`];
    return entry ? { version: entry.version, integrity: entry.integrity } : null;
  } catch { return null; }
}

// npm installs the pin into a fresh folder of the store, which becomes <game>@<version> once
// checked. The caller holds the lock. Returns { status: "installed" | "present" | "failed", message }.
async function installPinned(pin, env, now) {
  const dir = assetsDir(env);
  const target = path.join(dir, pin.key);
  let tmp = null;
  const fail = (reason) => {
    try { writeAtomic(retryFile(pin, env), JSON.stringify({ until: now + RETRY_MS, reason })); } catch { /* the store is not writable */ }
    return { status: "failed", message: reason };
  };
  try {
    tmp = mkdtempSync(path.join(dir, `${TMP_PREFIX}${process.pid}-`));
    writeFileSync(path.join(tmp, "package.json"),
      JSON.stringify({ name: "claude-game-bar-assets", private: true, dependencies: { [pin.package]: pin.version } }, null, 2) + "\n");
    const { runNpm } = await import("../install/old-package.js");
    const r = runNpm(NPM_ARGS, { env, cwd: tmp, timeout: INSTALL_TIMEOUT_MS });
    if (r.error || r.status !== 0) return fail(r.error ? (r.error.code || r.error.message) : `npm exited ${r.status}`);
    const got = installedPin(tmp, pin.package);
    if (!got || got.integrity !== pin.integrity || got.version !== pin.version) return fail("its integrity is not the pinned one");
    if (!isDir(packageIn(tmp, pin.package))) return fail("npm installed no package folder");
    try {
      renameSync(tmp, target);
      tmp = null;
    } catch (e) {
      if (isDir(target)) return { status: "present" };
      return fail(e.code || e.message);
    }
    rmSync(retryFile(pin, env), { force: true });
    return { status: "installed" };
  } catch (e) {
    return fail(e.code || e.message);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

// Installs the version of `game`'s assets its manifest pins, unless it is there already. Returns
// { status, message? }: "installed", "present", "unpinned" (nothing pinned), "locked" (another
// install holds the store), "retry" (an earlier one failed under 10 minutes ago), "failed".
// options:
//   env          the environment (user directory, npm)
//   now          the time in ms, for the lock and the retry marker
//   handedOver   the lock was taken for this process by the one that started it (startInstall)
//   ignoreRetry  install even when an earlier attempt failed recently (an install the user asked for)
export async function installAssets(game, { env = process.env, now = Date.now(), handedOver = false, ignoreRetry = false } = {}) {
  const pin = pinOf(game);
  if (!pin) return { status: "unpinned" };
  if (installedRoot(pin, env)) return { status: "present" };
  const dir = assetsDir(env);
  try { mkdirSync(dir, { recursive: true }); } catch (e) { return { status: "failed", message: e.code || e.message }; }
  const lock = path.join(dir, LOCK_FILE);
  if (handedOver ? !lockHandedOver(lock, process.pid) : !claimLock(lock, process.pid, now)) return { status: "locked" };
  try {
    if (installedRoot(pin, env)) return { status: "present" };
    if (!ignoreRetry && retryState(pin, env, now)) return { status: "retry" };
    return await installPinned(pin, env, now);
  } finally {
    releaseLock(lock, process.pid);
  }
}

// The background install of `game`'s assets, run by `node src/hook.js --assets <game folder>`.
export async function installInBackground(gameDir, env = process.env) {
  let game;
  try { game = readGame(path.resolve(gameDir)); } catch { return { status: "failed" }; }
  return installAssets(game, { env, handedOver: true });
}

const HOOK = path.join(SRC_DIR, "hook.js");

// Starts the background install of `game`'s assets unless it is not needed or cannot run now:
// returns "unpinned", "present", "retry", "locked" (an install is running), "started", or "failed".
// The lock is taken here and handed to the started process, so two renders a moment apart never
// start two installs.
export function startInstall(game, { env = process.env, now = Date.now() } = {}) {
  const pin = pinOf(game);
  if (!pin) return "unpinned";
  if (installedRoot(pin, env)) return "present";
  if (retryState(pin, env, now)) return "retry";
  const dir = assetsDir(env);
  try { mkdirSync(dir, { recursive: true }); } catch { return "failed"; }
  const lock = path.join(dir, LOCK_FILE);
  if (!claimLock(lock, process.pid, now)) return "locked";
  try {
    const child = spawn(process.execPath, [HOOK, "--assets", game.dir], { detached: true, stdio: "ignore", windowsHide: true, env });
    if (!child.pid) throw new Error("no process");
    child.on("error", () => releaseLock(lock, child.pid));
    child.unref();
    writeAtomic(lock, JSON.stringify({ pid: child.pid, time: now }));
    return "started";
  } catch {
    releaseLock(lock, process.pid);
    return "failed";
  }
}

const warning = (cause, subject, message) => makeWarning({ key: `assets|${cause}|${subject}`, cause, subject, message });
const minutes = (ms) => Math.max(1, Math.ceil(ms / 60000));

// One render's asset lookups. options:
//   env        the session's environment
//   now        the time in ms
//   folder     the folder a skin's own references resolve in (a user skin's, a bundled skin's game's)
//   packagesRoot  where a checkout keeps each game's asset package
//   lookup     game name -> registry entry (the registry's findGame)
//   install    starts a background install (startInstall)
// Returns:
//   resolve(ref)  the file or folder a reference names, or null (the element then draws its default)
//   need(name)    the folder of game `name`'s assets, starting its install when it is missing
//   packages()    the store folders (<game>@<version>) of the pinned games met so far, sorted
//   warnings()    what the bar should say, in the warning line's form, one per package or reference
export function createAssetResolver({ env = process.env, now = Date.now(), folder = null, packagesRoot = CHECKOUT_PACKAGES,
  lookup = findGame, install = startInstall } = {}) {
  const roots = new Map(), warned = new Map(), used = new Set();
  const warn = (w) => { if (!warned.has(w.key)) warned.set(w.key, w); };

  function need(name) {
    if (roots.has(name)) return roots.get(name);
    let root = null;
    if (name.startsWith("@") || name.includes("/") || name.includes(":")) {
      warn(warning("asset-package", name, `${name}: assets are named by game (game:path), not by package; not used`));
    } else {
      const game = lookup(name);
      if (!game) warn(warning("unknown-game", name, `no game is called ${name}; its assets are not used`));
      else root = checkoutRoot(game, packagesRoot) || pinned(game);
    }
    roots.set(name, root);
    return root;
  }

  function pinned(game) {
    const pin = pinOf(game);
    if (!pin) return null;
    used.add(pin.key);
    const root = installedRoot(pin, env);
    if (root) return root;
    const id = `${pin.package}@${pin.version}`;
    const failed = retryState(pin, env, now);
    if (failed) {
      warn(warning("asset-failed", id, `assets of ${game.name} (${id}) failed to install` +
        `${failed.reason ? ` (${failed.reason})` : ""}; trying again in ${minutes(failed.until - now)} min`));
      return null;
    }
    install(game, { env, now });
    warn(warning("asset-missing", id, `assets of ${game.name} (${id}) are not installed yet; installing them in the background`));
    return null;
  }

  function resolve(ref) {
    if (typeof ref !== "string" || ref === "") return null;
    const r = parseAssetRef(ref);
    if (r.kind === "package") return need(r.name.startsWith("@") ? r.name : `npm:${r.name}`);
    if (r.kind === "own") return inside(folder, r.path);
    return inside(need(r.game), r.path);
  }

  return { resolve, need, packages: () => [...used].sort(), warnings: () => [...warned.values()] };
}

export const usageFile = (env = process.env, hash = rootHash()) => path.join(userDir(env), `usage-${hash}.json`);
const lastUsage = new Map();

const fresh = (seen, sig, now) => seen && seen.sig === sig && now >= seen.time && now - seen.time < USAGE_EVERY_MS;

// Records that `skin` was drawn now with the store folders `packages` of its chain; at most once a
// minute per skin, and nothing for a skin whose chain uses no package. Returns whether it wrote.
export function recordUsage(skin, packages, { env = process.env, now = Date.now(), hash = rootHash() } = {}) {
  try {
    const list = [...new Set(packages || [])].sort();
    if (!list.length) return false;
    const file = usageFile(env, hash);
    const sig = list.join(",");
    const memo = `${file}|${skin}`;
    if (fresh(lastUsage.get(memo), sig, now)) return false;
    let data = null;
    try { data = JSON.parse(readFileSync(file, "utf8")); } catch { /* none yet */ }
    if (!data || typeof data !== "object" || typeof data.skins !== "object" || !data.skins) data = { skins: {} };
    const cur = data.skins[skin];
    if (cur && Array.isArray(cur.packages) && fresh({ sig: cur.packages.join(","), time: cur.time }, sig, now)) {
      lastUsage.set(memo, { sig, time: cur.time });
      return false;
    }
    data.skins[skin] = { time: now, packages: list };
    mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, JSON.stringify(data));
    lastUsage.set(memo, { sig, time: now });
    return true;
  } catch { return false; }
}

// Every store folder a skin drawn within 30 days used, by any installation's record.
export function usedPackages({ env = process.env, now = Date.now() } = {}) {
  const used = new Set();
  let names = [];
  try { names = readdirSync(userDir(env)).filter((n) => /^usage-[0-9a-f]+\.json$/.test(n)); } catch { return used; }
  for (const n of names) {
    let data;
    try { data = JSON.parse(readFileSync(path.join(userDir(env), n), "utf8")); } catch { continue; }
    for (const entry of Object.values((data && data.skins) || {})) {
      if (entry && Number.isFinite(entry.time) && now - entry.time < USAGE_KEEP_MS && Array.isArray(entry.packages)) {
        for (const p of entry.packages) used.add(p);
      }
    }
  }
  return used;
}

// Removes the store's versions that neither `keep` (the saved skin's chain) nor a skin drawn
// within 30 days uses, and temporary folders whose install process is gone. Returns
// { removed: [names], skipped: reason | null }; it skips while an install holds the store.
export function removeUnused({ env = process.env, now = Date.now(), keep = [] } = {}) {
  const dir = assetsDir(env);
  if (!isDir(dir)) return { removed: [], skipped: null };
  const lock = path.join(dir, LOCK_FILE);
  if (!claimLock(lock, process.pid, now)) return { removed: [], skipped: "an install of assets is running" };
  const removed = [];
  try {
    const used = new Set([...keep, ...usedPackages({ env, now })]);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const tmp = TMP_DIR.exec(e.name);
      if (tmp) {
        if (!alive(Number(tmp[1]))) rmSync(path.join(dir, e.name), { recursive: true, force: true });
        continue;
      }
      if (!VERSION_DIR.test(e.name) || used.has(e.name)) continue;
      rmSync(path.join(dir, e.name), { recursive: true, force: true });
      rmSync(path.join(dir, `${e.name}.retry`), { force: true });
      removed.push(e.name);
    }
  } finally {
    releaseLock(lock, process.pid);
  }
  return { removed, skipped: null };
}
