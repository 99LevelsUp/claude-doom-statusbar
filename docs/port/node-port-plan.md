# Node/npm port plan

Rewrite claude-doom-statusbar from Python to Node.js, distributed via npm/npx. Get rid of Python.

## Method

Port **bottom-up, one module at a time**, keeping the Python files as the reference. After each module, run a **parity test**: same input → JS output must match Python output (ANSI bytes or stripped text). Only delete the Python once the whole HUD + hook match end-to-end.

## Decisions

- **Node**: ESM (`"type": "module"`), Node 26 confirmed present. `#!/usr/bin/env node` shebangs.
- **Runtime deps**: a small TOML parser (`smol-toml`) for presets. Nothing else native.
- **chafa**: stays an external binary (optional), spawned via `child_process`. Same fallback to pre-rendered `.ans` when absent.
- **Image lib**: NONE at runtime. The only Python image work was `alpha_sprite` (magenta→transparent via PIL). We **pre-bake the transparent sprites once** (commit them) so Node just feeds them to chafa. No sharp/jimp.
- **System metrics**: Node built-ins — `os.totalmem/freemem` (RAM), `os.cpus()` delta (CPU, cached like Python), `fs.statfsSync` (disk). No native dep.
- **Assets/presets stay**: `assets/` (PNG + `.ans`) and `presets/*.toml` are language-agnostic; reused as-is.

## File mapping (Python → Node)

| Python | Node | Notes |
|---|---|---|
| `tools/render_preset.py` | `src/render.js` | render engine: vlen, bars, sparks (octant/braille tables verbatim), list, OSC8, centering, compact fallback, build_bar |
| `tools/mockup_boxes.py` | `src/face.js` | chafa spawn + ANSI parse → (char,fg,bg) rows; `.ans` fallback; face_cell compositing |
| `statusline.py` | `src/statusline.js` | bin: stdin JSON → values (git, sys, advisor transcript, god flash, links, _dur) → sprite_for → render |
| `hooks/mugshot_hook.py` | `src/hook.js` | bin: stdin event → fold (spans/squad/pending/tasks/errors) → state file |
| `install.py` | `bin/cli.js` | `install` / `uninstall`; also the `npx` entry; writes `node <path>` commands into settings.json |

## Distribution

- `package.json` with `bin`: `claude-doom-statusbar` → `bin/cli.js` (installer/configurator).
- Install for users: `npx claude-doom-statusbar install` (or `npm i -g` then the command). The installer resolves the package's own absolute path and writes `node "<pkg>/src/statusline.js"` as the statusLine command + the hook commands into `~/.claude/settings.json` (merge-safe, idempotent — port of the Python installer's logic, already validated).
- **Updates**: `npm i -g claude-doom-statusbar@latest` / `npx claude-doom-statusbar@latest`. (npm registry + semver; publishing is the maintainer's step.)

## Work order

1. [ ] scaffold: `package.json` (ESM, bin, smol-toml dep), `src/`, `.gitignore` node_modules
2. [ ] `src/render.js` + parity test vs `render_preset.py` (SAMPLE)
3. [ ] pre-bake transparent sprites (one-time) → commit; `src/face.js` + parity test
4. [ ] `src/statusline.js` + parity test (sample stdin JSON, both produce same HUD)
5. [ ] `src/hook.js` + parity test (events → same state file)
6. [ ] `bin/cli.js` installer + test against a temp settings.json
7. [ ] README + docs: Node/npx install & update instructions
8. [ ] delete Python (`*.py`, tomllib usage, PIL build tool) once parity holds end-to-end
9. [ ] (maintainer) publish to npm

## Parity-test harness

For each module: a Node script and the Python original run on identical inputs; compare. Keep Python importable during the port. Strip nothing for byte-exact checks; strip ANSI for layout checks.
