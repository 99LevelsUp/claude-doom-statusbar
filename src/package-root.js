// The package root: the directory that holds package.json, bin/ and src/ (each game's presets and
// assets live in its folder under src/games/).
//
// Everything that names a path inside the package, the install hash or the render daemon's path
// takes the root from here, so moving a source file into a subfolder cannot change any of them.
// Installed settings carry the hash and the hooks confirm a daemon by its path, so a root that
// moved with a file would take a live bar offline. This file stays directly in src/.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SRC_DIR = path.join(PACKAGE_ROOT, "src");
