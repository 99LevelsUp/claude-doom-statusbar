// A stand-in for npm, so no test ever reaches the real one. The installer runs it through
// GAMEBAR_NPM, which the sandbox environment sets (test/_sandbox-env.mjs).
//   npm root -g                 prints NPM_STUB_ROOT (by default a folder that does not exist)
//   npm uninstall -g <name>     removes <NPM_STUB_ROOT>/<name>, or exits 1 when NPM_STUB_FAIL=1
// Every call is appended to NPM_STUB_LOG, when set, as one JSON line with its arguments and, when
// NPM_STUB_WATCH names a file, that file's text at the time of the call.
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const env = process.env;
if (env.NPM_STUB_LOG) {
  let watched = null;
  if (env.NPM_STUB_WATCH) { try { watched = readFileSync(env.NPM_STUB_WATCH, "utf8"); } catch { watched = null; } }
  appendFileSync(env.NPM_STUB_LOG, JSON.stringify({ args, watched }) + "\n");
}
const root = env.NPM_STUB_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), "no-npm-root");
if (args[0] === "root" && args[1] === "-g") {
  console.log(root);
} else if (args[0] === "uninstall" && args[1] === "-g" && args[2]) {
  if (env.NPM_STUB_FAIL === "1") {
    console.error("npm error code EACCES");
    process.exit(1);
  }
  rmSync(path.join(root, args[2]), { recursive: true, force: true });
  console.log(`removed 1 package`);
} else {
  console.error(`npm stub: unsupported ${args.join(" ")}`);
  process.exit(1);
}
