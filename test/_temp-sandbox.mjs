// Import first in a test that draws faces in-process: points the temp directory at a fresh
// sandbox, so the face cache and other temp files never land in the machine's real one, and
// removes the sandbox when the test exits.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEMP_SANDBOX = mkdtempSync(path.join(os.tmpdir(), "doombar-test-"));
Object.assign(process.env, { TEMP: TEMP_SANDBOX, TMP: TEMP_SANDBOX, TMPDIR: TEMP_SANDBOX });
process.on("exit", () => rmSync(TEMP_SANDBOX, { recursive: true, force: true }));
