# One render daemon, a bitmap-to-glyph renderer, and a living minimap

**Date:** 2026-11-09
**Trigger:** the Warcraft III layout (G-8). The owner asked what the WC3 minimap could show. The answer
needs a map that is larger than its view and scrolls on its own, which today's one-process-per-second
statusline cannot afford. That turned the discussion to the backend.
**Status:** direction agreed by the owner (decisions below). Not planned. Next steps: `ce-ideate` to add
detail, then `ce-brainstorm`, then the usual plan → work → review flow.

## Order agreed by the owner

1. **Render daemon first.** "First we need a solid backend, then we can attach features to it."
2. **Bitmap → glyph renderer second.**
3. Minimap and the WC3 layout come after, on top of both.

## Owner decisions so far

| Topic | Decision |
|---|---|
| Daemon scope | **One daemon for all sessions** on the machine. It keeps the list of active sessions and serves each one. Chosen to save memory over one daemon per session. |
| Daemon not running | **Spawn nothing.** No fallback to the old `node` renderer. Spawning a process every second to stand in for a dead daemon only floods the system. |
| Extra code | Fine. A few dozen lines for things like PNG encoding are acceptable. |
| Renderer | A built-in renderer with a limited glyph set and no chafa as the default, chafa as the "full" option. Better still: a built-in renderer that is good enough to be the full one. |
| Hooks and transport details | Not decided here. They belong in the brainstorm. |

## Part 1: render daemon

### The constraint we cannot change

Claude Code spawns the statusLine command itself, once per refresh (1 s), and on Windows always through Git
Bash. statusLine has no exec form, and neither `CLAUDE_CODE_GIT_BASH_PATH` nor `defaultShell` redirects it
(see the project memory notes on the statusLine). So **one `bash` per second per session stays**. Everything
after that `bash` is ours to change. Today it is `bash → node → (chafa)`: two or three processes per second
per session, and the in-process caches (`_cache` in `src/face.js`) die with every render.

### Shape

```
SessionStart hook ──ensures──▶  daemon (node, one per machine, long-lived)
                                  │  ▲  reads  <session>/payload.json
                                  │  │  writes <session>/frame.txt (atomic rename)
                                  ▼  │
Claude Code ─every 1 s─▶  bash thin client: builtins only, no fork
                          read -r -d '' p                 # stdin → variable
                          printf '%s' "$p" > payload.json
                          read -r -d '' f < frame.txt
                          printf '%s' "$f"                # → status bar
```

- **Thin client**: only bash builtins (`read`, `printf`, redirections, `[[ -nt ]]`). It starts no `node`, no
  `cat`, nothing. The only process per tick is the one Claude Code starts.
- **One tick of latency**: the client prints the frame the daemon rendered from the previous payload. At a
  1 s refresh this is acceptable.
- **Daemon** holds state in memory: caches, map layout, camera position, animation tick. It renders when a
  session's payload changes and can also advance animations between payloads.
- **chafa inside the daemon** runs only for mugshot sprites, once per sprite × height, and the result is cached
  for the daemon's lifetime. A few dozen spawns at start, then none. The minimap never goes through chafa:
  every frame differs.
- **Daemon down**: the client sees a stale frame (`[[ payload -nt frame ]]` for longer than a threshold) and
  prints a static "offline" frame. It starts nothing (owner decision).

### Lifecycle (to settle in the brainstorm)

- Start: `SessionStart` makes sure the daemon is running (starts it if not). This is a hook spawn, once per
  session, not per tick.
- Session list: a session is active while its payload keeps updating. `SessionEnd` removes it; the existing
  end-of-session cleanup already deletes a session's files.
- Self-exit: the daemon exits when no session has updated its payload for N minutes. This covers Claude Code
  crashes where `SessionEnd` never arrives.
- Single instance: a lock (pid file or a named port) so two `SessionStart` hooks racing don't start two daemons.

### Open questions for ideation and brainstorm

- **Hooks without spawns.** Today every tool call spawns `node hook.js`. If Claude Code supports HTTP hooks
  (unverified, check the docs), the daemon could listen on a local port and receive hook events with no spawn
  at all. Before relying on that: what does Claude Code do when the daemon is down and an HTTP hook fails? A
  broken `PreToolUse` hook with no matcher can block every tool (project memory).
- **Transport** between client and daemon: files (works with builtins only) vs anything else. Files look
  like the only option that needs no fork from bash, but verify.
- **Partial payload writes**: the client writes `payload.json` without an atomic rename (`mv` would be a
  fork). The daemon must tolerate a half-written file (parse, and on failure keep the last good payload).
- **Is `read -r -d ''` + `printf > file` really fork-free in Git Bash?** Measure it, don't assume.
- **Upgrades**: a new package version while an old daemon runs. Version handshake, restart on mismatch.
- **Crash safety**: a daemon bug must not take the status bar down for every session at once. Isolate
  per-session render errors.
- **Relation to existing backlog**: P-2 (one shared producer for account- and machine-wide data) becomes part
  of the daemon. P-1 (what is expensive in a render) gives the baseline to compare against. L-A (own temp
  directory per session) fits the `<session>/payload.json`, `<session>/frame.txt` layout.

## Part 2: bitmap → glyph renderer

A built-in renderer that turns an RGB(A) pixel buffer into terminal block art, written in JS, no external
process.

- **Glyph set**: the one the mugshot uses, `block+half+quad+sextant+wedge+legacy` (`SYMS` in `src/face.js`,
  ideation 2026-06-06 §mugshot). `legacy` includes octants (2×4, U+1CD00..).
- **Algorithm** (same idea as chafa): every glyph has a precomputed mask on an 8×8 sub-pixel grid. Blocks,
  quadrants, sextants and octants are trivial masks; wedges are rasterised from their polygons. For each cell
  try every glyph, take the mean colour of the pixels under the mask as foreground and the rest as background,
  compute the error, keep the best.
- **Fast path**: a cell of one colour becomes a space or a full block without the search. On a map of flat
  terrain this is most cells.
- **Estimate**: 200–300 lines, much of it the glyph table. A 20×6-cell map is a few million operations per
  frame, a few milliseconds. Measure when it exists.
- **Limit of the glyph set**: two colours per cell, for any renderer including chafa. The minimap needs a
  priority (ping > unit > terrain) when more colours meet in one cell.
- **Terminal support**: Windows Terminal draws the legacy glyphs with its built-in rasteriser, no font needed.
  Other terminals depend on the font, so a half-block-only mode stays as a setting.
- **Possible bonus**: if the renderer holds up, compare it with chafa on the mugshot side by side. If it is
  close enough, chafa stops being needed at all. Decide from the pictures, not in advance.
- **Mugshot without chafa** would also need a PNG decoder (inflate via built-in `zlib`, plus scanline
  unfiltering), or the sprites pre-converted to a raw format at build time.

## Part 3: the minimap

### What makes a minimap different from every other HUD element

The other console elements are numbers, fill gauges or lists. The minimap is the only one that shows
**space**, and it brings four things nothing else has: fixed **terrain**, **fog of war** (explored vs not),
**units** (coloured dots: where something happens and who does it), and **camera + pings**. The earlier idea
(ideation 2026-10-31: "activity over time → spark / equalizer") uses none of them, so it is dropped as the
minimap's metric.

### Several metrics, one per layer (owner's idea)

The base of the map is one metric, the player dots another, more can follow. Proposed split, by **how fast
each layer changes**, so the layers don't drown each other:

| Layer | Pace | Metric |
|---|---|---|
| Terrain (base) | almost static | repo structure: top-level directories as regions, colour by kind (code, tests, docs, config) |
| Fog of war | only grows | what Claude has read or found this session (coverage) |
| Units (dots) | minutes | **who** works where: the main session in one player colour, each subagent in its own. A dot moves to the file the agent touched, its trail fades. |
| Pings (blink) | instant | tool error, failing test, pending permission |
| Camera | event-driven | see below |

**Not decided:** the owner is not sure which metric belongs to which layer. Terrain = repo is the weakest
pick, as it is the one layer that says nothing new during a session. Open for ideation.

### Map larger than the view, scrolling on its own (owner's idea)

The map is bigger than the visible window. Like the mugshot, it changes without any interaction with Claude:
the view scrolls in any direction, pixel by pixel, and every frame is rendered fresh from the bitmap of the
current window.

- **Speed is bound to the refresh**: one step per second. Fine for a slow camera pan, not a smooth animation.
  Crossing a 64 px map takes about a minute.
- **Pixel steps** with half blocks: one column sideways, half a row up or down.
- **Who drives the camera** (proposal): idle → slow free pan across the map; event (edit, error, permission)
  → the camera travels to it and stays. The map then not only shows but points.
- **Where am I**: a tiny position marker in a corner shows which part of the map is in view.
- **Cost of the idea**: at any moment part of the map is hidden. The event-driven camera is what makes that
  acceptable.

### Data sources (to verify)

- File paths: `PostToolUse` payloads of `Read`, `Edit`, `Write`, `Grep`, `Glob`. `Bash` gives no reliable path.
- Which subagent made a call: unverified whether the hook payload says so reliably. Check, don't guess.
- Layout: computed once per session from `git ls-files` (treemap of top-level directories, sized by file
  count), cached in the daemon. Large repos: one cell is a directory, not a file.

### Open for ideation

- Session-only map, or memory across sessions (WC3 keeps explored terrain grey: here grey could mean "read in
  an earlier session")?
- Map size in the WC3 layout (rows × columns).
- Does "activity over time" survive somewhere else in the layout, or is it dropped?
- Non-git directories: what is the terrain then?

## Artwork

As with Minecraft and the 2026-10-31 decision: all chrome drawn in code (glyphs and colours), no game assets.
