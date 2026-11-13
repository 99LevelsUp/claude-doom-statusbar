// The statusLine command the installer writes: bash detection and the client command, or the
// one-shot renderer when no suitable bash is found. Used by `claude-doom-statusbar install`
// (bin/cli.js).

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PACKAGE_ROOT, SRC_DIR } from "../package-root.js";
import { rootHash } from "../platform/runtime.js";
import { slash } from "./settings.js";

const HASH = rootHash(PACKAGE_ROOT); // this installation's daemon and its files

export const STATUSLINE = slash(path.join(SRC_DIR, "statusline.js"));
export const CLIENT = slash(path.join(SRC_DIR, "doombar-client.sh"));
export const NODE_CMD = `node "${STATUSLINE}"`;

// The statusLine command that runs the bash client, which prints the frame the render daemon
// prepared (see src/doombar-client.sh, src/daemon.js). The client lives in the package, so an
// upgrade in the same place reaches it without touching settings.json; the guard keeps a removed
// package from printing shell errors into the bar. `if` rather than `[ ] && . || echo`: the
// client may end with a non-zero status after printing a frame, and `||` would then add the
// offline line under it.
//
// Windows with Git Bash: Claude Code runs the statusLine through Git Bash, and the command sources
// the client into that very bash: no second bash, no node, no process at all.
//
// Linux and macOS: Claude Code runs it through /bin/sh, which is dash on Debian and does not
// replace itself with the last command, so the command execs the bash 5 found at install (by the
// path it was found at, so a Homebrew upgrade keeps it valid), with the hash as an argument.
// BASH_ENV is cleared because bash would source it even with --norc. When that bash is gone the
// bar prints the offline line. Without a bash 5 (macOS ships 3.2; Windows without Git Bash runs
// PowerShell) the one-shot renderer stays. The paths are single-quoted: a `$`, backtick or `"` in
// a home directory name stays text instead of running in /bin/sh on every tick.
const WIN_CLIENT_CMD = `DOOMBAR_ROOT_HASH=${HASH}; f="${CLIENT}"; ` +
  `if [ -r "$f" ]; then . "$f"; else echo 'doombar: offline'; fi`;
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const posixClientCmd = (bash) => `b=${shQuote(bash)}; f=${shQuote(CLIENT)}; ` +
  `if [ -r "$f" ] && [ -x "$b" ]; then unset BASH_ENV; exec "$b" --norc --noprofile "$f" ${HASH}; ` +
  `else echo 'doombar: offline'; fi`;

// Linux and macOS: a bash of major version 5 or newer for the client, by the path it was found
// at, or null. DOOMBAR_BASH, when set, is the only candidate. One short spawn per candidate, at
// install only.
function posixBash(env = process.env) {
  const cands = env.DOOMBAR_BASH ? [env.DOOMBAR_BASH]
    : ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash",
      ...String(env.PATH || "").split(":").filter((d) => d.startsWith("/")).map((d) => path.posix.join(d, "bash"))];
  for (const bash of new Set(cands)) {
    if (!bash.startsWith("/") || !existsSync(bash)) continue;
    const r = spawnSync(bash, ["--norc", "--noprofile", "-c", 'echo "${BASH_VERSINFO[0]}"'], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0 && Number(String(r.stdout).trim()) >= 5) return bash;
  }
  return null;
}

// The bash Claude Code would run the statusLine with. It finds Git Bash on its own, not through
// PATH (whose bash.exe may well be WSL's): an explicit CLAUDE_CODE_GIT_BASH_PATH, the standard
// Git for Windows locations, then the install around a git.exe on PATH. Existence checks only.
function gitBash(env = process.env) {
  if (process.platform !== "win32") return null;
  const bin = (root) => path.join(root, "bin", "bash.exe");
  const cands = [env.CLAUDE_CODE_GIT_BASH_PATH];
  for (const pf of [env.ProgramFiles, env["ProgramFiles(x86)"]]) if (pf) cands.push(bin(path.join(pf, "Git")));
  if (env.LOCALAPPDATA) cands.push(bin(path.join(env.LOCALAPPDATA, "Programs", "Git")));
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const git = path.join(dir.replace(/^"|"$/g, ""), "git.exe");
    if (!existsSync(git)) continue;
    // <git>\cmd\git.exe or <git>\bin\git.exe, and <git>\mingw64\bin\git.exe one level deeper.
    // No early stop: a git.exe that is not Git for Windows (a scoop shim) must not hide a later one.
    cands.push(bin(path.dirname(path.dirname(git))), bin(path.dirname(path.dirname(path.dirname(git)))));
  }
  return cands.find((p) => p && existsSync(p)) ?? null;
}

export function clientCommand() {
  if (process.platform === "win32") return gitBash() !== null ? WIN_CLIENT_CMD : null;
  const bash = posixBash();
  return bash ? posixClientCmd(bash) : null;
}
