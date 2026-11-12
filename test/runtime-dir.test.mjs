#!/usr/bin/env node
// The bar's runtime directory: which path every process picks, and when it may be used.
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimeDir, ensureRuntimeDir } from "../src/fold.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const POSIX = process.platform !== "win32";

// Which path: a pure function of the environment, the platform, the effective uid and the owner
// of one directory (null when it does not exist).
const owners = { "/run/user/1000": 1000, "/run/user/0": 0, "/var/folders/xy/T": 1000 };
const pick = (env, platform = "linux") => runtimeDir(env, { platform, euid: 1000, ownerOf: (p) => owners[p] ?? null });

ok(pick({ DOOMBAR_RUNTIME_DIR: "/sandbox/x", XDG_RUNTIME_DIR: "/run/user/1000" }) === "/sandbox/x",
  "the override wins on Linux");
ok(runtimeDir({ DOOMBAR_RUNTIME_DIR: "C:\\sb" }, { platform: "win32" }) === "C:\\sb", "the override wins on Windows");
ok(runtimeDir({}, { platform: "win32" }) === os.tmpdir(), "Windows keeps the temp directory");
ok(pick({ XDG_RUNTIME_DIR: "/run/user/1000" }) === "/run/user/1000/doombar", "an XDG runtime dir the user owns");
ok(pick({ XDG_RUNTIME_DIR: "/run/user/1000/" }) === "/run/user/1000/doombar", "a trailing slash on XDG_RUNTIME_DIR");
ok(pick({ XDG_RUNTIME_DIR: "/run/user/4242" }) === "/run/user/4242/doombar",
  "a missing XDG runtime dir keeps its path, so the bar fails closed instead of moving");
ok(pick({ XDG_RUNTIME_DIR: "/run/user/0" }) === "/tmp/doombar-1000", "another user's XDG runtime dir (su, sudo -E)");
ok(pick({ XDG_RUNTIME_DIR: "run/user/1000" }) === "/tmp/doombar-1000", "a relative XDG_RUNTIME_DIR is ignored");
ok(pick({}) === "/tmp/doombar-1000", "no XDG_RUNTIME_DIR (cron, ssh without pam_systemd)");
ok(pick({ TMPDIR: "/var/folders/xy/T" }, "darwin") === "/var/folders/xy/T/doombar", "macOS: the private per-user TMPDIR");
ok(pick({ TMPDIR: "/tmp" }, "darwin") === "/tmp/doombar-1000", "macOS: a TMPDIR the user does not own");
ok(pick({ TMPDIR: "/var/folders/xy/T" }) === "/tmp/doombar-1000", "Linux ignores TMPDIR");

// When it may be used: created private, checked, never followed through a link.
const SB = mkdtempSync(path.join(os.tmpdir(), "doombar-rt-"));
process.on("exit", () => rmSync(SB, { recursive: true, force: true }));
const env = (dir) => ({ DOOMBAR_RUNTIME_DIR: dir });

const fresh = path.join(SB, "fresh");
ok(ensureRuntimeDir(env(fresh)) === fresh, "a missing directory is created and accepted");
if (POSIX) {
  ok((statSync(fresh).mode & 0o777) === 0o700, "it is created with mode 0700");
  const loose = path.join(SB, "loose");
  mkdirSync(loose, { mode: 0o755 });
  chmodSync(loose, 0o755);
  ok(ensureRuntimeDir(env(loose)) === loose && (statSync(loose).mode & 0o777) === 0o700,
    "an own directory with group or world bits is set back to 0700");
  const target = path.join(SB, "target");
  mkdirSync(target, { mode: 0o700 });
  const link = path.join(SB, "link");
  symlinkSync(target, link);
  ok(ensureRuntimeDir(env(link)) === null, "a symlink in place of the directory is refused");
  const file = path.join(SB, "file");
  writeFileSync(file, "x");
  ok(ensureRuntimeDir(env(file)) === null, "a file in place of the directory is refused");
  ok(ensureRuntimeDir(env(path.join(SB, "no-parent", "doombar"))) === null,
    "a directory whose parent is missing is refused (a removed /run/user/<uid>)");
  let parentMade = true;
  try { statSync(path.join(SB, "no-parent")); } catch { parentMade = false; }
  ok(!parentMade, "and its parent is not created");
  // A directory of another user (root's /usr) is refused and left as it is. Root owns it, so
  // there is nothing to test as root.
  if (process.geteuid() !== 0) {
    const before = statSync("/usr").mode;
    ok(ensureRuntimeDir(env("/usr")) === null, "a directory another user owns is refused");
    ok(statSync("/usr").mode === before, "and its mode is not touched");
  }
} else {
  ok(ensureRuntimeDir({}) === os.tmpdir(), "Windows uses the temp directory as it is");
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
