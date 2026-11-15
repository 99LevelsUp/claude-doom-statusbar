// The package this one replaces: `claude-doom-statusbar`, installed globally with npm. This package
// is the next version of the same program, so `claude-game-bar install` removes the old one once
// the settings are saved, rather than asking the user to clean up after it. Used by bin/cli.js.
//
// The order matters: the settings no longer name the old package before it goes, and its render
// daemon is stopped first, with the same identity check the hooks apply, so nothing of it is left
// running out of a deleted folder. When npm cannot remove it, the install still succeeds and the
// output says how to remove it by hand.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, accessSync, existsSync, constants } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../package-root.js";
import { rootHash, samePath } from "../platform/runtime.js";
import { envGet } from "../platform/env.js";
import { stopOldPackageDaemon, removeOldPackageFiles } from "./daemons.js";

export const OLD_PACKAGE = "claude-doom-statusbar";
const REMOVE_CMD = `npm uninstall -g ${OLD_PACKAGE}`;

// How npm runs on `platform` for a node at `execPath`: { file, pre, shell, cwd }, the program, the
// arguments before npm's own, and whether it goes through the shell from `cwd`. Elsewhere than on
// Windows `npm` is looked up on PATH. On Windows npm is npm.cmd, a batch file, which Node refuses
// to spawn without a shell (EINVAL since the April 2024 security releases). So npm's own
// npm-cli.js, installed beside node.exe, runs with this node and no shell. Without it npm.cmd runs
// through the shell from node.exe's folder: cmd.exe looks a command up in the current directory
// before PATH, and the folder the installer was started in may hold an npm.cmd of anyone's.
export function npmCommand(platform = process.platform, execPath = process.execPath, exists = existsSync) {
  if (platform !== "win32") return { file: "npm", pre: [], shell: false, cwd: undefined };
  const dir = path.win32.dirname(execPath);
  const cli = path.win32.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
  if (exists(cli)) return { file: execPath, pre: [cli], shell: false, cwd: undefined };
  return { file: "npm", pre: [], shell: true, cwd: dir };
}

// Runs npm with `args`. GAMEBAR_NPM, when set, names a node script that stands in for npm (tests),
// run with this node. Otherwise npm runs as npmCommand says; through the shell it is one fixed
// command line: the arguments are constants here, and an argument list together with `shell` is
// deprecated.
export function runNpm(args, { env = process.env, timeout = 120000 } = {}) {
  const opts = { encoding: "utf8", env, timeout, windowsHide: true };
  const stand = envGet("NPM", env);
  if (stand) return spawnSync(process.execPath, [stand, ...args], opts);
  const npm = npmCommand();
  if (npm.shell) return spawnSync([npm.file, ...args].join(" "), { ...opts, shell: true, cwd: npm.cwd });
  return spawnSync(npm.file, [...npm.pre, ...args], opts);
}

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

// Finds the old package and, unless `keepOld`, stops its daemon and has npm remove it. Once npm has
// removed it, what it left in its runtime directories goes too (removeOldPackageFiles). Returns
// { line, notes, removed }: `line` is the one line for the output (null when there is no old
// package), `notes` what happened to its daemon and its files, `removed` true when npm removed it.
export function removeOldPackage({ keepOld = false, env = process.env } = {}) {
  const old = findOldPackage(env);
  if (!old) return { line: null, notes: [], removed: false };
  if (keepOld) {
    return { line: `kept the global ${OLD_PACKAGE} (--keep-old); remove it with: ${manualCommand(old.npmRoot)}`, notes: [], removed: false };
  }
  const hash = rootHash(old.root);
  const daemonJs = [path.join(old.root, "src", "daemon.js"), path.join(old.npmRoot, OLD_PACKAGE, "src", "daemon.js")];
  const notes = stopOldPackageDaemon({ hash, daemonJs, env });
  const r = runNpm(["uninstall", "-g", OLD_PACKAGE], { env });
  if (r.error || r.status !== 0) {
    const why = r.error ? (r.error.code || r.error.message) : `npm exited ${r.status}`;
    return { line: `could not remove the global ${OLD_PACKAGE} (${why}); remove it with: ${manualCommand(old.npmRoot)}`, notes, removed: false };
  }
  const files = removeOldPackageFiles({ hash, env });
  if (files.daemon) notes.push(`removed ${files.daemon} of the old package's render daemon file(s)`);
  if (files.learned) notes.push(`moved ${files.learned} learned-state file(s) of the old package to the new names`);
  if (files.other) notes.push(`removed ${files.other} other file(s) the old package left`);
  return { line: `removed the global ${OLD_PACKAGE}`, notes, removed: true };
}
