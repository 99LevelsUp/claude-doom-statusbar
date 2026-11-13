// The Windows MSYS bash-flood gauge and reaper: count the live bash.exe processes, and kill the
// hung statusLine wrappers that feed the flood. Driven by src/hook.js, both on hook events and as
// `node src/hook.js --reap` from the render path.

import { spawnSync } from "node:child_process";
import { envNum } from "./runtime.js";

// Windows MSYS "bash flood" pressure gauge. Git Bash backs every shell-form hook AND the Bash
// tool AND — unavoidably — our own statusLine command, so when too many bash.exe inits collide
// the shared MSYS section corrupts ("add_item errno 1"). We surface the pressure so the HUD
// warns before it bites, and reapStaleShells() below defuses our own share of it.
// Counted via tasklist — a direct exe, never through bash, which would feed the very flood we
// measure. Non-win32 / failure -> null, so the HUD field simply never shows.
export function bashCount() {
  if (process.platform !== "win32") return null;
  try {
    const r = spawnSync("tasklist", ["/fi", "imagename eq bash.exe", "/fo", "csv", "/nh"],
      { encoding: "utf8", timeout: 1000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return 0; // no match -> tasklist prints an INFO line, not a row
    return r.stdout.split("\n").filter((l) => l.toLowerCase().includes("bash.exe")).length;
  } catch { return null; }
}

// --- Windows MSYS bash-flood reaper --------------------------------------------------------
// statusLine has NO exec form — its whole schema is type/command/padding/refreshInterval — so
// Claude Code runs our render command through a shell, and on Windows that shell is Git Bash
// whenever Git for Windows is installed. CLAUDE_CODE_GIT_BASH_PATH, CLAUDE_CODE_USE_POWERSHELL_TOOL
// and defaultShell do NOT redirect it (verified: with both env vars set, renders still came from
// C:\Program Files\Git\bin\bash.exe). Each render therefore costs TWO MSYS inits, because
// Git\bin\bash.exe is only a stub that re-execs Git\usr\bin\bash.exe.
//
// Those wrappers are the flood, and the failure is self-sustaining: a healthy `bash -c` returns
// in ~0.3 s, a poisoned one hangs ~15 s before dying with 0xC0000005. So the wrapper population
// never drops to zero, the shared section never gets an instant with no holder, and it cannot
// heal itself. Killing the accumulated wrappers heals it at once — measured on Win11 26200:
// 15233 ms + 0xC0000005 before, 277 ms + exit 0 immediately after. That is what we automate.
const REAP_ON = process.env.DOOMBAR_MSYS_REAP !== "0";
export const REAP_MIN = envNum(process.env.DOOMBAR_MSYS_REAP_MIN, 4); // only act once a pile is forming
const REAP_AGE = envNum(process.env.DOOMBAR_MSYS_REAP_AGE, 10000); // ms; a healthy render ~300 ms

// Pure decision half, exported so it can be tested without touching real processes.
// `procs` is [{ pid, ageMs, cmd }] as produced by listBashShells().
export function stalePids(procs, ageMs = REAP_AGE) {
  return (procs || [])
    .filter((p) => p && Number.isInteger(p.pid) && p.pid > 0)
    .filter((p) => /statusline\.js|doombar-client\.sh/i.test(String(p.cmd || "")))
    .filter((p) => Number.isFinite(p.ageMs) && p.ageMs >= ageMs)
    .map((p) => p.pid);
}

// The enumerator: bash.exe with age + command line. tasklist cannot show a command line and wmic
// is gone from current Windows builds, so this goes through PowerShell — a direct exe, not a
// shell wrapper, so it never adds to the MSYS flood. Only ever called once a pile is measured.
// Exported so the exact script that ships can be exercised, rather than a copy of it.
export const LIST_SHELLS_PS =
  "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | " +
  "Where-Object { $_.CreationDate } | ForEach-Object { " +
  "'{0}|{1}|{2}' -f $_.ProcessId, " +
  "[int]((Get-Date) - $_.CreationDate).TotalMilliseconds, $_.CommandLine }";

// Pure parse half. A command line can itself contain "|" (it usually does — `bash -c "node ..."`
// with a piped inner command), so only the FIRST TWO separators are structural.
export function parseBashShells(stdout) {
  return String(stdout || "").split(/\r?\n/)
    .map((l) => /^(\d+)\|(-?\d+)\|(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ageMs: Number(m[2]), cmd: m[3] }));
}

export function listBashShells() {
  try {
    const r = spawnSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", LIST_SHELLS_PS],
      { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return [];
    return parseBashShells(r.stdout);
  } catch { return []; }
}

// Kill via taskkill: a direct exe that always exists, so the cure never spawns a shell.
// Returns how many PIDs we asked to die (best effort — a PID that exited on its own is fine).
export function reapStaleShells() {
  if (process.platform !== "win32" || !REAP_ON) return 0;
  const pids = stalePids(listBashShells());
  if (pids.length === 0) return 0;
  try {
    const args = pids.flatMap((pid) => ["/PID", String(pid)]);
    spawnSync("taskkill", ["/F", ...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
  } catch { return 0; }
  return pids.length;
}
