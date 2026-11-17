// Claude Code settings for the installer: find, read, merge and write settings.json, and recognise
// the entries this package wrote. Used by `claude-game-bar install` and `uninstall`
// (bin/cli.js).

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SRC_DIR } from "../package-root.js";
import { registeredPreset } from "../games/index.js";
import { bothNames, newName, newNameOf } from "../platform/env.js";
import { samePath } from "../platform/runtime.js";
import { isPlainObject } from "../kit/is.js";
import { OLD_PACKAGE } from "./old-package.js";

// Normalise to forward slashes, like install.py's `.replace("\\", "/")`. The marker we
// DETECT below must match the command we WRITE byte-for-byte, including slash direction —
// otherwise a second install double-adds. So everything goes through this one funnel.
export const slash = (p) => p.replace(/\\/g, "/");

const HOOK = slash(path.join(SRC_DIR, "hook.js"));

// Lifecycle events the hook understands (face reactions, geiger, subagents,
// tasks, permission mode, git snapshots). PreToolUse has no matcher -> fires for every tool.
// SessionStart resets the journal and primes git so the HUD is populated from the first
// render. All entries are installed async (see install()) so they never block a tool.
export const HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied",
  "Stop", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "SessionEnd",
];

// How we recognise our own entries — current JS scripts plus legacy Python ones, so a
// user who ran install.py earlier still gets cleaned up by `uninstall`. The client's old path
// is still ours too: settings written before 1.0.0 name it. A mark names the end of a script path,
// so any package root matches: a checkout under any directory name, an npx cache, the global npm
// folder of this package or of the one it replaces.
const HOOK_MARKS = ["src/hook.js", "mugshot_hook.py"];
const SL_MARKS = ["src/gamebar-client.sh", "src/doombar-client.sh", "src/statusline.js", "statusline.py"];
// A mark counts only as a whole path tail: after the start, a slash, a quote or a space, and before
// the end, a quote, a space or a `;`. So `/x/my-tools/hook.js`, `/x/src/hook.jsx` and
// `/x/mysrc/hook.js` are not ours.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const markRe = (marks) => new RegExp(`(?:^|[/\\s"'])(?:${marks.map(esc).join("|")})(?=$|[\\s"';])`);
const HOOK_RE = markRe(HOOK_MARKS), SL_RE = markRe(SL_MARKS);
const hasMark = (s, re) => re.test(slash(String(s || "")));

export function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// --local targets the project's settings.local.json, which overrides settings.json (a
// checkout wired to itself for development, for instance).
export function settingsFile(project, local) {
  if (local) return path.join(process.cwd(), ".claude", "settings.local.json");
  const base = project ? path.join(process.cwd(), ".claude") : path.join(os.homedir(), ".claude");
  return path.join(base, "settings.json");
}

export function load(p) {
  let text;
  try {
    text = readFileSync(p, "utf-8");
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    die(`! ${p} is not valid JSON (${e.message}); fix or move it, then re-run.`);
  }
}

// Writes the settings, only when they change. The file as it was goes to `<file>.bak` first, a
// one-level backup, so a run that changes nothing keeps the backup of the run before it. With
// `firstBackup` (an install that took over the old package's entries) the file as it was is also
// kept in `<file>.bak-claude-doom-statusbar`, written once and never replaced.
export function save(p, data, { firstBackup = false } = {}) {
  const text = JSON.stringify(data, null, 2) + "\n";
  let before = null;
  try { before = readFileSync(p, "utf-8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (before === text) return;
  mkdirSync(path.dirname(p), { recursive: true });
  if (before !== null) {
    if (firstBackup) {
      try { copyFileSync(p, `${p}.bak-${OLD_PACKAGE}`, constants.COPYFILE_EXCL); } catch (e) { if (e.code !== "EEXIST") throw e; }
    }
    let bak = null;
    try { bak = readFileSync(p + ".bak", "utf-8"); } catch {}
    if (bak !== before) copyFileSync(p, p + ".bak");
  }
  writeFileSync(p, text, "utf-8");
}

// Match our hook in either form: shell form keeps the script path in `command`, exec form
// (current) keeps it in `args`. Joining both lets `uninstall` and the idempotency guard find
// installs written by any version. A group (one item of an event's list) is ours when it holds a
// hook of ours; other hooks a user put into the same group are not.
const ourHook = (h) => Boolean(h) && hasMark([h.command, ...(Array.isArray(h.args) ? h.args : [])].join(" "), HOOK_RE);
const ours = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some(ourHook);

// Settings a release before 1.0.0 wrote under its names: env.DOOMBAR_<key> (and MUGSHOT_STATE)
// is renamed to GAMEBAR_<key> in place, keeping the order of the keys. When both names are set the
// new one wins and the old one goes. Returns how many old names went.
export function renameOldEnv(cfg) {
  const env = cfg.env;
  if (!isPlainObject(env)) return 0;
  const renamed = {};
  let n = 0;
  for (const [k, v] of Object.entries(env)) {
    const name = newNameOf(k);
    if (name === null) { renamed[k] = v; continue; }
    n++;
    if (!Object.hasOwn(env, name)) renamed[name] = v;
  }
  if (n) cfg.env = renamed;
  return n;
}

// Is `root` a copy of this package or of the one it replaces? It is recognised by its package.json.
const PACKAGE_NAMES = ["claude-game-bar", OLD_PACKAGE];
function isPackageRoot(root) {
  try { return PACKAGE_NAMES.includes(JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")).name); } catch { return false; }
}

// Is `file` a preset inside a copy of this package or of the one it replaces? Presets lived at
// <root>/presets/<name>.toml before they moved into their games, and live at
// <root>/src/games/<game>/presets/<name>.toml since.
function inPackageCopy(file) {
  const dir = path.dirname(file);
  if (path.basename(dir) !== "presets") return false;
  const roots = [path.dirname(dir)];
  const games = path.dirname(path.dirname(dir));
  if (path.basename(games) === "games" && path.basename(path.dirname(games)) === "src") roots.push(path.dirname(path.dirname(games)));
  return roots.some(isPackageRoot);
}

// The script a hook of ours runs: the argument, or the quoted or bare word of a shell-form command,
// that ends in one of HOOK_MARKS. Null when none can be told apart.
const HOOK_ALT = HOOK_MARKS.map(esc).join("|");
const SCRIPT_RE = new RegExp(`"((?:[^"]*/)?(?:${HOOK_ALT}))"|'((?:[^']*/)?(?:${HOOK_ALT}))'|(?:^|\\s)((?:[^\\s"';]*/)?(?:${HOOK_ALT}))(?=$|[\\s;])`);
function hookScript(h) {
  for (const a of Array.isArray(h.args) ? h.args : []) if (hasMark(a, HOOK_RE)) return slash(String(a));
  const m = SCRIPT_RE.exec(slash(String(h.command || "")));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

// A hook of ours that install may re-point or drop as a duplicate: its script lies in a copy of this
// package or of the one it replaces (<root>/src/hook.js, or <root>/mugshot_hook.py from the Python
// releases), or no longer exists. A hook of another package whose path merely ends the same way is
// left alone.
function ourMovableHook(h) {
  if (!ourHook(h)) return false;
  const script = hookScript(h);
  if (!script) return true;
  const root = /(?:^|\/)src\/hook\.js$/.test(script) ? path.dirname(path.dirname(script)) : path.dirname(script);
  return !existsSync(script) || isPackageRoot(root);
}

// Is `value` a preset setting an installer of this package or of the old one wrote: a registered
// preset of this package, a preset in another copy of either package, or a missing file named after
// a registered preset? A preset file of the user's own is not.
export function ownPreset(value) {
  if (typeof value !== "string" || !value) return false;
  const reg = registeredPreset(path.basename(value));
  return Boolean(reg) && (samePath(value, reg) || !existsSync(value) || inPackageCopy(value));
}

// `skin` is the skin to write as GAMEBAR_SKIN, or null to write none. The preset setting an
// installer wrote goes: the skin choice replaces it. A preset of the user's own stays where it is.
// Returns the notes for the output; their `migrated` is true when an earlier installation's
// entries were renamed or re-pointed (save's firstBackup).
export function install(cfg, skin, refresh, command) {
  const notes = [];
  const existing = cfg.statusLine;
  const migrated = Boolean(existing && hasMark(existing.command, SL_RE) && existing.command !== command);
  if (existing && !hasMark(existing.command, SL_RE)) {
    notes.push("replaced your existing statusLine (the old one is in settings.json.bak)");
  }
  // Assigning a fresh object (rather than patching) also drops a refreshInterval left behind by
  // an older install — which is the whole point of this change on Windows.
  cfg.statusLine = { type: "command", command };
  if (refresh > 0) cfg.statusLine.refreshInterval = refresh;
  else if (existing?.refreshInterval) {
    notes.push("dropped refreshInterval — the HUD now renders on events only (see --refresh)");
  }

  const renamed = renameOldEnv(cfg);
  if (renamed) notes.push(`renamed ${renamed} setting(s) in env from the old DOOMBAR_ names to GAMEBAR_`);
  const env = (cfg.env ??= {});
  const PRESET = newName("PRESET");
  if (ownPreset(env[PRESET])) {
    delete env[PRESET];
    notes.push(`removed ${PRESET}: the skin replaces it`);
  }
  if (skin) env[newName("SKIN")] = skin;
  env.FORCE_HYPERLINK ??= "1"; // clickable links (Windows Terminal needs this)

  const hooks = (cfg.hooks ??= {});
  let repointed = 0, duplicates = 0;
  for (const ev of HOOK_EVENTS) {
    const lst = (hooks[ev] ??= []);
    // async:true keeps the hook off the blocking path — it only appends one journal line and
    // returns; statusline folds it at render time.
    // EXEC FORM (command + args): Claude Code spawns node directly, with no shell wrapper.
    // On Windows this avoids the `bash -c "node ..."` launcher, so wiring the hook into many
    // events no longer floods Git Bash's shared MSYS section (the "add_item errno 1" crash).
    // statusLine has no exec form and cannot be moved off the shell, so the flood from ABOVE
    // is handled by the hook's reaper instead (see reapStaleShells in src/platform/reap.js).
    // SessionEnd is the exception: it deletes the session's scratch files as Claude Code exits,
    // and an async hook can be cut off by that exit. It only unlinks a few files, so running
    // it synchronously costs nothing noticeable.
    const entry = { type: "command", command: "node", args: [HOOK] };
    if (ev !== "SessionEnd") entry.async = true;
    // Idempotent, but NOT blindly: a hook of ours that points at a different path is stale —
    // an upgrade that moved the package (a fresh npx cache dir, npx -> global install, the old
    // package's global folder) or an install written in the old shell form. Skipping it used to
    // leave the statusLine upgraded (it is replaced unconditionally) while the hook still ran the
    // previous version's code, so a fix shipped in the hook silently never took effect. Re-point
    // it instead. Exactly one hook of ours stays per event: the first one, in its place. Any further
    // one (a second set, left by another copy of the package) goes, and a group left empty by that
    // goes with it. Hooks of others in the same groups stay, and so does a hook of another package
    // whose script path only looks like ours (see ourMovableHook).
    const current = (h) => h.command === "node" && Array.isArray(h.args) && h.args.includes(HOOK);
    let kept = false, moved = false;
    for (let i = 0; i < lst.length; i++) {
      const group = lst[i];
      if (!Array.isArray(group?.hooks) || !group.hooks.some(ourMovableHook)) continue;
      group.hooks = group.hooks.flatMap((h) => {
        if (!ourMovableHook(h)) return [h];
        if (kept) { duplicates++; return []; }
        kept = true;
        if (current(h)) return [h];
        moved = true;
        return [entry];
      });
      if (group.hooks.length === 0) lst.splice(i--, 1);
    }
    if (!kept) lst.push({ hooks: [entry] });
    if (moved) repointed++;
  }
  if (repointed) {
    notes.push(`re-pointed ${repointed} hook event(s) from a previous install's path`);
  }
  if (duplicates) notes.push(`removed ${duplicates} duplicate hook entr${duplicates === 1 ? "y" : "ies"} of ours`);
  return Object.assign(notes, { migrated: migrated || renamed > 0 || repointed > 0 || duplicates > 0 });
}

export function uninstall(cfg) {
  if (hasMark(cfg.statusLine?.command, SL_RE)) delete cfg.statusLine;

  const env = cfg.env || {};
  for (const k of [...bothNames("PRESET"), ...bothNames("SKIN"), "FORCE_HYPERLINK"]) delete env[k];
  if (Object.keys(env).length === 0) delete cfg.env;

  // Our hooks go, and a group left empty goes with them; hooks of others stay.
  const hooks = cfg.hooks || {};
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev].flatMap((g) => {
      if (!ours(g)) return [g];
      const rest = g.hooks.filter((h) => !ourHook(h));
      return rest.length ? [{ ...g, hooks: rest }] : [];
    });
    if (hooks[ev].length === 0) delete hooks[ev];
  }
  if (Object.keys(hooks).length === 0) delete cfg.hooks;
}
