---
title: claude-game-bar 1.0.0 - Plan
type: refactor
date: 2026-11-13
topic: claude-game-bar-1-0
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# claude-game-bar 1.0.0 - Plan

## Goal Capsule

- **Objective:** A new game for the bar is added as that game alone, without touching shared code, under a project name that belongs to no single game, while every existing user's bar keeps looking and working exactly as before.
- **Means:** restructure the repository into one general part and separate game parts, then rename the project to `claude-game-bar` (GitHub, npm, local directory) and release it as 1.0.0.
- **Product authority:** the owner's decisions of 2026-11-13 (Key Decisions below). The second contributor has agreed to the rename.
- **Open blockers:** none for planning. Before the 1.0.0 release, the owner sets up the `claude-game-bar` package on npmjs.com (R15).

---

## Product Contract

### Summary

`claude-game-bar` 1.0.0 is a platform. One general part collects data from Claude Code and renders the bar, and each game (DOOM, Minecraft) is a separate part beside it, so Warcraft III arrives as a new part rather than a change to the core.
The bar looks and behaves the same as 0.15.0, existing installations move over through `install` without going dark, and the old package's last release tells its users where the bar went.

### Problem Frame

The bar started as a DOOM HUD, and the shape of the repository still says so. Every module that matters mixes general work with DOOM:
- the metric engine shares a file with DOOM sprite selection and layout dispatch;
- the general drawing primitives share a file with the DOOM box layout;
- the reaction channel between engine and games is spelled in DOOM sprite names, which the Minecraft layout parses back out.

A second game proved it can be done, and showed the cost: Minecraft duplicated primitives and went around the shared width planner.
The owner's next game is Warcraft III. On today's structure it would have to edit shared code in several places and speak DOOM sprite names to show a portrait.
The name is the same problem in public: a multi-game bar published as `claude-doom-statusbar` tells new users it is something else.
The full findings, with file-level evidence, are in `docs/ideation/2026-11-13-repo-structure-audit.md` (section 2).

### Key Decisions

- **1.0.0 contains the restructure, the neutral reaction state, the per-session render context, the game registry and the rename. It changes nothing a user can see.** Governs R1, R3, R5, R6, R8. (session-settled: user-directed — chosen over a rename-only 1.0.0 and over a 1.0.0 that waits for Warcraft III: the new structure should be in place before the next game, and the release should not wait for one.)
- **Structure first, rename last, each step its own pull request into master.** The bar is unchanged after every step, so the Raspberry Pi, which runs from master, checks each step live. Governs R6, R7. (session-settled: user-approved — chosen over renaming first, which churns files about to be split, and over one integration branch merged once, which leaves the live check to the very end.)
- **New games are added in this repository for now. The game interface is shaped so external game packages can be opened up in 1.x without a major version.** Governs R4. (session-settled: user-directed — chosen over keeping games repo-only for good, and over a public game API frozen at 1.0.)
- **Old names keep working for a few 1.x releases, not all of 1.x.** The release that removes them calls it a breaking change in the changelog. Governs R9, R11. (session-settled: user-directed — chosen over keeping the fallbacks until 2.0.0.)
- **The local directory is renamed with 1.0.0, not later.** Governs R12. (session-settled: user-directed — chosen over leaving the directory name for a separate later step.)
- **The old package gets a final release, then `npm deprecate`.** Governs R16. (session-settled: user-approved — chosen over a deprecation message alone.)
- **That final release shows the move notice permanently in the bar.** Governs R16. (session-settled: user-directed — chosen over a temporary notice and over notices in npm and the CLI only: most users never run the CLI again and only ever see the bar.)
- **The README is rewritten in full for the new project.** Governs R13. (session-settled: user-directed — the owner added it to the scope.)

### Requirements

**Platform shape**

- R1. The general part (data collection, the metric engine, drawing primitives, the render daemon and client, hooks, the installer) holds no knowledge of any particular game. Each game keeps its layout, presets, assets and game-specific chrome in its own part. The target layout is `docs/ideation/2026-11-13-repo-structure-audit.md`, section 3.
- R2. Adding a game means adding its part and one registry entry. Nothing in the general part changes for it.
- R3. Engine and games exchange a game-neutral reaction state (expression, health step, god mode, dead). Only the DOOM part turns it into DOOM sprites.
- R4. The game interface is internal in 1.0.0 and is described in a short contributor guide in the repository.
- R5. Every session is rendered from its own explicit context. No session's frame depends on state another session's render left behind in the daemon.

**No visible change**

- R6. Every preset renders byte-identically to 0.15.0 at every tested width and reaction state, and hooks, daemon, client and installer behave as before apart from names.
- R7. A live installation never goes offline while the steps land or during the 1.x fallback period: installed settings, and the daemon identity check, keep finding the files they point at.

**Rename**

- R8. The package, the CLI and the GitHub repository are named `claude-game-bar`. The old CLI name still works as an alias.
- R9. Environment variables, the theme choice file, file names in the runtime directory and the client are renamed to game-neutral names. The old names are still honoured during the fallback period.
- R10. `claude-game-bar install` moves an existing installation over in place:
  - it rewrites the settings entries, the environment variable names and the theme file;
  - it never registers a second set of hooks;
  - it leaves the old global package installed and prints how to remove it.
- R11. The stale-file sweep and `uninstall` recognise both old and new file names during the fallback period.
- R12. The local working directory is renamed with 1.0.0. This repo's own live wiring and the Claude auto-memory move with it, so neither breaks. The Raspberry Pi's clone and its global settings change only with the owner's explicit OK.

**Documentation**

- R13. The README is rewritten for `claude-game-bar`. It presents the platform first and the games as equal parts, with DOOM as one of them. It keeps everything a user needs today:
  - install and update;
  - Windows with Git Bash;
  - themes and presets;
  - the glyph test card;
  - the OFFLINE state;
  - daemon troubleshooting;
  - uninstall.

  It adds a section on moving from `claude-doom-statusbar`, and keeps each game's credit with that game.
- R14. The package description and keywords, `CLAUDE.md` and `CONTRIBUTING.md` describe the game-neutral project. `CONTRIBUTING.md` carries the guide for adding a game (R4).

**Release**

- R15. 1.0.0 is published as `claude-game-bar` through the protected-master release flow, once the owner has set up the package and its trusted publisher on npmjs.com.
- R16. `claude-doom-statusbar` gets a final 0.16.0: 0.15.0 plus a permanent row in the bar saying the bar has moved to `claude-game-bar` and how to switch. The package is then deprecated with the same message.

**Quality**

- R17. The test suite runs every test file and reports a summary even when one fails. The daemon end-to-end test runs on its own.

### Acceptance Examples

- AE1. **Covers R10.**
  - **Given:** a settings file wired by `claude-doom-statusbar` (hooks, statusLine, `DOOMBAR_PRESET`) and a saved Minecraft theme.
  - **When:** the user runs `claude-game-bar install`.
  - **Then:**
    - every entry points at the new package and the variable is renamed;
    - exactly one set of hooks remains;
    - the Minecraft theme is still selected;
    - the output says how to remove the old global package.
- AE2. **Covers R9.** **Given** a user who still sets only the old variable for the theme or preset, **when** the bar renders under 1.0.0, **then** it honours that setting exactly as 0.15.0 did.
- AE3. **Covers R7.** **Given** the Pi running its live bar from master, **when** it pulls any merged 1.0.0 step, **then** the bar stays live and exactly one daemon runs.
- AE4. **Covers R16.**
  - **Given:** a user who updates `claude-doom-statusbar` to 0.16.0.
  - **When:** the bar renders in any theme.
  - **Then:** the normal bar appears together with a row saying the bar has moved to `claude-game-bar` and how to switch, and the row stays until the user moves.
- AE5. **Covers R11.** **Given** runtime files left by 0.15.0, **when** a 1.0.0 hook sweeps or the user uninstalls, **then** those files are cleaned up exactly like the new ones.

### Success Criteria

- The snapshot tests (9 DOOM, 5 Minecraft) stay byte-identical from the first step to 1.0.0.
- The owner's PC and the Pi keep a live bar through every merged step and through the move to the new package.
- A test-only game can be registered and rendered without editing any file in the general part. This proves R2 before Warcraft III depends on it.

### Scope Boundaries

**Deferred for later (1.x):**
- the Warcraft III game (G-8, D-5);
- moving Minecraft onto the shared width planner and kit (G-4, G-5);
- the user preset overlay (G-3);
- chat as data (G-6, G-7);
- line art (D-17);
- loading games from external packages;
- removing the old-name fallbacks.

**Not in this work:**
- any visual or behavioural change, including fixes that would alter output;
- rewriting history: dated docs and old changelog entries keep their wording;
- changing the Pi's settings without the owner's OK.

### Dependencies / Assumptions

- The name `claude-game-bar` is still free on npm and GitHub (checked 2026-11-13: both return 404).
- The second contributor has no open branch or pull request (checked 2026-11-13), and has agreed to the rename.
- `master` is protected: every change is a pull request with green `test` and `e2e` checks, merged with a merge commit.
- Git Bash started from tool shells on the owner's PC is failing for now (an open issue). Linux verification relies on GitHub Actions and the Pi session.

### Outstanding Questions

**Deferred to Planning**

- [Affects R7][Technical] Which entry files keep their path and which become a shim at the old path; this is the client in particular.
- [Affects R16][Technical] How the notice row fits the Minecraft layout and narrow terminals without changing the rest of the bar.
- [Affects R12][Technical] The order of the directory rename, the re-wiring and the memory move, so the live bar on this PC never points at a missing path.
- [Affects R17][Technical] Whether the tests move into per-layer folders together with the code, or separately.

### Sources

- `docs/ideation/2026-11-13-repo-structure-audit.md`:
  - findings S1–S10;
  - the target tree;
  - the public API at 1.0;
  - the migration hazards;
  - phasing steps 1–8.
- `docs/ideation/2026-10-31-shared-game-layout-engine.md`:
  - the three-layer proposal;
  - the HUD kit;
  - the rename inventory;
  - the npm migration.
- `docs/BACKLOG.md`, section *Rename to `claude-game-bar` and restructure (1.0.0)*: rows R-0 to R-8.
- `CONTRIBUTING.md`, the protected-master pull request and release flow.
