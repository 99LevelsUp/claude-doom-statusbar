# Git Bash pile-up from the statusline — stop spawning bash, or share one statusbar between sessions

**Date:** 2026-10-14
**Trigger:** Stop hooks and every Bash tool call failing with
`bash.exe: *** fatal error - add_item ("\??\C:\Program Files\Git", "/", ...) failed, errno 1`.
**Status:** seed for a later brainstorm — owner's request, not analysed yet.

## Observed

- Claude Code on Windows runs `statusLine.command` (and hook commands) through Git Bash: each render is a
  `bash.exe -c "node …/claude-doom-statusbar/src/statusline.js"`.
- `refreshInterval: 1` × **8 open Claude Code processes** → 18 statusline bashes alive at once, plus hook
  bashes (`stop-review-gate-hook.mjs`, a plugin PowerShell hook). After the MSYS shared mount table broke,
  every new bash crashed and they piled up to 42.
- A single `Stop-Process` did not help (respawned faster than they died). Killing `bash`/`sh` in a tight
  loop (15× / 150 ms) and testing a fresh bash right after restored it. Details:
  reverse-architect memory `gitbash-bash-fatal-error-recurring`.

## Owner's direction

Raising `refreshInterval` is the **last resort** — discussed several times, not wanted. Preferred instead:

1. **Stop spawning bash.** In some cases this was achieved before (hooks that no longer shell out through
   bash). Find out what decides that the harness wraps the statusline in Git Bash and whether the
   statusline can be invoked without it.
2. **One shared statusbar for several sessions.** Part of the data is the same for every session (usage
   and rate limits, CPU/RAM, clock), part is per session (repo, model, agents, context). Compute the shared
   part once — e.g. a single background producer writing a cache that each session's render only reads —
   so N sessions do not each recompute (and each spawn) the common work every second.

## Update 2026-10-31 — first shared piece landed (0.13.1)

0.13.1 (contributor) pools `rate_limits` across sessions: every render merges its reading into
`$TMP/mugshot_ratelimits_global.json` (atomic tmp + rename) and shows the freshest one (later `resets_at`
wins; same window takes the higher %). `DOOMBAR_RATELIMITS_SHARE=0` turns it off. That fixes stale limits in
idle chats, but it is still N renderers each reading and writing per second, not one producer, so it does
not reduce the bash spawns. Two things to carry into the design: after a window's `resets_at` has passed
with every session idle, the pooled value stays at the old % until some session calls the API; and the file
is per OS user, not per Claude account.

## Open questions

- Which part of a render is expensive, and which part actually needs the per-second refresh?
- Can the per-session part be rendered from data the harness already passes on stdin, without a process
  per render?
