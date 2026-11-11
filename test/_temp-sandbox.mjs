// Import first in a test that draws faces in-process: points the temp and runtime directories
// at a fresh sandbox, so the face cache and other files never land in the machine's real ones,
// and removes the sandbox when the test exits.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandboxEnv } from "./_sandbox-env.mjs";

export const TEMP_SANDBOX = mkdtempSync(path.join(os.tmpdir(), "doombar-test-"));
Object.assign(process.env, sandboxEnv(TEMP_SANDBOX));
process.on("exit", () => rmSync(TEMP_SANDBOX, { recursive: true, force: true }));
