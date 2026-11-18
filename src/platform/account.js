// The Claude account a render's rate limits belong to, as a short key.
//
// Rate limits are per Claude account, and a user may switch accounts on one machine. The session
// payload does not name the account, but Claude Code keeps the logged-in one in its config file:
// `.claude.json` in CLAUDE_CONFIG_DIR, else in the home directory, under `oauthAccount.accountUuid`.
// The bar keeps only a short hash of that id (never the id or anything else from the file), and
// names its account-wide files by it, so two accounts never share a rate-limit pool.
//
// The file is read again only when its size or modification time changes. Null when the file or
// the account cannot be read (an API-key login, an unreadable file): the bar then uses its one
// shared pool, as before accounts were told apart.
//
// A session keeps the account it started with while the file names the account logged in now; a
// session left open across a switch pools under the new account until it restarts.

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const KEY_LEN = 12;
let cached = null;

export const claudeConfigFile = (env = process.env) =>
  env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");

// Pure: the key of an account id, or null.
export function keyOfAccount(id) {
  if (typeof id !== "string" || id.trim() === "") return null;
  return createHash("sha256").update(id.trim()).digest("hex").slice(0, KEY_LEN);
}

export function accountKey(env = process.env) {
  const file = claudeConfigFile(env);
  let st;
  try { st = statSync(file); } catch { return null; }
  if (cached && cached.file === file && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.key;
  let key = null;
  try { key = keyOfAccount(JSON.parse(readFileSync(file, "utf8"))?.oauthAccount?.accountUuid); } catch { /* unreadable */ }
  cached = { file, mtimeMs: st.mtimeMs, size: st.size, key };
  return key;
}
