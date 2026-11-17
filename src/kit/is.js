// An object that is neither null nor an array: a table, as JSON, TOML and scripts give one.
export const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
