#!/usr/bin/env node
// Which skin a session draws (src/skin-select.js): the session's GAMEBAR_SKIN, then the saved
// choice, then the choice a release before skins left behind (the theme picks the game, the file
// name of the preset setting picks its size), then the default game's default skin. The selection
// is checked by the skin name it returns, against two test-only games: ./fixture-game (one skin,
// reads no presets) and ./fixture-sized (two sizes, reads presets).
//
// The second half runs the command line (bin/cli.js) in a sandbox home directory: `install` saves
// the choice and drops the preset setting it wrote, `skin <name|next|list>` switches, and `skin`
// says when a setting of the user's or the project's draws something else there. It uses the
// bundled games, since the command runs in its own process.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const fwd = (p) => p.replace(/\\/g, "/");

const SB = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gamebar-skin-select-")));
const USER = path.join(SB, "user");
// Before the imports: nothing in this process reads or writes the real user directory.
Object.assign(process.env, sandboxEnv(SB), { GAMEBAR_USER_DIR: USER });
for (const k of Object.keys(process.env)) {
  if (/^(GAMEBAR|DOOMBAR)_(SKIN|PRESET|THEME|THEME_FILE)$/i.test(k)) delete process.env[k];
}

const { GAMES, readGame, defaultGame, bundledSkins } = await import("../../src/games/index.js");
const { selectSkin, findSkin, listSkins, nextSkin, saveSkin, savedSkin, userDir } = await import("../../src/skin-select.js");

const FIXTURE = readGame(path.join(HERE, "fixture-game"));
const SIZED = readGame(path.join(HERE, "fixture-sized"));
const THEME_FILE = path.join(SB, "theme.json");
const base = { GAMEBAR_USER_DIR: USER, GAMEBAR_THEME_FILE: THEME_FILE };
const theme = (name) => writeFileSync(THEME_FILE, JSON.stringify({ theme: name }) + "\n");
const reset = () => { rmSync(THEME_FILE, { force: true }); rmSync(path.join(USER, "skin.json"), { force: true }); };
const select = (env = {}) => selectSkin({ ...base, ...env });
const userSkin = (name, from = path.join(ROOT, "test", "fixtures", "skins", "fit-narrow.toml")) => {
  mkdirSync(path.join(USER, "skins", name), { recursive: true });
  copyFileSync(from, path.join(USER, "skins", name, `${name}.toml`));
};
// Where an installation before skins pointed its preset setting: a package's old presets folder.
const OLD_PRESETS = path.join(SB, "old-package", "presets");

function withGames(fn) {
  GAMES.push(FIXTURE, SIZED);
  try { return fn(); } finally { GAMES.splice(GAMES.indexOf(FIXTURE), 2); }
}

try {
  ok(userDir(base) === USER, "the user directory follows GAMEBAR_USER_DIR (every check below stays in the sandbox)");
  ok(userDir({}) === path.join(os.homedir(), ".claude", "claude-game-bar"), "and is ~/.claude/claude-game-bar without it");
  ok(FIXTURE.name === "fixture" && FIXTURE.skins.map((s) => s.name).join(",") === "fixture" && !FIXTURE.readsPresets,
    "the fixture game reads as a game with one skin that reads no presets");
  ok(SIZED.readsPresets && SIZED.skins.map((s) => s.name).join(",") === "sized-full,sized-minimal",
    "the sized fixture game reads presets and has two skins");

  withGames(() => {
    // An update arrives: a saved game choice of a game that reads no presets, with the preset the
    // installer wrote, draws that game's skin and warns about nothing.
    reset();
    theme("fixture");
    let s = select({ GAMEBAR_PRESET: path.join(OLD_PRESETS, "full.toml") });
    ok(s.name === "fixture" && s.warnings.length === 0, `saved theme fixture + the installer's full.toml -> fixture, no warning (${s.name}, ${s.warnings.length})`);
    ok(s.file === path.join(HERE, "fixture-game", "skins", "fixture.toml"), "and the selection carries the skin's file");
    theme("fixture-old");
    ok(select().name === "fixture", "a saved alias of the game picks it too");
    ok(select({ GAMEBAR_THEME: "sized", GAMEBAR_PRESET: path.join(OLD_PRESETS, "fixture.toml") }).name === "sized-full",
      "GAMEBAR_THEME wins over the saved theme");

    // The preset's file name picks the size of a game that reads presets.
    reset();
    theme("sized");
    s = select({ GAMEBAR_PRESET: path.join(OLD_PRESETS, "minimal.toml") });
    ok(s.name === "sized-minimal" && s.warnings.length === 0, `theme sized + an old path to minimal.toml -> sized-minimal (${s.name})`);
    ok(select().name === "sized-full", "theme sized without a preset -> its default skin");

    // A preset of the user's own: the default skin, with a warning naming the file.
    const mine = path.join(os.homedir(), "my.toml");
    s = select({ GAMEBAR_PRESET: mine });
    ok(s.name === "sized-full" && s.warnings.length === 1 && s.warnings[0].message.includes(mine),
      `theme sized + ~/my.toml -> sized-full with a warning naming the file (${s.warnings.map((w) => w.message).join("; ")})`);
    rmSync(THEME_FILE);
    s = select({ GAMEBAR_PRESET: mine });
    ok(s.name === defaultGame().defaultSkin && s.warnings.length === 1 && s.warnings[0].message.includes(mine),
      `no theme + ~/my.toml -> the default game's default skin (${s.name}) with a warning naming the file`);
    ok(typeof s.warnings[0].key === "string" && s.warnings[0].key === select({ GAMEBAR_PRESET: mine }).warnings[0].key,
      "the warning has a key that stays the same from render to render");
    s = select();
    ok(s.name === defaultGame().defaultSkin && s.warnings.length === 0, "nothing chosen at all -> the default game's default skin");

    // The session's own skin wins over the saved one; another session draws the saved one.
    reset();
    saveSkin("sized-minimal", base);
    ok(savedSkin(base) === "sized-minimal", "a saved skin reads back");
    ok(select({ GAMEBAR_SKIN: "fixture" }).name === "fixture", "a session with GAMEBAR_SKIN=fixture draws fixture");
    ok(select({ DOOMBAR_SKIN: "fixture" }).name === "fixture", "and so does one that sets only the old name");
    ok(select().name === "sized-minimal", "another session draws the saved sized-minimal");
    theme("fixture");
    ok(select().name === "sized-minimal", "the saved skin wins over the saved theme");

    // A project wired with a size before skins keeps that size over the saved choice.
    saveSkin("sized-full", base);
    ok(select({ GAMEBAR_PRESET: path.join(OLD_PRESETS, "minimal.toml") }).name === "sized-minimal",
      "saved sized-full + the project's minimal.toml -> sized-minimal");
    ok(select({ GAMEBAR_PRESET: path.join(OLD_PRESETS, "minimal.toml"), GAMEBAR_SKIN: "sized-full" }).name === "sized-full",
      "but not over the session's own GAMEBAR_SKIN");
    saveSkin("fixture", base);
    s = select({ GAMEBAR_PRESET: path.join(OLD_PRESETS, "minimal.toml") });
    ok(s.name === "fixture" && s.warnings.length === 0, "a saved skin of a game that reads no presets ignores the preset");

    // A name that draws nothing.
    s = select({ GAMEBAR_SKIN: "nope" });
    ok(s.name === "fixture" && s.warnings.some((w) => w.message.includes("nope")),
      "an unknown GAMEBAR_SKIN warns and the saved choice is drawn");
    saveSkin("gone", base);
    s = select();
    ok(s.name === "fixture" && s.warnings.some((w) => w.message.includes("gone")),
      "an unknown saved skin warns and the saved theme's game is drawn");
    ok(select({ GAMEBAR_SKIN: "../fixture-game/skins/fixture" }).name !== "../fixture-game/skins/fixture",
      "a name that is a path is no skin");

    // User skins: under skins/<name>/<name>.toml in the user directory, never in a bundled skin's name.
    reset();
    userSkin("zz-mine");
    userSkin("fixture");
    s = select({ GAMEBAR_SKIN: "zz-mine" });
    ok(s.name === "zz-mine" && s.file === path.join(USER, "skins", "zz-mine", "zz-mine.toml") && s.game === null,
      "a user skin is found in the user directory");
    ok(select({ GAMEBAR_SKIN: "fixture" }).file === FIXTURE.skins[0].file, "a user skin cannot take a bundled skin's name");
    ok(findSkin("sized", base)?.name === "sized-full", "a game's name finds its default skin");

    // The order `skin next` cycles: the bundled skins in registry order, then the user's.
    const names = listSkins(base).map((x) => x.name);
    const bundled = bundledSkins().map((x) => x.name);
    ok(JSON.stringify(names) === JSON.stringify([...bundled, "zz-mine"]),
      `the skin list is the bundled skins in registry order, then the user's (${names.join(", ")})`);
    ok(bundled.slice(-3).join(",") === "fixture,sized-full,sized-minimal" && bundled.length === new Set(bundled).size,
      "the bundled list follows the registry, game by game, with no name twice");
    ok(nextSkin(bundled[0], base) === bundled[1], "next after the first bundled skin is the second");
    ok(nextSkin("sized-minimal", base) === "zz-mine", "next after the last bundled skin is the first user skin");
    ok(nextSkin("zz-mine", base) === bundled[0], "next after the last user skin wraps to the first bundled skin");
  });
  ok(!GAMES.includes(FIXTURE) && !GAMES.includes(SIZED), "the fixture games are out of the registry again");

  // A bundled game names its skins in its manifest; a skin it names but ships no file for yet is still
  // a skin, drawn by the old layout until its file arrives.
  for (const g of GAMES) {
    ok(g.skins.some((x) => x.name === g.defaultSkin), `${g.name}: its default skin is one of its skins`);
  }
} finally {
  reset();
  rmSync(path.join(USER, "skins"), { recursive: true, force: true });
}

// --- The command line --------------------------------------------------------------------------
{
  const G = GAMES.find((g) => g.readsPresets && g.presetSkins.full && g.presetSkins.minimal);
  const FULL = G.presetSkins.full, MINIMAL = G.presetSkins.minimal;
  const home = path.join(SB, "home"), proj = path.join(SB, "proj");
  for (const d of [path.join(home, ".claude"), path.join(proj, ".claude")]) mkdirSync(d, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GAMEBAR|DOOMBAR|MUGSHOT)_/i.test(k)
    && !/^(HOME|USERPROFILE)$/i.test(k)));
  Object.assign(env, sandboxEnv(SB), { HOME: home, USERPROFILE: home, GAMEBAR_USER_DIR: USER, GAMEBAR_NO_FONTS: "1",
    GAMEBAR_THEME_FILE: THEME_FILE });
  const cli = (cwd, ...args) => execFileSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  const refused = (cwd, ...args) => { try { cli(cwd, ...args); return false; } catch { return true; } };
  const settings = (f) => JSON.parse(readFileSync(f, "utf8"));
  const userSettings = path.join(home, ".claude", "settings.json");
  const homeIsSandboxed = fwd(execFileSync(process.execPath, ["-p", "require('node:os').homedir()"], { env, encoding: "utf8" }).trim()) === fwd(home);
  const presetOf = (size) => fwd(G.presets[size]);

  if (!homeIsSandboxed) {
    ok(false, "the child process sees the sandbox home directory (skipping the command line checks)");
  } else {
    // A user-level install made before skins, with the minimal preset: install keeps the size as the
    // saved skin and drops the preset setting it wrote.
    writeFileSync(userSettings, JSON.stringify({ env: { GAMEBAR_PRESET: presetOf("minimal"), MY_VAR: "keep" } }, null, 2));
    let out = cli(proj, "install");
    let cfg = settings(userSettings);
    ok(!("GAMEBAR_PRESET" in cfg.env) && !("GAMEBAR_SKIN" in cfg.env) && cfg.env.MY_VAR === "keep",
      `a user-level install drops the preset it wrote and writes no GAMEBAR_SKIN (${JSON.stringify(cfg.env)})`);
    ok(savedSkin(base) === MINIMAL && out.includes(MINIMAL), `and saves the size it drew as the skin (${savedSkin(base)})`);
    const before = readFileSync(userSettings, "utf8");
    cli(proj, "install");
    ok(readFileSync(userSettings, "utf8") === before && savedSkin(base) === MINIMAL, "re-running install changes nothing");

    out = cli(proj, "skin", FULL);
    ok(savedSkin(base) === FULL && !/note/.test(out), `skin ${FULL} saves it and has nothing to note (${out.trim()})`);
    ok(selectSkin({ ...base, ...settings(userSettings).env }).name === FULL, "sessions with the user settings draw it");
    out = cli(proj, "install", "--skin", MINIMAL);
    ok(settings(userSettings).env.GAMEBAR_SKIN === MINIMAL && savedSkin(base) === MINIMAL,
      "a user-level install --skin saves the skin and writes it into the settings");
    out = cli(proj, "skin", FULL);
    ok(out.includes("GAMEBAR_SKIN") && out.includes(userSettings), `then skin ${FULL} says the user settings' GAMEBAR_SKIN overrides it (${out.trim()})`);
    cli(proj, "install", "--skin", FULL);
    delete (cfg = settings(userSettings)).env.GAMEBAR_SKIN;
    writeFileSync(userSettings, JSON.stringify(cfg, null, 2));

    // A project installed with --local --skin: its setting shadows the saved choice there.
    out = cli(proj, "install", "--local", "--skin", MINIMAL);
    const local = path.join(proj, ".claude", "settings.local.json");
    ok(settings(local).env.GAMEBAR_SKIN === MINIMAL && !("GAMEBAR_PRESET" in settings(local).env),
      "install --local --skin writes GAMEBAR_SKIN, no preset, into settings.local.json");
    ok(savedSkin(base) === FULL, "and leaves the saved choice alone");
    out = cli(proj, "skin", FULL);
    ok(out.includes("GAMEBAR_SKIN") && out.includes(local) && out.includes(MINIMAL),
      `skin ${FULL} run in that project says its GAMEBAR_SKIN draws ${MINIMAL} there (${out.trim()})`);
    out = cli(home, "skin", FULL);
    ok(!/note/.test(out), "run elsewhere, it has nothing to note");
    cli(proj, "uninstall", "--local");
    ok(!("env" in settings(local)) || !("GAMEBAR_SKIN" in settings(local).env), "uninstall --local removes GAMEBAR_SKIN");

    // A project wired with the minimal preset before skins draws minimal over the saved full skin.
    const project = path.join(proj, ".claude", "settings.json");
    writeFileSync(project, JSON.stringify({ env: { GAMEBAR_PRESET: presetOf("minimal") } }, null, 2));
    ok(selectSkin({ ...base, ...settings(project).env }).name === MINIMAL, `that project draws ${MINIMAL} over the saved ${FULL}`);
    out = cli(proj, "skin", FULL);
    ok(out.includes("GAMEBAR_PRESET") && out.includes(project), `skin ${FULL} run there says the project's preset overrides it (${out.trim()})`);
    cli(proj, "install", "--project");
    ok(settings(project).env.GAMEBAR_SKIN === MINIMAL && !("GAMEBAR_PRESET" in settings(project).env),
      "install --project turns that preset into the project's GAMEBAR_SKIN");
    rmSync(project);

    // skin next and skin list: the bundled skins in registry order, then the user's.
    userSkin("zz-mine");
    const all = [...bundledSkins().map((x) => x.name), "zz-mine"];
    cli(home, "skin", all[all.length - 2]);
    cli(home, "skin", "next");
    ok(savedSkin(base) === "zz-mine", `skin next after the last bundled skin is the user's skin (${savedSkin(base)})`);
    cli(home, "skin", "next");
    ok(savedSkin(base) === all[0], `and then the first bundled skin (${savedSkin(base)})`);
    const list = cli(home, "skin", "list");
    const at = all.map((n) => list.indexOf(` ${n} `));
    ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), `skin list shows every skin in that order:\n${list}`);
    ok(cli(home, "skin") === list, "skin with no name lists them too");
    ok(refused(home, "skin", "nope") && savedSkin(base) === all[0], "an unknown skin is refused and nothing is saved");
    ok(refused(home, "install", "--skin", "nope"), "install --skin with an unknown skin is refused");

    // A user-level uninstall forgets the saved skin.
    cli(proj, "uninstall");
    ok(!existsSync(path.join(USER, "skin.json")), "a user-level uninstall removes skin.json");
  }
}

rmSync(SB, { recursive: true, force: true });
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
