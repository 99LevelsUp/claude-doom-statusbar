// Settings read from the environment. Every setting is named GAMEBAR_<key>. Releases before 1.0.0
// named it DOOMBAR_<key> (the state path MUGSHOT_STATE), and a user's settings may still set only
// that name, so the old name is read when the new one is not set. A variable set to the empty
// string counts as set: each caller keeps its own treatment of "" (`||` falls back to its default,
// `??` keeps the empty string). No spawns, no file access.

// Old names that are not DOOMBAR_<key>.
const OLD_NAMES = { STATE: "MUGSHOT_STATE" };
const OLD_PREFIX = "DOOMBAR_";

export const newName = (key) => `GAMEBAR_${key}`;
export const oldName = (key) => OLD_NAMES[key] || `${OLD_PREFIX}${key}`;

// The new name of the setting `name` is the old name of, or null when it is no setting's old name:
// the inverse of oldName. DOOMBAR_STATE is null, for instance, because the state path's old name
// is MUGSHOT_STATE.
export function newNameOf(name) {
  const special = Object.keys(OLD_NAMES).find((k) => OLD_NAMES[k] === name);
  const key = special ?? (String(name).startsWith(OLD_PREFIX) ? String(name).slice(OLD_PREFIX.length) : "");
  return key && oldName(key) === name ? newName(key) : null;
}

// Both names of a setting, the new one first.
export const bothNames = (key) => [newName(key), oldName(key)];

// The setting's value: GAMEBAR_<key> when it is set, else the old name's value, else undefined.
export function envGet(key, env = process.env) {
  const v = env[newName(key)];
  return v !== undefined ? v : env[oldName(key)];
}
