// The package this one replaces: `claude-doom-statusbar`, installed globally with npm. This package
// is the next version of the same program, so `claude-game-bar install` removes the old one once
// the settings are saved, rather than asking the user to clean up after it. Used by bin/cli.js.
//
// The order matters: the settings no longer name the old package before it goes, and its render
// daemon is stopped first, with the same identity check the hooks apply, so nothing of it is left
// running out of a deleted folder. When npm cannot remove it, the install still succeeds and the
// output says how to remove it by hand.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, accessSync, constants } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../package-root.js";
import { rootHash } from "../platform/runtime.js";
import { envGet } from "../platform/env.js";
import { stopOldPackageDaemon, removeOldPackageFiles } from "./daemons.js";

export const OLD_PACKAGE = "claude-doom-statusbar";
const REMOVE_CMD = `npm uninstall -g ${OLD_PACKAGE}`;

// Runs npm with `args`. GAMEBAR_NPM, when set, names a node script that stands in for npm (tests),
// run with this node. On Windows npm is npm.cmd, a batch file, which Node refuses to spawn without a
// shell (EINVAL since the April 2024 security releases), so it runs through the shell as one fixed
// command line: the arguments are constants here, and an argument list together with `shell` is
// deprecated.
export function runNpm(args, { env = process.env, timeout = 120000 } = {}) {
  const opts = { encoding: "utf8", env, timeout, windowsHide: true };
  const stand = envGet("NPM", env);
  if (stand) return spawnSync(process.execPath, [stand, ...args], opts);
  if (process.platform === "win32") return spawnSync(["npm", ...args].join(" "), { ...opts, shell: true });
  return spawnSync("npm", args, opts);
}

const samePath = (a, b) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);
const realPath = (p) => { try { return realpathSync(p); } catch { return p; } };

// The global old package: { npmRoot, root } with root its real path, or null when npm has none,
// npm cannot be asked, or that folder is this package itself.
export function findOldPackage(env = process.env) {
  const r = runNpm(["root", "-g"], { env, timeout: 30000 });
  if (r.error || r.status !== 0) return null;
  const npmRoot = String(r.stdout || "").trim().split(/\r?\n/).pop();
  if (!npmRoot) return null;
  const dir = path.join(npmRoot, OLD_PACKAGE);
  try {
    if (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name !== OLD_PACKAGE) return null;
  } catch { return null; }
  const root = realPath(dir);
  if (samePath(root, realPath(PACKAGE_ROOT))) return null;
  return { npmRoot, root };
}

// Where the global prefix is not writable by this user (a system-wide npm on Linux or macOS), the
// manual command needs sudo.
function manualCommand(npmRoot) {
  if (process.platform === "win32") return REMOVE_CMD;
  try { accessSync(npmRoot, constants.W_OK); return REMOVE_CMD; } catch { return `sudo ${REMOVE_CMD}`; }
}

// Finds the old package and, unless `keepOld`, stops its daemon and has npm remove it. Returns
// { line, notes }: `line` is the one line for the output (null when there is no old package),
// `notes` what happened to its daemon.
export function removeOldPackage({ keepOld = false, env = process.env } = {}) {
  const old = findOldPackage(env);
  if (!old) return { line: null, notes: [] };
  if (keepOld) {
    return { line: `kept the global ${OLD_PACKAGE} (--keep-old); remove it with: ${manualCommand(old.npmRoot)}`, notes: [] };
  }
  const hash = rootHash(old.root);
  const daemonJs = [path.join(old.root, "src", "daemon.js"), path.join(old.npmRoot, OLD_PACKAGE, "src", "daemon.js")];
  const notes = stopOldPackageDaemon({ hash, daemonJs, env });
  const r = runNpm(["uninstall", "-g", OLD_PACKAGE], { env });
  if (r.error || r.status !== 0) {
    const why = r.error ? (r.error.code || r.error.message) : `npm exited ${r.status}`;
    return { line: `could not remove the global ${OLD_PACKAGE} (${why}); remove it with: ${manualCommand(old.npmRoot)}`, notes };
  }
  const removed = removeOldPackageFiles({ hash, env });
  if (removed) notes.push(`removed ${removed} of the old package's render daemon file(s)`);
  return { line: `removed the global ${OLD_PACKAGE}`, notes };
}
