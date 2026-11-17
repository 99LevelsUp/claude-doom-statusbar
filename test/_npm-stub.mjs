// A stand-in for npm, so no test ever reaches the real one. The installer runs it through
// GAMEBAR_NPM, which the sandbox environment sets (test/_sandbox-env.mjs).
//   npm root -g                 prints NPM_STUB_ROOT (by default a folder that does not exist)
//   npm uninstall -g <name>     removes <NPM_STUB_ROOT>/<name>, or exits 1 when NPM_STUB_FAIL=1
//   npm install [flags]         installs the dependencies of package.json in the working directory
//                               from NPM_STUB_PACKAGES, a folder of <package name>@<version>/
//                               folders (a scoped name is a folder per part: @scope/name@1.0.0/),
//                               into node_modules/, and writes node_modules/.package-lock.json with
//                               each package's version and an integrity of NPM_STUB_INTEGRITY (by
//                               default "sha512-stub"). A dependency missing there exits 1 (E404).
//                               NPM_STUB_DELAY_MS makes it take that long first; NPM_STUB_FAIL=1
//                               makes it exit 1 without installing anything.
// Every call is appended to NPM_STUB_LOG, when set, as one JSON line with its arguments, its
// working directory, the text of package.json there, and, when NPM_STUB_WATCH names a file, that
// file's text at the time of the call.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const env = process.env;
const textOf = (file) => { try { return readFileSync(file, "utf8"); } catch { return null; } };
if (env.NPM_STUB_LOG) {
  const watched = env.NPM_STUB_WATCH ? textOf(env.NPM_STUB_WATCH) : null;
  const pkg = textOf(path.join(process.cwd(), "package.json"));
  appendFileSync(env.NPM_STUB_LOG, JSON.stringify({ args, cwd: process.cwd(), pkg, watched }) + "\n");
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
} else if (args[0] === "install") {
  const delay = Number(env.NPM_STUB_DELAY_MS || 0);
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  if (env.NPM_STUB_FAIL === "1") {
    console.error("npm error code ECONNRESET");
    process.exit(1);
  }
  const deps = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")).dependencies || {};
  const packages = {};
  for (const [name, version] of Object.entries(deps)) {
    const from = env.NPM_STUB_PACKAGES ? path.join(env.NPM_STUB_PACKAGES, ...`${name}@${version}`.split("/")) : null;
    if (!from || !existsSync(from)) {
      console.error(`npm error code E404 ${name}@${version}`);
      process.exit(1);
    }
    const to = path.join(process.cwd(), "node_modules", ...name.split("/"));
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
    packages[`node_modules/${name}`] = { version, resolved: `https://registry.example/${name}`, integrity: env.NPM_STUB_INTEGRITY || "sha512-stub" };
  }
  mkdirSync(path.join(process.cwd(), "node_modules"), { recursive: true });
  writeFileSync(path.join(process.cwd(), "node_modules", ".package-lock.json"),
    JSON.stringify({ name: "stub", lockfileVersion: 3, requires: true, packages }, null, 2));
  console.log(`added ${Object.keys(packages).length} packages`);
} else {
  console.error(`npm stub: unsupported ${args.join(" ")}`);
  process.exit(1);
}
