# claude-doom-statusbar

A DOOM-inspired status bar for the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI. Your session, read off the Doomguy HUD: a mugshot whose face tracks your health, boxes for usage, model, project and system, and a live list of running subagents.

<p align="center">
  <img src="assets/images/hud.png" alt="claude-doom-statusbar HUD: MODEL, USAGE, PROJECT, the DOOM mugshot, ACTIVITY, SUBAGENTS and SYS boxes">
</p>

The mugshot is the real DOOM (1993) status-face sprite, rasterised into the terminal at runtime — not ASCII art of it.

## What it shows

The HUD is a row of boxes centred on the mugshot. Each box is configurable; the `full` preset turns everything on:

- **mugshot** — the Doomguy face. Its HP (how bloodied it looks) follows your *usage headroom* — `min(5h, 7d) rate-limit room`, context as a fallback. It glances around when idle, winces on errors, snarls on writes, grins on a clean finish, dies when you're tapped out, and flashes invulnerable just after an advisor consult.
- **MODEL** — model name + reasoning effort (a waxing-moon→sun icon), thinking/fast toggles, output style, and the configured `/advisor` model.
- **USAGE** — context window (HP bar), the 5h / 7d rate-limit bars (with reset countdowns), RAM, session cost.
- **PROJECT** — cwd, git branch, ahead/behind, dirty count, lines added/removed, PR state.
- **ACTIVITY** — a tool-activity "geiger" sparkline (duty-cycle over the last 30 s), running-subagent count, task progress, error count.
- **SUBAGENTS** — a live list of running subagents (type/description + ticking runtime), always visible, widening to fit.
- **SYS** — CPU, disk, session length, wall clock.

Anything the session can't supply is hidden automatically, so the same config degrades cleanly.

## Requirements

- **Python 3.11+** (uses the stdlib `tomllib`).
- **[chafa](https://hpjansson.org/chafa/)** — *optional*. With it, the mugshot rasterises at any height. Without it, the HUD falls back to pre-rendered ANSI faces (heights 4–16, clamped to the nearest), so the mugshot still draws.
- A terminal with **truecolor** and **legacy-computing glyph** support (the mugshot and fine bars use Unicode block/sextant/octant glyphs). Windows Terminal, WezTerm, kitty, foot all work.
- Optional: **[psutil](https://pypi.org/project/psutil/)** for the SYS box. Falls back to stdlib (`shutil.disk_usage`, Windows ctypes RAM, cached-delta CPU) when absent.

## Install

```bash
git clone https://github.com/99LevelsUp/claude-doom-statusbar.git
```

Then point Claude Code at it in `~/.claude/settings.json` (use the absolute path to your clone):

```json
{
  "env": { "DOOMBAR_PRESET": "/abs/path/claude-doom-statusbar/presets/full.toml" },
  "statusLine": {
    "type": "command",
    "command": "python /abs/path/claude-doom-statusbar/statusline.py",
    "refreshInterval": 1
  },
  "hooks": {
    "PreToolUse":         [{ "hooks": [{ "type": "command", "command": "python /abs/path/claude-doom-statusbar/hooks/mugshot_hook.py" }] }],
    "PostToolUse":        [{ "hooks": [{ "type": "command", "command": "python /abs/path/claude-doom-statusbar/hooks/mugshot_hook.py" }] }],
    "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "python /abs/path/claude-doom-statusbar/hooks/mugshot_hook.py" }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "python /abs/path/claude-doom-statusbar/hooks/mugshot_hook.py" }] }],
    "PermissionDenied":   [{ "hooks": [{ "type": "command", "command": "python /abs/path/claude-doom-statusbar/hooks/mugshot_hook.py" }] }],
    "SubagentStart":      [{ "hooks": [{ "type": "command", "command": "python /abs/path/claude-doom-statusbar/hooks/mugshot_hook.py" }] }],
    "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "python /abs/path/claude-doom-statusbar/hooks/mugshot_hook.py" }] }]
  }
}
```

The `statusLine` alone gives you the boxes and the HP/idle face. The hooks add the live reactions, the geiger, and the subagent list — drop them if you only want the static HUD.

## Presets

`DOOMBAR_PRESET` picks the layout (defaults to `presets/default.toml`):

- **`minimal`** — a couple of bars, blends into the terminal.
- **`default`** — balanced HUD.
- **`full`** — every box, the look in the screenshot above.

A preset is TOML: a `[bar]` style block, a `[mugshot]` block, and a list of `[[segment]]` boxes. Each box lists metrics with a render type — `bar`, `number`, `text`, `spark`, `ammo`, `list`, or a `group`. Copy one and rearrange the boxes, swap icons, or change which metrics show.

## How it works

- **`statusline.py`** is the statusLine command. Claude Code pipes session JSON on stdin; it maps that (plus git via shell, system metrics, and the hook state file) to metric values, picks the mugshot sprite, and renders the preset.
- **`hooks/mugshot_hook.py`** is an event bus. Lifecycle hooks write a small state file (face reaction with decay, tool-run intervals for the geiger, the running-subagent squad). The status line reads it on each refresh — the two never block each other.
- **`tools/render_preset.py`** is the rendering engine; **`tools/mockup_boxes.py`** bakes the mugshot via chafa.

See [`docs/ideation/`](docs/ideation/) for the full design write-up.

## Credits

- The status-face sprites are from **DOOM** (1993), id Software.
- Mugshot rasterisation by **[chafa](https://hpjansson.org/chafa/)** (Hans Petter Jansson).

## License

[MIT](LICENSE).
