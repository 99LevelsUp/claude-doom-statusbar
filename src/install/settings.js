// Claude Code settings for the installer: find, read, merge and write settings.json, and recognise
// the entries this package wrote. Used by `claude-doom-statusbar install` and `uninstall`
// (bin/cli.js).

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PACKAGE_ROOT, SRC_DIR } from "../package-root.js";

// Normalise to forward slashes, like install.py's `.replace("\\", "/")`. The marker we
// DETECT below must match the command we WRITE byte-for-byte, including slash direction —
// otherwise a second install double-adds. So everything goes through this one funnel.
export const slash = (p) => p.replace(/\\/g, "/");

const HOOK = slash(path.join(SRC_DIR, "hook.js"));

// Lifecycle events the mugshot hook understands (face reactions, geiger, subagents,
// tasks, permission mode, git snapshots). PreToolUse has no matcher -> fires for every tool.
// SessionStart resets the journal and primes git so the HUD is populated from the first
// render. All entries are installed async (see install()) so they never block a tool.
export const HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied",
  "Stop", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "SessionEnd",
];

// How we recognise our own entries — current JS scripts plus legacy Python ones, so a
// user who ran install.py earlier still gets cleaned up by `uninstall`.
const HOOK_MARKS = ["src/hook.js", "mugshot_hook.py"];
const SL_MARKS = ["src/doombar-client.sh", "src/statusline.js", "statusline.py"];
const hasMark = (s, marks) => marks.some((m) => slash(String(s || "")).includes(m));

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

export function save(p, data) {
  mkdirSync(path.dirname(p), { recursive: true });
  if (existsSync(p)) copyFileSync(p, p + ".bak"); // one-level backup before writing
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// Match our entry in either form: shell form keeps the script path in `command`, exec form
// (current) keeps it in `args`. Joining both lets `uninstall` and the idempotency guard find
// installs written by any version.
const ours = (entry) => (entry.hooks || [])
  .some((h) => hasMark([h.command, ...(h.args || [])].join(" "), HOOK_MARKS));

export function install(cfg, preset, refresh, command) {
  const notes = [];
  const existing = cfg.statusLine;
  if (existing && !hasMark(JSON.stringify(existing), SL_MARKS)) {
    notes.push("replaced your existing statusLine (the old one is in settings.json.bak)");
  }
  // Assigning a fresh object (rather than patching) also drops a refreshInterval left behind by
  // an older install — which is the whole point of this change on Windows.
  cfg.statusLine = { type: "command", command };
  if (refresh > 0) cfg.statusLine.refreshInterval = refresh;
  else if (existing?.refreshInterval) {
    notes.push("dropped refreshInterval — the HUD now renders on events only (see --refresh)");
  }

  const env = (cfg.env ??= {});
  const presetFile = preset.endsWith(".toml") ? preset : preset + ".toml";
  env.DOOMBAR_PRESET = slash(path.join(PACKAGE_ROOT, "presets", presetFile));
  env.FORCE_HYPERLINK ??= "1"; // clickable links (Windows Terminal needs this)

  const hooks = (cfg.hooks ??= {});
  let repointed = 0;
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
    const desired = { hooks: [entry] };
    const at = lst.findIndex(ours);
    if (at === -1) { lst.push(desired); continue; }
    // Idempotent, but NOT blindly: an entry of ours that points at a different path is stale —
    // an upgrade that moved the package (a fresh npx cache dir, npx -> global install) or an
    // install written in the old shell form. Skipping it used to leave the statusLine upgraded
    // (it is replaced unconditionally) while the hook still ran the previous version's code, so
    // a fix shipped in the hook silently never took effect. Re-point it instead.
    if (!lst[at].hooks?.some((h) => h.command === "node" && (h.args || []).includes(HOOK))) {
      lst[at] = desired;
      repointed++;
    }
  }
  if (repointed) {
    notes.push(`re-pointed ${repointed} hook event(s) from a previous install's path`);
  }
  return notes;
}

export function uninstall(cfg) {
  if (hasMark(cfg.statusLine?.command, SL_MARKS)) delete cfg.statusLine;

  const env = cfg.env || {};
  for (const k of ["DOOMBAR_PRESET", "FORCE_HYPERLINK"]) delete env[k];
  if (Object.keys(env).length === 0) delete cfg.env;

  const hooks = cfg.hooks || {};
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = hooks[ev].filter((e) => !ours(e));
    if (hooks[ev].length === 0) delete hooks[ev];
  }
  if (Object.keys(hooks).length === 0) delete cfg.hooks;
}
