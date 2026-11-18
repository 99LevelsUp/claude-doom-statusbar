// The environment that points every temp and runtime path of the bar at one test directory:
// the temp directory (Windows, and Node's os.tmpdir() everywhere) and the bar's runtime
// directory (Linux and macOS), so a test never touches the live bar's files. The runtime directory
// is set under both its names, so neither a new nor an old name inherited from the developer's
// environment can point a test elsewhere. The user directory (the saved skin and the user's own
// skins) is a folder in the test directory, under both names too. npm is a stand-in
// (test/_npm-stub.mjs) whose global folder is an empty place in the test directory, so `install`
// never reaches the real npm. Claude Code's config directory is the test directory too, so the bar
// finds no logged-in account (src/platform/account.js) and pools rate limits in the shared file.
import path from "node:path";
import { fileURLToPath } from "node:url";

const NPM_STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "_npm-stub.mjs");

export const sandboxEnv = (dir) => ({ TEMP: dir, TMP: dir, TMPDIR: dir, GAMEBAR_RUNTIME_DIR: dir, DOOMBAR_RUNTIME_DIR: dir,
  GAMEBAR_USER_DIR: path.join(dir, "user"), DOOMBAR_USER_DIR: path.join(dir, "user"),
  GAMEBAR_NPM: NPM_STUB, NPM_STUB_ROOT: path.join(dir, "npm-global"), CLAUDE_CONFIG_DIR: dir });
