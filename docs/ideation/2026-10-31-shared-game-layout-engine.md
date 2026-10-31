# One metric engine, many game HUDs: sharing code between DOOM, Minecraft and what comes next

**Date:** 2026-10-31
**Trigger:** review of the 0.12.0–0.13.0 contribution (`minecraft` theme: `src/hotbar.js`, `src/chat.js`,
`src/theme.js`) and how it fits the project's concept.
**Next game:** Warcraft III (owner's). It should reuse as much of DOOM and Minecraft as possible and add only
what is genuinely new.
**Status:** direction agreed by the owner; not planned yet. Agree with the contributor before Phase 2.

## Principle

Every theme is **a different layout of the same measuring engine**. The metric catalogue (`VALUES` built in
`statusline.js`) is shared. Each game keeps its own recognisable chrome (Minecraft hearts, shanks, XP bar,
hotbar frames; DOOM boxes and mugshot), and that part of the rendering is allowed to be game-specific.
Everything else (binding metrics to places, fitting text into cells, behaviour on a narrow terminal, the
selection logic, the chat) is shared code, so the next game is mostly composition plus a little new chrome.

## Where 0.13.0 stands against that principle

| Topic | State in 0.13.0 | Owner's decision |
|---|---|---|
| Configuration format | Presets are TOML; only the theme choice is JSON (`~/.claude/doombar-theme.json`) | The format doesn't matter, as long as what is shown is configurable |
| Minecraft chrome (♥ ♡ 🍖 🦴, ━, ┏┳┓ frames, colours) | Hard-coded in `hotbar.js` | **Fine.** It is a fixed part of Minecraft |
| Which gauge shows which metric | `[hotbar] hearts / hunger / xp = "<metric id>"` | **Required, and already there.** Keep the binding |
| The grid under the gauges | `[[slot]] { icon, id }`, at most 9 | **Required.** Exactly 9 slots is fine; the user picks the metric (and icon) per slot |
| No mugshot in the Minecraft HUD | The sprite only tints the hearts (gold = god, pale = ouch) | **Fine.** Minecraft has no face; in DOOM the face is just one of the boxes, so no layout rule is broken |
| Theme is global, overrides `DOOMBAR_PRESET` | One choice for every session | **Fine.** Settings are shared, not per session |
| 0.12.0 face swap → 0.13.0 full Minecraft imitation | The generic `icons` render type and `[bar].title_color` stayed but no preset uses them | Known and accepted |
| **Hotbar bypasses the box layout engine** | Its own width logic: no `[bar].fallback`, no `resolvePreset`, no `text_overflow` / marquee; its own `fit()` clips by code point (breaks OSC-8 hyperlinks / SGR in a value) | **Must be unified.** Not "boxes are right, hotbar is wrong": both layouts should behave the same and use the same functions |
| Adding a game | New module + a new `if (layout === "…")` branch in `statusline.js main()` + its own chat and `facts()` | Must become "new preset + thin layout module" |
| Chat script | `SCRIPT`, `FAMILY` (model names) and `facts()` hard-coded in `chat.js`; README tells users to edit `src/chat.js` | Make it data (part of the proposal below) |

### Gap the table exposes: user configuration doesn't survive an update

The README says *"to change what's in the hotbar, edit the `[[slot]]` entries in `presets/minecraft.toml`"*.
With an npm install that file lives in the package and is overwritten on every update. A user's own preset
only works through `DOOMBAR_PRESET` while the theme is `doom` (the theme's preset wins otherwise), which is
backwards. "The user chooses what each slot shows" needs a user-level preset that survives updates, e.g.:

- `~/.claude/doombar/<theme>.toml` overlays the packaged preset (merge: user keys win; `[[slot]]` replaces the
  packaged list as a whole), or
- `~/.claude/doombar-theme.json` → `{ "theme": "minecraft", "preset": "<path>" }`.

The overlay is preferred: a user who only rebinds two slots shouldn't have to copy the whole file.

## Proposal: three layers

```
 metric engine        statusline.js buildValues / activityValues / sysValues  →  VALUES   (shared, exists)
        │
 shared HUD kit       bindings · cell fit/marquee · gauge row · meter bar · grid · selection ·
        │             chat feed · portrait (mugshot) · width planner / fallback        (shared, to extract)
        │
 game layouts         boxes (DOOM)   hotbar (Minecraft)   console (Warcraft III)   (thin, game chrome only)
```

### 1. Layout registry instead of `if` branches

`[bar] layout = "boxes" | "hotbar" | "…"` resolves through a registry (`src/layouts/index.js`). Each layout
exports the same small interface:

- `sockets(cfg)` — the named places this layout offers (`hearts`, `hunger`, `xp`, `slot[0..8]`; for DOOM the
  boxes and their metric lists),
- `plan(cfg, target, ctx)` — minimum / natural width and whether it fits; used by the shared fallback chain,
- `render(cfg, target, ctx)` — the lines.

`statusline.js` stops knowing about any particular game.

### 2. Shared binding syntax

Every layout binds metrics to its sockets the same way: a socket name → `{ id, icon?, label?, render? }`.
DOOM's `[[segment]].metric` lists and Minecraft's `[hotbar]` + `[[slot]]` are two spellings of the same
thing; keep both spellings readable (no breaking change for existing presets), normalise them into one
internal form.

### 3. Shared HUD kit (extracted mostly from `hotbar.js` and `render.js`)

| Primitive | From | Used by |
|---|---|---|
| **Cell fit** — escape-safe clip + marquee + `text_overflow` | `render.js` (`vlen`, `marquee`) replaces hotbar `fit()` | every layout |
| **Gauge row** — N glyphs filled by a value; `glyph`, `empty_glyph`, colour, direction, spread over a span | `hotbar.js glyphCells` + `render.js rIcons` (merge the two) | Minecraft hearts/hunger, WC3, a DOOM box |
| **Meter bar** — full-width bar with an inset value | hotbar XP bar | Minecraft XP, WC3 HP/mana |
| **Grid** — `rows × cols` cells of icon + value, frame style, selected cell | hotbar slots, generalised from 1×9 | Minecraft 1×9, WC3 command card 4×3 and inventory 2×3 |
| **Selection policy** — react to an event (`ouch`/`kill`/`evl` → socket), otherwise wander | `hotbar.js selectedSlot` | any grid |
| **Chat / feed** — scripted messages with conditions, timing, wrap | `chat.js` | Minecraft chat, WC3 chat / messages |
| **Portrait** — the mugshot as a placeable element | `face.js` + DOOM box | DOOM, WC3 unit portrait |
| **Width planner + fallback chain** | `render.js resolvePreset`, `[bar].fallback` | every layout |

Game chrome stays in the layout module: Minecraft's glyphs and frame colours, DOOM's box styling, WC3's
console frame.

### 4. Chat as data

- Script in the preset (or its own TOML next to it): `[[chat]] who = "me" | "a" | "join" | "adv", text = […]`.
- Conditions declarative instead of JS lambdas: `when = "ctxLeft <= 25"` (a tiny comparison grammar over
  facts: `== != < <= > >=`, `and`, `or`, presence). Nothing executable from config.
- `facts()` derived generically from `VALUES` (strip ANSI, numeric extraction) plus a small table of named
  derived facts, so a new metric is usable in a chat line without code changes.
- Speakers derived from data (the running model + configurable cast), not a hard-coded `FAMILY` list that
  goes stale with the next model generation.
- Users can add or replace conversations through the same user-level overlay as the slots.
- **Chat lines talk about sockets, not metrics.** 0.13.1 swapped hearts (now the 5h limit) and hunger (now
  context) in the preset, and had to rewrite four chat lines in `chat.js` in the same commit ("food" ↔
  "hearts"), because each line hard-codes which metric a gauge means. With facts like `{hearts}` /
  `{hunger}` resolved through the preset's binding, rebinding a gauge is a preset-only change and the chat
  follows by itself.

### 5. Chat: universal lines, game lines, and overrides (owner, 2026-10-31)

Every game feeds the chat with its own conversations. Three kinds of line:

| Kind | Example | Lives in |
|---|---|---|
| **Universal metric line**: asks or answers about a metric | "how full is your context?" / "context 42% full" | shared chat pack |
| **Game metric line**: the same fact in the game's voice | Minecraft: "how many hearts have you got?", "drink a potion!!" | the game's chat pack |
| **Game atmosphere line**: no metric, only atmosphere | Minecraft: diamonds, creepers, "whats the seed?" | the game's chat pack |

- Every metric line has a **key** (`ctx.ask`, `ctx.answer`, `limit5h.low`, …). A game line with the same key
  **overrides** the universal one, so a game only rewrites what it wants in its own voice and inherits the
  rest. Resolution order: user overlay > game pack > universal pack, the same rule as for presets.
- A new game starts with the universal pack plus a handful of its own atmosphere lines and is
  playable at once. Overrides come later, one key at a time.
- Each game also brings its **cast** (Minecraft: players joining and leaving; WC3: heroes and workers;
  DOOM: marines). "me" is always the running model.
- Today's Minecraft `SCRIPT` splits cleanly into three parts: metric lines in neutral wording go to the
  universal pack, the hearts / food / potion wording becomes Minecraft overrides, and the banter becomes
  Minecraft atmosphere.
- Atmosphere lines are written fresh in each game's spirit. Don't quote game dialogue.
- The chat is a render primitive, so a game whose original HUD has no chat (DOOM) can still put one in a box.

Open: who owns the **order** of the conversation? Either the game script is the skeleton and pulls
universal lines in by key (`use = "ctx"`), or universal lines are dealt automatically into the gaps between
game lines. The first gives the game full control of pacing; the second makes a new game cheaper to start.

## Warcraft III: what it would reuse

The WC3 bottom console maps well onto the kit, which is a good test that the split is right:

| WC3 console element | Metric idea | Primitive |
|---|---|---|
| Resource bar (gold, lumber, food / upkeep) | cost, tokens / savings, rate-limit tier | cell fit, small grid row |
| Day/night clock | `sys.clock` | game chrome + cell fit |
| Unit portrait | the mugshot (health = context / usage) | **portrait** (reused from DOOM) |
| HP and mana bars under the portrait | context left, 5h limit left | **meter bar** (reused from Minecraft XP) |
| Command card 4×3 | 12 user-chosen metrics | **grid** + **selection** (reused from Minecraft, new shape) |
| Inventory 2×3 | 6 more metrics or task list items | **grid** |
| Hero icons with HP/mana | subagents | `list` render + **gauge** |
| Minimap | activity over time | `spark` / `equalizer` |
| In-game messages | the chat | **chat** (reused) |

New work would be the console frame chrome, the resource-bar row, and whatever genuinely has no counterpart.
Artwork stays original (glyphs and colours drawn in code); as with the Minecraft theme, no game assets.

## Rename: `claude-doom-statusbar` → `claude-game-bar` (owner, 2026-10-31)

The game portfolio is growing, so the whole project, the npm package included, becomes **`claude-game-bar`**.
Checked on 31.10.2026: the name is free on npm (`npm view` → 404) and on GitHub (`99LevelsUp/claude-game-bar`
does not exist).

Rule for every "doom" in the tree: **universal code** drops it (neutral `game` / `gamebar` / `GAMEBAR_`);
**DOOM-specific code** keeps it. Inventory of the tracked tree as of `707e391`:

### Universal → rename

| What | Today | Becomes | Migration |
|---|---|---|---|
| Package, bin, repo | `claude-doom-statusbar` (package.json, bin/cli.js usage, README, `repository.url`) | `claude-game-bar` | keep `claude-doom-statusbar` as a second `bin` alias for a while; GitHub repo rename (GitHub redirects the old URL) |
| Description / keywords | "DOOM-inspired status bar…" | game-neutral description; keywords keep `doom` and add `minecraft`, `warcraft` | — |
| Env vars (17) | `DOOMBAR_PRESET`, `_THEME`, `_THEME_FILE`, `_TEXT_OVERFLOW`, `_INDENT`, `_EVENTS`, `_LLMLINGUA`, `_SAVINGS_STATE`, `_RATELIMITS`, `_RATELIMITS_SHARE`, `_REAP_TICK`, `_MSYS_REAP`, `_MSYS_REAP_AGE`, `_MSYS_REAP_MIN`, `_MSYS_TTL`, `_GIT_TTL`, `_JOURNAL_TTL` | `GAMEBAR_*` | one `env(name)` helper reads `GAMEBAR_x`, falls back to `DOOMBAR_x`; installer rewrites `env.DOOMBAR_PRESET` in settings.json |
| Theme choice file | `~/.claude/doombar-theme.json` | `~/.claude/gamebar-theme.json` | read the old file when the new one is missing; `theme` writes the new one and removes the old |
| Engine state in temp | `mugshot_<sid>.json`, `mugshot_git_*`, `mugshot_msys_*`, `mugshot_adv_*`, `mugshot_cpu.json`, `mugshot_ratehealth_global.json`, `mugshot_ratelimits_global.json`, `mugshot_reap_tick.json`; env `MUGSHOT_STATE` | `gamebar_*`, `GAMEBAR_STATE` | **the `mugshot_` prefix is the journal sweep's "this is ours" marker** (`hook.js staleStateFiles`): during the transition the sweep must recognise both prefixes, or old files stay forever |
| **Reaction channel encoded as DOOM sprite names** | `statusline.js spriteFor()` returns `STFOUCH2` / `STFGOD0` / `STFDEAD0`; `hotbar.js spriteExpr()` parses the reaction back out of the sprite name | a neutral state `{ expr: idle/ouch/kill/evl/tl/tr, hp: 0..4, god, dead }`; only the DOOM portrait maps it to `STF*` sprites | the biggest hidden doom-ism: any game (WC3 portrait) would otherwise have to speak DOOM sprite names |
| Comments in engine code | `fold.js` "reducer for the DOOM HUD state", `hook.js` "event recorder for the DOOM HUD", `statusline.js` header, `hotbar.js` sprite comments | "game bar" | — |
| Render demo values | `render.js` `"doom-hud-demo"`, `"claude-doom-statusbar"` | neutral | — |
| Tests | temp prefixes `doombar-*`, `doomtest`; every test pins `DOOMBAR_THEME=doom` | `gamebar-*`; `GAMEBAR_THEME=doom` (the value stays: doom is a theme) | — |
| Project files | `CLAUDE.md` title and overview, this repo's `.claude/settings.local.json` (`DOOMBAR_PRESET`, absolute paths), local dir name, auto-memory | updated with the rename | `.claude/settings.local.json` drives the live bar: re-wire before moving the repo dir |

Installer note: ownership detection matches path suffixes (`HOOK_MARKS = src/hook.js`, `SL_MARKS =
src/statusline.js`), not the package name, so `claude-game-bar install` already recognises and replaces
entries written by the old package. `test/installer.test.mjs` has an old-cache-path case; extend it with
`claude-doom-statusbar/…` → `claude-game-bar/…`.

### DOOM-specific → keep `doom`

- The theme name `doom` (`THEMES.doom`), the default theme.
- The DOOM presets `full` / `standard` / `minimal` (candidates for `presets/doom/` once other games ship
  several sizes).
- `src/face.js`, the `STF*` sprite names, `assets/images/mugshot/`, `assets/images/hud.png`. "Mugshot" is
  DOOM's own name for the face, so it stays inside the DOOM layout; the shared kit calls it **portrait**.
- README's DOOM section and the id Software credit.
- History is not rewritten: `CHANGELOG.md` entries, `docs/ideation/2026-06-06-doom-statusbar-ideation.md`
  and other dated docs keep their names and wording.

### npm migration

1. First release under `claude-game-bar`. **Trusted publishing (OIDC) is configured per package on
   npmjs.com**, so the new package must be set up there (it may need one manual first publish) before
   the CI pipeline can release it. Verify before relying on `npm version`.
2. A final `claude-doom-statusbar` release prints a one-line notice pointing to `claude-game-bar`, then
   `npm deprecate claude-doom-statusbar "renamed to claude-game-bar"`.
3. `claude-game-bar install` migrates in place: settings entries (path-suffix detection above), env var
   names, theme file.
4. Fallbacks for `DOOMBAR_*`, `doombar-theme.json` and the `mugshot_` prefix stay for a few releases, then
   go in a release that says so in the changelog.

Coordinate with the contributor: this touches every file they work in, so do it between their changes,
not during one.

## Phasing

0. **Agree with the contributor** — this reshapes the files they own; do it together.
1. **Pin today's output.** Snapshot tests of the Minecraft HUD at several widths (plus the DOOM presets), so
   the rename and the refactor are provably output-neutral where intended.
2. **Rename to `claude-game-bar`** (section above), before the refactor, so the new modules are born with
   neutral names and the sprite-name reaction channel is replaced by the neutral state first.
3. **Layout registry** and the **user-level preset overlay** (slots survive updates).
4. **Extract the kit** from `hotbar.js` / `render.js`: cell fit, gauge, meter, grid, selection. Merge
   `rIcons` and `glyphCells`. No visible change except the escape-safe clipping.
5. **Unify behaviour:** hotbar goes through the shared width planner, `[bar].fallback` and `text_overflow`.
6. **Chat as data** with declarative conditions and generic facts; split today's script into the universal
   pack, Minecraft overrides and Minecraft atmosphere.
7. **Warcraft III** layout on top of the kit.

## Open questions

- Does the hotbar's fallback mean "drop slots from the right" (today) or "switch to a narrower preset" (DOOM)?
  Probably both: the layout degrades internally first, then the shared chain takes over.
- Overlay merge rules for arrays (`[[slot]]`, `[[chat]]`): replace whole, or by index / key?
- Should a theme be able to ship several presets (full / standard / minimal) like DOOM, so `--preset` keeps
  meaning something under every theme?
- Where does the portrait's health come from in WC3: the same `hpRow` logic as the DOOM mugshot (yes, most
  likely), and is the portrait a DOOM face or an original WC3-style one?
