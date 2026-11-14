#!/usr/bin/env node
// The general part of the bar (everything under src/ except src/games/, plus bin/) knows no game: it
// reaches games only through the registry (src/games/index.js). This scans its code, comments
// left out, for a registered game's name in quotes and for a path into a game's folder, so a game
// name that creeps back into the general part fails here instead of in the next game.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GAMES } from "../../src/games/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const names = GAMES.flatMap((g) => [g.name, ...(g.aliases || [])]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const quoted = new RegExp(`["'\`](${names.map(esc).join("|")})["'\`]`);
const gamePath = new RegExp(`games/(${names.map(esc).join("|")})\\b`);

// The line without a trailing // comment (a "//" right after ":" is a URL, not a comment).
const code = (line) => line.replace(/(^|[^:])\/\/.*$/, "$1");
const hits = (text) => text.split(/\r?\n/).flatMap((line, i) => {
  const c = code(line);
  return quoted.test(c) || gamePath.test(c) ? [`${i + 1}: ${line.trim()}`] : [];
});

// The scanner itself can fail.
ok(hits('  saveTheme("doom"); // a theme').length === 1, "the scan catches a quoted game name (the checks below can fail)");
ok(hits('const p = "src/games/doom/presets";').length === 1, "the scan catches a path into a game's folder");
ok(hits('// see src/games/doom/face.js and "doom"').length === 0, "comments are left out");

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (path.relative(path.join(ROOT, "src"), p) !== "games") walk(p); }
    else if (/\.(m?js)$/.test(e.name)) files.push(p);
  }
};
walk(path.join(ROOT, "src"));
walk(path.join(ROOT, "bin"));
ok(files.some((f) => f.endsWith(path.join("src", "render.js"))) && files.some((f) => f.endsWith(path.join("bin", "cli.js")))
  && !files.some((f) => f.includes(path.join("src", "games") + path.sep)), `the scan covers the general part (${files.length} files)`);

for (const f of files) {
  const found = hits(readFileSync(f, "utf8"));
  ok(found.length === 0, `${path.relative(ROOT, f).replace(/\\/g, "/")} names no game${found.length ? `:\n         ${found.join("\n         ")}` : ""}`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
