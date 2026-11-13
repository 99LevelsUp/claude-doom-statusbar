#!/usr/bin/env node
// The installation's identity: the install hash, the package version and the daemon path every
// process derives must name this checkout's root. Installed settings carry the hash, and the hooks
// confirm a daemon by its path before they kill it, so these must not move when source files do.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootHash, packageVersion } from "../../src/fold.js";
import { isOurDaemon } from "../../src/hook.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const ROOT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..");

ok(rootHash() === rootHash(ROOT), "the default install hash is the hash of the package root (what install bakes in)");
ok(packageVersion() === JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
  "the version every process reports is package.json's");

const start = 1793500000000;
const row = (daemonJs) => `node.exe|${start}|"C:\\Program Files\\nodejs\\node.exe" ${daemonJs}`;
ok(isOurDaemon(row(path.join(ROOT, "src", "daemon.js")), start),
  "the hooks confirm a daemon running <root>/src/daemon.js");
ok(!isOurDaemon(row(path.join(ROOT, "src", "src", "daemon.js")), start),
  "and not one running from another path");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
