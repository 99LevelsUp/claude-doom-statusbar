// Journal housekeeping: the stale-state sweep at SessionStart and the cleanup at SessionEnd.
//
// Every session leaves a checkpoint, a journal, probe markers, an advisor cache and a savings file
// next to its checkpoint (see sessionPaths), keyed by session
// id, and nothing ever removed them: a real box accumulated 12 395 files / 10 MB. They are all
// per-session scratch — once a session is over its journal can never be read again — so at
// SessionStart we drop the ones that have gone cold.
//
// Deliberately narrow, because this deletes files:
//   * only names matching our own `mugshot_` / `savings_` prefixes, in the checkpoint's
//     directory, non-recursively;
//   * never SHARED state: the rate-health accumulator, the rate-limit pool and the CPU sample
//     are cross-session by design (see statusline.js) and the reap throttle is process-wide, so
//     they are keyed by a fixed name with no session id and are excluded by name; the render
//     daemon's heartbeat and claim (one pair per install hash) are excluded by pattern;
//   * never this session's own files;
//   * decided per session, by its newest file, so a session that is merely idle — or a
//     concurrent one — is never touched, and a session's files go together or not at all;
//   * a session that ever rendered a bar (it has a checkpoint, advisor cache or savings file)
//     goes once its newest file is older than DOOMBAR_JOURNAL_TTL (default 7 days); one
//     that never rendered — a headless
//     `claude -p` run fires the hooks but shows no bar — after DOOMBAR_UNRENDERED_TTL
//     (default 1 hour), because nothing will ever read its files.
// Orphaned `<checkpoint>.<pid>.tmp` files from interrupted atomic writes belong to their
// session. So do the render daemon's payload and frame (and their `.tmp` leftovers), which always
// live in the runtime directory: they are swept with their session when the checkpoint lives there
// too (the normal case), not when MUGSHOT_STATE moves the checkpoint elsewhere. Failures are ignored per file: housekeeping must never cost a hook its exit 0.

import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { statePaths, sessionPaths, sidKey, ROOT_HASH_LEN, envNum } from "./runtime.js";

const JOURNAL_TTL = envNum(process.env.DOOMBAR_JOURNAL_TTL, 7 * 24 * 60 * 60 * 1000); // ms
const UNRENDERED_TTL = envNum(process.env.DOOMBAR_UNRENDERED_TTL, 60 * 60 * 1000); // ms

// Fixed-name files shared across sessions — deleting these would lose real state.
const SHARED_STATE = new Set([
  "mugshot_ratehealth_global.json", "mugshot_ratelimits_global.json", "mugshot_cpu.json", "mugshot_reap_tick.json",
]);

// The render daemon's own files (daemonPaths in src/platform/runtime.js): one heartbeat and one
// claim per install hash, shared by every session the daemon serves.
const HASH_RE = `[0-9a-f]{${ROOT_HASH_LEN}}`;
const DAEMON_FILE = new RegExp(`^mugshot_daemon_${HASH_RE}\\.(?:json|claim)(?:\\.\\d+\\.tmp)?$`);
// Per-session payload and frame (sessionPaths in src/platform/runtime.js), with any install hash.
const DAEMON_SESSION_FILE = new RegExp(`^mugshot_(?:payload|frame)_${HASH_RE}_(.+)\\.json(?:\\.\\d+\\.tmp)?$`);

// The session key a file belongs to (the names sessionPaths in src/platform/runtime.js writes),
// or null when the name is not one of ours.
function sessionKeyOf(name) {
  let m = /^mugshot_(?:git|msys|adv)_(.+)\.json$/.exec(name) || /^savings_(.+)\.json$/.exec(name) ||
    DAEMON_SESSION_FILE.exec(name);
  if (m) return m[1];
  m = /^mugshot_(.+?)\.json(?:\.jsonl|\.\d+\.tmp)?$/.exec(name); // checkpoint, journal, .tmp
  return m ? m[1] : null;
}

// Pure: which of `names` are cold scratch files? Exported so the delete rule is tested without
// touching a real temp dir. `ageOf` returns mtime age in ms, or null when it can't be read.
export function staleStateFiles(names, ageOf, { ttl = JOURNAL_TTL, unrenderedTtl = UNRENDERED_TTL, keep = [] } = {}) {
  const all = names || [];
  const listed = new Set(all);
  const mine = new Set(keep.map((p) => path.basename(p)));
  const sessions = new Map(); // session key -> [{ name, age }]
  for (const n of all) {
    if (SHARED_STATE.has(n) || DAEMON_FILE.test(n) || mine.has(n)) continue; // shared state; this session's own files
    const key = sessionKeyOf(n);
    if (key === null) continue;                         // not ours
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push({ name: n, age: ageOf(n) });
  }
  const stale = [];
  for (const [key, files] of sessions) {
    const known = files.filter((f) => Number.isFinite(f.age)); // an unreadable age is never a reason to delete
    if (!known.length) continue;
    const newest = Math.min(...known.map((f) => f.age));
    // Rendered = any file only the statusline writes is present. After end-of-session cleanup
    // the savings file is all that is left, and it must keep the long TTL for a later resume.
    const rendered = [`mugshot_${key}.json`, `mugshot_adv_${key}.json`, `savings_${key}.json`]
      .some((n) => listed.has(n));
    const limit = rendered ? ttl : unrenderedTtl;
    if (newest >= limit) stale.push(...known.map((f) => f.name));
  }
  return stale;
}

export function sweepState(sid) {
  if (process.env.DOOMBAR_JOURNAL_TTL === "off") return 0;
  const { checkpoint } = statePaths(sid);
  // Sweep the directory our state actually lives in, not the runtime directory blindly. They are the same
  // in normal use, but MUGSHOT_STATE relocates the checkpoint — and a sweep that ignored it would
  // delete from the real temp dir while writing to a sandbox. That bit the test suite: firing a
  // SessionStart with MUGSHOT_STATE set swept the developer's actual runtime directory.
  const dir = path.dirname(checkpoint);
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  const keep = Object.values(sessionPaths(sid));
  const ageOf = (n) => {
    try { return Date.now() - statSync(path.join(dir, n)).mtimeMs; } catch { return null; }
  };
  let gone = 0;
  for (const n of staleStateFiles(names, ageOf, { keep })) {
    try { unlinkSync(path.join(dir, n)); gone++; } catch { /* in use / already gone */ }
  }
  return gone;
}

// End of session: delete its scratch now rather than leave it for a later session's sweep.
// Kept: the savings file — a resumed session keeps its id, and its lean-ctx savings total lives
// only there. The checkpoint goes: a resume resets it anyway (SessionStart truncates the
// journal), and its stale offset could misread the resumed session's new journal.
// Unlink only — no journal line, no probes — so nothing is recreated behind us.
export function endSession(sid) {
  const p = sessionPaths(sid);
  for (const f of [p.journal, p.checkpoint, p.git, p.msys, p.adv]) {
    try { unlinkSync(f); } catch { /* never written, or already gone */ }
  }
  // The daemon's payload and frame (and their `.<pid>.tmp` leftovers) live in the runtime directory
  // under an install hash. The session may have been served by more than one installation, so
  // every hash's files for this exact key go.
  const key = sidKey(sid), tmpDir = path.dirname(p.payload);
  let tmpNames = [];
  try { tmpNames = readdirSync(tmpDir); } catch {}
  for (const n of tmpNames) {
    const m = DAEMON_SESSION_FILE.exec(n);
    if (!m || m[1] !== key) continue;
    try { unlinkSync(path.join(tmpDir, n)); } catch {}
  }
  // Orphaned `<checkpoint>.<pid>.tmp` files from this session's interrupted atomic writes.
  const dir = path.dirname(p.checkpoint), stem = path.basename(p.checkpoint);
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(stem) || !/^\.\d+\.tmp$/.test(n.slice(stem.length))) continue;
    try { unlinkSync(path.join(dir, n)); } catch { /* in use / already gone */ }
  }
}
