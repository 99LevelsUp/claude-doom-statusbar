#!/usr/bin/env node
// What the main npm package ships, and how each game's assets package lines up with its manifest.
//
// Game assets are not part of the main package: they are published as their own packages
// (@claude-game-bar/<game>, from packages/<game>/) and installed on demand. So the main package
// lists no packages/ folder and no image under src/. The listing comes from `npm pack --dry-run`, which
// reads the disk, so a stray image left under src/ fails here even when git does not track it.
//
// A game's manifest pins the version of its assets package; a release that changes the assets bumps
// both together, so the version in packages/<game>/package.json is the one the manifest pins.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "../../src/install/old-package.js";
import { GAMES } from "../../src/games/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

// The paths of a package listing that must not ship: a game's assets folder or an image under src/.
const forbidden = (paths) => paths.filter((p) => /^packages\//.test(p) || (/^src\//.test(p) && /\.png$/i.test(p)));

// The file paths `npm pack --dry-run --json` lists. npm 10 prints an array of packages, npm 11 and
// later an object keyed by the package name.
function packedPaths() {
  const env = { ...process.env };
  for (const k of ["GAMEBAR_NPM", "DOOMBAR_NPM"]) delete env[k]; // the real npm, not a test's stand-in
  const r = runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], { env, cwd: ROOT });
  if (r.status !== 0) throw new Error(`npm pack --dry-run exited ${r.status}: ${r.stderr || r.error}`);
  const out = JSON.parse(r.stdout);
  const pkg = Array.isArray(out) ? out[0] : Object.values(out)[0];
  return pkg.files.map((f) => f.path.replace(/\\/g, "/"));
}

console.log("the check below can fail:");
{
  const found = forbidden(["src/render.js", "src/kit/x.png", "packages/doom/package.json", "assets/images/hud.png"]);
  ok(found.length === 2 && found.includes("src/kit/x.png") && found.includes("packages/doom/package.json"),
    `an image under src/ and a packages/ path are caught, a README image is not (${found.join(", ")})`);
}

console.log("the main package:");
{
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const files = pkg.files || [];
  ok(Array.isArray(pkg.files) && !files.some((f) => /^\.?\/?packages(\/|$)/.test(f)),
    `package.json files names no packages/ folder (${files.join(", ")})`);

  const paths = packedPaths();
  ok(paths.includes("src/render.js") && paths.includes("bin/cli.js") && paths.includes("package.json"),
    `the listing holds the bar itself (${paths.length} files)`);
  const found = forbidden(paths);
  ok(found.length === 0, `no game assets ship: no packages/ folder, no image under src/${found.length ? ` (${found.join(", ")})` : ""}`);
}

console.log("each game's assets package and its pin:");
{
  const games = GAMES;
  ok(games.length > 0, `the registry lists the games (${games.map((g) => g.name).join(", ")})`);
  for (const game of games) {
    const file = path.join(ROOT, "packages", game.name, "package.json");
    if (!existsSync(file)) { ok(false, `${game.name}: packages/${game.name}/package.json exists`); continue; }
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    const pin = game.assets || {};
    ok(pkg.name === pin.package, `${game.name}: the manifest's package is the folder's (${pin.package} / ${pkg.name})`);
    ok(pkg.version === pin.version, `${game.name}: the manifest pins the folder's version (${pin.version} / ${pkg.version})`);
  }
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
