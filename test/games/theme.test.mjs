#!/usr/bin/env node
// Themes: the live switch (`theme`, the older name of `skin`), and the theme a
// release before skins saved. The Minecraft skin itself is pinned in minecraft-skin.test.mjs, its
// chat in test/kit/chat.test.mjs.
import "../_temp-sandbox.mjs"; // before the modules that name temp paths
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.join(HERE, "..");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// End to end: `theme` is the older name of `skin`. It saves the skin choice (skin.json in the user
// directory), and the statusline picks it up on the next render. A game's name chooses its default
// skin.
const tmp = mkdtempSync(path.join(os.tmpdir(), "gamebar-theme-"));
try {
  // TEMP/TMP/TMPDIR -> tmp: the render's state files land here, not in the real temp dir; the user
  // directory is tmp/user.
  const env = { ...process.env, GAMEBAR_THEME_FILE: path.join(tmp, "theme.json"), COLUMNS: "220",
    ...sandboxEnv(tmp), GAMEBAR_MSYS_REAP: "0" };
  for (const k of ["GAMEBAR_THEME", "DOOMBAR_THEME", "GAMEBAR_SKIN", "DOOMBAR_SKIN", "GAMEBAR_PRESET", "DOOMBAR_PRESET"]) delete env[k];
  const skinFile = path.join(env.GAMEBAR_USER_DIR, "skin.json");
  const saved = () => (existsSync(skinFile) ? JSON.parse(readFileSync(skinFile, "utf8")).skin : null);
  const cli = (...a) => execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "theme", ...a], { env, encoding: "utf8" });
  const skinCli = (...a) => execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "skin", ...a], { env, encoding: "utf8" });
  const render = () => strip(execFileSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
    env, encoding: "utf8", input: JSON.stringify({ session_id: `theme-test-${process.pid}`, cwd: tmp, model: { display_name: "Opus" } }),
  }));
  const out = cli("minecraft");
  ok(saved() === "minecraft" && render().includes("━"), "theme minecraft saves the minecraft skin -> statusline renders the hotbar HUD");
  ok(out === skinCli("minecraft"), "and prints what skin minecraft prints");
  ok(!existsSync(env.GAMEBAR_THEME_FILE), "theme writes no theme file");
  cli("next");
  ok(saved() === "minecraft-compact", `theme next goes to Minecraft's low skin, the last one (${saved()})`);
  cli("next");
  ok(saved() === "doom-full" && render().includes("MODEL"), `theme next after the last skin wraps to the first, doom's (${saved()})`);
  cli("next");
  ok(saved() === "doom-standard", `theme next goes on through the skins (${saved()})`);
  cli("minecraft-hud");
  ok(saved() === "minecraft", "old name minecraft-hud -> saved as the minecraft skin");
  ok(cli("list") === skinCli("list") && cli() === skinCli(), "theme and theme list list the skins, as skin does");
  let threw = false;
  try { execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "theme", "satisfactory"], { env, stdio: "pipe" }); } catch { threw = true; }
  ok(threw && saved() === "minecraft", "unknown (or removed) theme is rejected and nothing is saved");

  // The theme file a release before skins saved is still read while no skin is chosen.
  rmSync(skinFile);
  writeFileSync(env.GAMEBAR_THEME_FILE, JSON.stringify({ theme: "minecraft-hud" }));
  ok(render().includes("━"), "a saved 0.12.x choice (minecraft-hud) still renders the hotbar");
  writeFileSync(env.GAMEBAR_THEME_FILE, JSON.stringify({ theme: "satisfactory" }));
  ok(render().includes("MODEL"), "a saved theme that no longer exists falls back to doom");
  writeFileSync(env.GAMEBAR_THEME_FILE, JSON.stringify({ theme: "minecraft" }));
  cli("doom");
  ok(render().includes("MODEL") && JSON.parse(readFileSync(env.GAMEBAR_THEME_FILE, "utf8")).theme === "minecraft",
    "a chosen skin wins over the saved theme, and the theme file is left as it is");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// The theme under its old names: the DOOMBAR_THEME variable, and the theme file a release before
// 1.0.0 saved (~/.claude/doombar-theme.json). The home directory is a sandbox, and no theme file is
// named, so the default places are used.
const home = mkdtempSync(path.join(os.tmpdir(), "gamebar-theme-home-"));
try {
  const env = { ...process.env, ...sandboxEnv(home), HOME: home, USERPROFILE: home, COLUMNS: "220", GAMEBAR_MSYS_REAP: "0" };
  for (const k of ["GAMEBAR_THEME", "DOOMBAR_THEME", "GAMEBAR_THEME_FILE", "DOOMBAR_THEME_FILE", "GAMEBAR_SKIN", "DOOMBAR_SKIN",
    "GAMEBAR_PRESET", "DOOMBAR_PRESET"]) delete env[k];
  const childHome = execFileSync(process.execPath, ["--input-type=module", "-e", "import os from 'node:os'; process.stdout.write(os.homedir())"],
    { env, encoding: "utf8" });
  if (path.resolve(childHome) !== path.resolve(home)) {
    ok(false, `the sandbox home is not the child's home (${childHome}): the old-file checks are skipped`);
  } else {
    const claudeDir = path.join(home, ".claude");
    const newFile = path.join(claudeDir, "gamebar-theme.json"), oldFile = path.join(claudeDir, "doombar-theme.json");
    const cli = (...a) => execFileSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "theme", ...a], { env, encoding: "utf8" });
    const render = (extra = {}) => strip(execFileSync(process.execPath, [path.join(ROOT, "src", "statusline.js")], {
      env: { ...env, ...extra }, encoding: "utf8",
      input: JSON.stringify({ session_id: `theme-old-${process.pid}`, cwd: home, model: { display_name: "Opus" } }),
    }));
    const saved = () => execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { currentTheme } from ${JSON.stringify(new URL("../../src/theme.js", import.meta.url).href)}; process.stdout.write(currentTheme())`],
    { env, encoding: "utf8" });

    ok(render({ DOOMBAR_THEME: "minecraft" }).includes("━"), "only DOOMBAR_THEME=minecraft set -> the bar renders Minecraft");
    ok(render({ GAMEBAR_THEME: "doom", DOOMBAR_THEME: "minecraft" }).includes("MODEL"), "both names set -> GAMEBAR_THEME wins");

    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(oldFile, JSON.stringify({ theme: "minecraft" }) + "\n");
    ok(saved() === "minecraft" && render().includes("━"), "only the old theme file says minecraft -> the saved theme is minecraft");
    writeFileSync(newFile, JSON.stringify({ theme: "doom" }) + "\n");
    ok(saved() === "doom" && render().includes("MODEL"), "with both files, the new one wins");
    rmSync(newFile);

    // The old package may still run and read the old file, so choosing a skin never touches it.
    cli("doom");
    ok(existsSync(oldFile) && JSON.parse(readFileSync(oldFile, "utf8")).theme === "minecraft" && !existsSync(newFile),
      "theme doom leaves the old theme file as it is and writes no new one");
    ok(render().includes("MODEL"), "and the chosen skin wins over the old file's minecraft");
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
