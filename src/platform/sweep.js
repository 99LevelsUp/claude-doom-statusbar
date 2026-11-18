// Journal housekeeping: the stale-state sweep at SessionStart and the cleanup at SessionEnd.
//
// Every session leaves a checkpoint, a journal, probe markers, an advisor cache and a savings file
// next to its checkpoint (see sessionPaths), keyed by session
// id, and nothing ever removed them: a real box accumulated 12 395 files / 10 MB. They are all
// per-session scratch — once a session is over its journal can never be read again — so at
// SessionStart we drop the ones that have gone cold.
//
// Deliberately narrow, because this deletes files:
//   * only names matching our own `gamebar_` / `savings_` prefixes (and `mugshot_`, the prefix
//     before 1.0.0), in the checkpoint's directory and, on Linux and macOS, the old runtime
//     directory (see sweepDirs), non-recursively;
//   * never SHARED state: the rate-health accumulator, the rate-limit pool and the CPU sample
//     are cross-session by design (see src/metrics/ratelimits.js and src/metrics/system.js) and the reap throttle is process-wide, so
//     they are keyed by a fixed name with no session id and are excluded by name; the render
//     daemon's heartbeat and claim (one pair per install hash) and a game's face cache are
//     excluded by pattern;
//   * never this session's own files;
//   * decided per session, by its newest file, so a session that is merely idle — or a
//     concurrent one — is never touched, and a session's files go together or not at all;
//   * a session that ever rendered a bar (it has a checkpoint, advisor cache or savings file)
//     goes once its newest file is older than GAMEBAR_JOURNAL_TTL (default 7 days); one
//     that never rendered — a headless
//     `claude -p` run fires the hooks but shows no bar — after GAMEBAR_UNRENDERED_TTL
//     (default 1 hour), because nothing will ever read its files.
// Orphaned `<checkpoint>.<pid>.tmp` files from interrupted atomic writes belong to their
// session. So do the render daemon's payload and frame (and their `.tmp` leftovers), which always
// live in the runtime directory: they are swept with their session when the checkpoint lives there
// too (the normal case), not when GAMEBAR_STATE moves the checkpoint elsewhere. Failures are ignored per file: housekeeping must never cost a hook its exit 0.

import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  statePaths, sessionPaths, sidKey, ROOT_HASH_LEN, envNum, FILE_PREFIX, OLD_FILE_PREFIX, FACES_PREFIX,
  OLD_FACES_PREFIX, oldRuntimeDir,
} from "./runtime.js";
import { envGet } from "./env.js";

const JOURNAL_TTL = envNum(envGet("JOURNAL_TTL"), 7 * 24 * 60 * 60 * 1000); // ms
const UNRENDERED_TTL = envNum(envGet("UNRENDERED_TTL"), 60 * 60 * 1000); // ms
// Files a release before 1.0.0 left carry the old prefix. They follow the same rules as the new
// ones, so every pattern below takes either prefix.
const PREFIXES = [FILE_PREFIX, OLD_FILE_PREFIX];
const P = `(?:${PREFIXES.join("|")})`;

// Fixed-name files shared across sessions — deleting these would lose real state. Under the old
// prefix they are the source the learned-state fallback reads.
const SHARED_STATE = new Set(PREFIXES.flatMap((p) => [
  `${p}ratehealth_global.json`, `${p}ratelimits_global.json`, `${p}cpu.json`, `${p}reap_tick.json`,
]));
// The rate-limit pool and the rate-health accumulator of one Claude account (src/metrics/ratelimits.js),
// named by the account's key (src/platform/account.js).
const ACCOUNT_STATE = new RegExp(`^${FILE_PREFIX}(?:ratehealth|ratelimits)_[0-9a-f]{12}\\.json(?:\\.\\d+\\.tmp)?$`);

// The render daemon's own files (daemonPaths in src/platform/runtime.js): one heartbeat and one
// claim per install hash, shared by every session the daemon serves.
const HASH_RE = `[0-9a-f]{${ROOT_HASH_LEN}}`;
const DAEMON_FILE = new RegExp(`^${P}daemon_${HASH_RE}\\.(?:json|claim)(?:\\.\\d+\\.tmp)?$`);
// Per-session payload and frame (sessionPaths in src/platform/runtime.js), with any install hash.
const DAEMON_SESSION_FILE = new RegExp(`^${P}(?:payload|frame)_${HASH_RE}_(.+)\\.json(?:\\.\\d+\\.tmp)?$`);
const PROBE_FILE = new RegExp(`^${P}(?:git|msys|adv)_(.+)\\.json$`);
const STATE_FILE = new RegExp(`^${P}(.+?)\\.json(?:\\.jsonl|\\.\\d+\\.tmp)?$`); // checkpoint, journal, .tmp
// The face cache under its name before 1.0.0. No release writes it any more, so a copy that has
// gone cold for the session TTL goes; the current cache is pruned by its game.
const OLD_FACES_FILE = new RegExp(`^${OLD_FACES_PREFIX}[0-9a-f]{12}\\.json(?:\\.\\d+\\.tmp)?$`);

// The session key a file belongs to (the names sessionPaths in src/platform/runtime.js writes),
// or null when the name is not one of ours.
function sessionKeyOf(name) {
  let m = PROBE_FILE.exec(name) || /^savings_(.+)\.json$/.exec(name) ||
    DAEMON_SESSION_FILE.exec(name);
  if (m) return m[1];
  m = STATE_FILE.exec(name);
  return m ? m[1] : null;
}

// Pure: which of `names` are cold scratch files? Exported so the delete rule is tested without
// touching a real temp dir. `ageOf` returns mtime age in ms, or null when it can't be read.
export function staleStateFiles(names, ageOf, { ttl = JOURNAL_TTL, unrenderedTtl = UNRENDERED_TTL, keep = [] } = {}) {
  const all = names || [];
  const listed = new Set(all);
  const mine = new Set(keep.map((p) => path.basename(p)));
  const sessions = new Map(); // session key -> [{ name, age }]
  const stale = [];
  for (const n of all) {
    if (OLD_FACES_FILE.test(n)) {
      const age = ageOf(n);
      if (Number.isFinite(age) && age >= ttl) stale.push(n);
      continue;
    }
    if (SHARED_STATE.has(n) || ACCOUNT_STATE.test(n) || DAEMON_FILE.test(n) || n.startsWith(FACES_PREFIX) || mine.has(n)) continue; // shared state; this session's own files
    const key = sessionKeyOf(n);
    if (key === null) continue;                         // not ours
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push({ name: n, age: ageOf(n) });
  }
  for (const [key, files] of sessions) {
    const known = files.filter((f) => Number.isFinite(f.age)); // an unreadable age is never a reason to delete
    if (!known.length) continue;
    const newest = Math.min(...known.map((f) => f.age));
    // Rendered = any file only the statusline writes is present. After end-of-session cleanup
    // the savings file is all that is left, and it must keep the long TTL for a later resume.
    // A session's files under both prefixes count as one session.
    const rendered = [...PREFIXES.flatMap((p) => [`${p}${key}.json`, `${p}adv_${key}.json`]), `savings_${key}.json`]
      .some((n) => listed.has(n));
    const limit = rendered ? ttl : unrenderedTtl;
    if (newest >= limit) stale.push(...known.map((f) => f.name));
  }
  return stale;
}

// The directories the sweep scans. First the directory our state actually lives in, not the runtime
// directory blindly. They are the same in normal use, but GAMEBAR_STATE relocates the checkpoint —
// and a sweep that ignored it would delete from the real temp dir while writing to a sandbox. That
// bit the test suite: firing a SessionStart with GAMEBAR_STATE set swept the developer's actual
// runtime directory.
// Then, only when the state is not relocated, the runtime directory a release before 1.0.0 used,
// when it is another directory (Linux and macOS) and passes oldRuntimeDir's check: a real
// directory of this user, not a link. `opts` is passed to that check (tests).
export function sweepDirs(sid, env = process.env, opts = {}) {
  const dir = path.dirname(statePaths(sid, env).checkpoint);
  if (envGet("STATE", env)) return [dir];
  const old = oldRuntimeDir(env, opts);
  return old && path.resolve(old) !== path.resolve(dir) ? [dir, old] : [dir];
}

export function sweepState(sid) {
  if (envGet("JOURNAL_TTL") === "off") return 0;
  const keep = Object.values(sessionPaths(sid));
  let gone = 0;
  for (const dir of sweepDirs(sid)) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    const ageOf = (n) => {
      try { return Date.now() - statSync(path.join(dir, n)).mtimeMs; } catch { return null; }
    };
    for (const n of staleStateFiles(names, ageOf, { keep })) {
      try { unlinkSync(path.join(dir, n)); gone++; } catch { /* in use / already gone */ }
    }
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
  const key = sidKey(sid), dir = path.dirname(p.checkpoint);
  // A session that started before 1.0.0 left the same files under the old prefix.
  const oldStem = path.join(dir, `${OLD_FILE_PREFIX}${key}.json`);
  const old = [oldStem, `${oldStem}.jsonl`, ...["git", "msys", "adv"].map((k) => path.join(dir, `${OLD_FILE_PREFIX}${k}_${key}.json`))];
  for (const f of [p.journal, p.checkpoint, p.git, p.msys, p.adv, ...old]) {
    try { unlinkSync(f); } catch { /* never written, or already gone */ }
  }
  // The daemon's payload and frame (and their `.<pid>.tmp` leftovers) live in the runtime directory
  // under an install hash. The session may have been served by more than one installation, so
  // every hash's files for this exact key go, under either prefix.
  const tmpDir = path.dirname(p.payload);
  let tmpNames = [];
  try { tmpNames = readdirSync(tmpDir); } catch {}
  for (const n of tmpNames) {
    const m = DAEMON_SESSION_FILE.exec(n);
    if (!m || m[1] !== key) continue;
    try { unlinkSync(path.join(tmpDir, n)); } catch {}
  }
  // Orphaned `<checkpoint>.<pid>.tmp` files from this session's interrupted atomic writes.
  const stems = [path.basename(p.checkpoint), path.basename(oldStem)];
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!stems.some((stem) => n.startsWith(stem) && /^\.\d+\.tmp$/.test(n.slice(stem.length)))) continue;
    try { unlinkSync(path.join(dir, n)); } catch { /* in use / already gone */ }
  }
}
