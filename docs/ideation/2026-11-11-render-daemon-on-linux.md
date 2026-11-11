---
date: 2026-11-11
topic: render daemon on Linux (and macOS)
status: findings, not yet planned
backlog: D-15
---

# Render daemon on Linux

The owner wants Linux as optimised as Windows: hooks collect per-session data, one render daemon per
installation gathers the machine-wide data once and pre-renders every session's whole bar, and the
statusLine is only a small, fast client. Today (D-1) that holds only on Windows with Git Bash. Linux
and macOS still run the one-shot `node src/statusline.js` on every tick.

The facts below were measured on the owner's Raspberry Pi 5 on 11.11.2026, by a Claude Code session
running there, read-only. Setup: Debian 13 (systemd 257), Claude Code 2.1.322, LXTerminal on
VTE 0.80.1, bash 5.2.37, dash 0.5.12, node 20.19.2, aarch64.

## What it would save

| Per statusLine tick | Pi 5 |
|---|---|
| one-shot, master (pre-rendered `.ans` face, no chafa installed) | 251 ms median |
| one-shot, feat/glyph-renderer (face from the disk cache) | 234–261 ms median |
| bare `node -e ""` | 122–135 ms |
| `sh -c 'bash -c :'` (what a tick through dash costs) | ~1.7 ms |
| client-like tick: bash reads a 6.9 KB file with `read -r -N`, prints it | ~1.3 ms |

A client tick would cost about 1.5–2 ms instead of about 250 ms, roughly 150 times less. At the 1 s
refresh that is a quarter of a core given back on the Pi.

## Facts that shape the port

1. **The statusLine runs under `/bin/sh -c`, which is dash on Debian.** `$SHELL` (bash) is not used.
   Seen as `sh /bin/sh -c node ".../src/statusline.js"`, a direct child of the claude process, once a
   second. dash 0.5.12 does not exec the last command of `-c`, so a dash process would stay alive for
   the whole tick. The client sources bash-only syntax (`[[ ]]`, arrays, `EPOCHREALTIME`), so the Linux
   command must be `exec bash --norc --noprofile <client>` or `exec bash -c '. <client>'`. With `exec`,
   bash inherits stdin, so the payload still arrives.
2. **Temp directory.** `TMPDIR` was unset and `os.tmpdir()` gave `/tmp` (tmpfs). The client picks
   `TEMP`, `TMP`, `TMPDIR`, `/tmp` in that order, which is Node's order on Windows; on POSIX Node reads
   `TMPDIR` first, so the client's order must depend on the platform.
3. **Singleton.** Node can listen on an abstract Unix socket (`\0doombar-<hash>`). But abstract sockets
   have no file permissions and are shared per network namespace: any local user could bind the
   predictable name first and keep the real daemon from ever starting, or answer the probe. A path
   socket is safer.
4. **Where the files go.** `/tmp` is shared between users, unlike `%TEMP%`. The payload files carry
   the forwarded environment line. Proposed: socket and all per-session files under
   `$XDG_RUNTIME_DIR/doombar/` (tmpfs, mode 700, cleared at logout). Unlink a stale socket after a
   failed connect. Fall back to `/tmp/doombar-<uid>/` created 0700 with an `lstat` owner and mode check
   that does not follow symlinks, for cron, ssh without pam_systemd and some containers. Files 0600.
   This overlaps L-A (own directory per installation).
5. **Identity check before a kill.** `/proc/<pid>/cmdline` (NUL-separated) and the start time from
   `/proc/<pid>/stat` field 22, in clock ticks since boot (`CLK_TCK` 100 on the Pi). Field 2 is
   `(comm)` and may contain spaces or `)`, so parse from the last `)`: the start time is the 20th field
   after it. Kill with `process.kill(pid, "SIGKILL")` instead of `taskkill`. macOS: `ps -o lstart=,command= -p`.
6. **Lifetime.** `KillUserProcesses` is off on Debian by default and the Pi has linger on. A detached
   daemon (`detached: true`, which calls setsid, `stdio: "ignore"`, `unref`) survives closing the
   terminal or VS Code. Where `KillUserProcesses=yes`, it dies at logout and the next hook starts it
   again; the client shows OFFLINE meanwhile. No `systemd-run` needed.
7. **Sandboxed VS Code** (snap or flatpak) may see a private `/tmp` and `XDG_RUNTIME_DIR`. Hooks,
   client and daemon all start from the same claude process, so they share that view; two sandboxes
   just get two daemons. A path socket keeps the singleton in the same mount namespace as the files,
   which an abstract socket does not.
8. **Priority.** `os.setPriority` to below normal (nice 10) works unprivileged. The 10-minute idle
   exit is fine: a restart costs one node start plus the first face conversion (~450–500 ms on the Pi),
   paid in the daemon, not in a tick.
9. **macOS** ships bash 3.2 as `/bin/bash`: no `EPOCHREALTIME` (bash 5.0) and no `read -N` (4.1).
   The installer must check `BASH_VERSINFO[0] >= 5` and keep the one-shot otherwise.

## What changes in the code

- `bin/cli.js`: `useClient()` is Git-Bash-only; on Linux it would need a bash 5 check and the `exec bash`
  command form.
- `src/fold.js` `pipePath`: a Windows named pipe; on POSIX a path socket in the private directory.
- `src/hook.js`: `superviseDaemon` is gated on win32; `confirmedDaemonPid` uses PowerShell and
  `restartDaemon` uses `taskkill`. The MSYS reaper and pressure gauge stay Windows-only.
- `src/doombar-client.sh`: the temp directory order, or a directory passed in by the command.
- `src/daemon.js`: the forwarded environment list may need `TERM` and `VTE_VERSION` once the daemon
  renders for Linux terminals, since the glyph step follows them (see the glyph renderer's residual
  findings).
