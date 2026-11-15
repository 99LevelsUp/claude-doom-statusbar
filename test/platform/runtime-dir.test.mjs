#!/usr/bin/env node
// The bar's runtime directory: which path every process picks, and when it may be used.
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runtimeDir, ensureRuntimeDir, existingPrivateDir, oldRuntimeDir, oldStateFile, readLearned, OLD_RUNTIME_NAME,
} from "../../src/platform/runtime.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const POSIX = process.platform !== "win32";

// Which path: a pure function of the environment, the platform, the effective uid and the owner
// of one directory (null when it does not exist).
const owners = { "/run/user/1000": 1000, "/run/user/0": 0, "/var/folders/xy/T": 1000 };
const pick = (env, platform = "linux") => runtimeDir(env, { platform, euid: 1000, ownerOf: (p) => owners[p] ?? null });

ok(pick({ GAMEBAR_RUNTIME_DIR: "/sandbox/x", XDG_RUNTIME_DIR: "/run/user/1000" }) === "/sandbox/x",
  "the override wins on Linux");
ok(runtimeDir({ GAMEBAR_RUNTIME_DIR: "C:\\sb" }, { platform: "win32" }) === "C:\\sb", "the override wins on Windows");
ok(runtimeDir({}, { platform: "win32" }) === os.tmpdir(), "Windows keeps the temp directory");
ok(pick({ XDG_RUNTIME_DIR: "/run/user/1000" }) === "/run/user/1000/gamebar", "an XDG runtime dir the user owns");
ok(pick({ XDG_RUNTIME_DIR: "/run/user/1000/" }) === "/run/user/1000/gamebar", "a trailing slash on XDG_RUNTIME_DIR");
ok(pick({ XDG_RUNTIME_DIR: "/run/user/4242" }) === "/run/user/4242/gamebar",
  "a missing XDG runtime dir keeps its path, so the bar fails closed instead of moving");
ok(pick({ XDG_RUNTIME_DIR: "/run/user/0" }) === "/tmp/gamebar-1000", "another user's XDG runtime dir (su, sudo -E)");
ok(pick({ XDG_RUNTIME_DIR: "run/user/1000" }) === "/tmp/gamebar-1000", "a relative XDG_RUNTIME_DIR is ignored");
ok(pick({}) === "/tmp/gamebar-1000", "no XDG_RUNTIME_DIR (cron, ssh without pam_systemd)");
ok(pick({ TMPDIR: "/var/folders/xy/T" }, "darwin") === "/var/folders/xy/T/gamebar", "macOS: the private per-user TMPDIR");
ok(pick({ TMPDIR: "/tmp" }, "darwin") === "/tmp/gamebar-1000", "macOS: a TMPDIR the user does not own");
ok(pick({ TMPDIR: "/var/folders/xy/T" }) === "/tmp/gamebar-1000", "Linux ignores TMPDIR");

// When it may be used: created private, checked, never followed through a link.
const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-rt-"));
process.on("exit", () => rmSync(SB, { recursive: true, force: true }));
const env = (dir) => ({ GAMEBAR_RUNTIME_DIR: dir });

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
  ok(ensureRuntimeDir(env(path.join(SB, "no-parent", "gamebar"))) === null,
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

// The runtime directory a release before 1.0.0 used: the same rule under its old name. It is only
// ever read (learned state), so it passes existingPrivateDir: a real directory, not a link, owned by
// the effective uid, never created and never chmod-ed. Another user may have planted one where an
// old release would have created it.
{
  const pickOld = (env, platform = "linux") =>
    runtimeDir(env, { platform, euid: 1000, ownerOf: (p) => owners[p] ?? null, name: OLD_RUNTIME_NAME });
  ok(pickOld({ XDG_RUNTIME_DIR: "/run/user/1000" }) === "/run/user/1000/doombar", "old name: an XDG runtime dir the user owns");
  ok(pickOld({}) === "/tmp/doombar-1000", "old name: no XDG_RUNTIME_DIR");
  ok(pickOld({ TMPDIR: "/var/folders/xy/T" }, "darwin") === "/var/folders/xy/T/doombar", "old name: macOS TMPDIR");
  ok(pickOld({ GAMEBAR_RUNTIME_DIR: "/sandbox/x" }) === "/sandbox/x", "old name: the override is the same directory");
  ok(pick({ XDG_RUNTIME_DIR: "/run/user/1000" }) === "/run/user/1000/gamebar", "and the new name is still resolved apart from it");

  // existingPrivateDir and oldRuntimeDir with a stubbed lstat: the decision on Linux, on any machine.
  const stat = (o) => () => ({ isDirectory: () => o.dir, uid: o.uid });
  const linux = (lstat) => ({ platform: "linux", euid: 1000, lstat });
  ok(existingPrivateDir("/tmp/doombar-1000", linux(stat({ dir: true, uid: 1000 }))) === "/tmp/doombar-1000",
    "an own real directory passes");
  ok(existingPrivateDir("/tmp/doombar-1000", linux(stat({ dir: true, uid: 4242 }))) === null,
    "an old directory owned by another uid is ignored");
  ok(existingPrivateDir("/tmp/doombar-1000", linux(stat({ dir: false, uid: 1000 }))) === null,
    "a symlink (or a file) in place of the old directory is ignored");
  ok(existingPrivateDir("/tmp/doombar-1000", linux(() => { throw Object.assign(new Error("x"), { code: "ENOENT" }); })) === null,
    "a missing old directory is ignored");
  ok(existingPrivateDir("C:\\Temp", { platform: "win32", lstat: () => { throw new Error("never asked"); } }) === "C:\\Temp",
    "Windows: the temp directory is used as it is");
  ok(oldRuntimeDir({}, { ...linux(stat({ dir: true, uid: 4242 })), ownerOf: () => null }) === null,
    "oldRuntimeDir ignores an old directory of another uid");
  ok(oldRuntimeDir({}, { ...linux(stat({ dir: true, uid: 1000 })), ownerOf: () => null }) === "/tmp/doombar-1000",
    "and resolves an own one");

  // The learned-state fallback reads nothing through a refused directory.
  const OLD = path.join(SB, "old-state");
  mkdirSync(OLD);
  writeFileSync(path.join(OLD, "mugshot_ratelimits_global.json"), "{\"old\":true}");
  const newFile = path.join(SB, "new-state", "gamebar_ratelimits_global.json");
  const via = (lstat) => readLearned(newFile, () => oldStateFile("mugshot_ratelimits_global.json", { GAMEBAR_RUNTIME_DIR: OLD }, linux(lstat)));
  ok(via(stat({ dir: true, uid: 1000 })).text === "{\"old\":true}" && via(stat({ dir: true, uid: 1000 })).old,
    "the fallback reads the old file from an own old directory");
  ok(via(stat({ dir: true, uid: 4242 })).text === null, "the fallback ignores an old directory owned by another uid");
  ok(via(stat({ dir: false, uid: 1000 })).text === null, "the fallback ignores a symlink in place of the old directory");
  mkdirSync(path.dirname(newFile));
  writeFileSync(newFile, "{\"new\":true}");
  ok(via(stat({ dir: true, uid: 1000 })).text === "{\"new\":true}" && !via(stat({ dir: true, uid: 1000 })).old,
    "once the new file exists, the old one is not read");

  if (POSIX) {
    // The same on the real filesystem: a symlink, a missing directory, another user's directory.
    const target = path.join(SB, "old-target");
    mkdirSync(target, { mode: 0o700 });
    const link = path.join(SB, "old-link");
    symlinkSync(target, link);
    ok(existingPrivateDir(link) === null, "a real symlink in place of the old directory is ignored");
    const missing = path.join(SB, "old-missing");
    ok(existingPrivateDir(missing) === null, "a missing old directory is ignored");
    let made = true;
    try { statSync(missing); } catch { made = false; }
    ok(!made, "and it is not created");
    const loose = path.join(SB, "old-loose");
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    ok(existingPrivateDir(loose) === loose && (statSync(loose).mode & 0o777) === 0o755,
      "an own old directory is read as it is, its mode never changed");
    if (process.geteuid() !== 0) ok(existingPrivateDir("/usr") === null, "a directory another user owns is ignored");
  }
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
