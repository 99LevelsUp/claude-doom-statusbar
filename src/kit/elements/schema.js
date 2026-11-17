// Parameter schemas of the bar's elements and visuals. Every parameter a descriptor reads is
// declared here with its meaning, type and default, and with the values it allows where they are a
// fixed set, so a skin can be checked and a configurator can offer each parameter without knowing
// the visual.
//
// A schema entry: { type, default, meaning, allowed?, min?, max?, keywords? }
//   text      a string; `allowed` lists the only values it may take, `length` the exact number of
//             characters it must have
//   integer   a whole number between `min` and `max` when they are given
//   number    a finite number between `min` and `max` when they are given
//   boolean   true or false
//   color     "#rrggbb", or one of its `keywords` (such as "term-bg", the terminal's own colour)
//   gradient  how a value colours itself: "threshold" (green to yellow to red), "#rrggbb" (one
//             colour), a list of [value, "#rrggbb"] stops, or "" for the visual's own colour
//   map       a table of names to strings; a skin's table is laid over the default, so it changes
//             or adds names without repeating the rest
//   list      a list of strings
//   asset     a reference to an asset file or folder; "" for none

import { isPlainObject } from "../is.js";

const HEX = /^#[0-9a-fA-F]{6}$/;
const isHex = (v) => typeof v === "string" && HEX.test(v);

const CHECKS = {
  text: (v, s) => typeof v === "string" && (s.length === undefined || [...v].length === s.length),
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  color: (v, s) => isHex(v) || (s.keywords || []).includes(v),
  gradient: (v) => v === "threshold" || v === "" || isHex(v) ||
    (Array.isArray(v) && v.length > 0 && v.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && isHex(p[1]))),
  map: (v) => isPlainObject(v) && Object.values(v).every((x) => typeof x === "string"),
  list: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  asset: (v) => typeof v === "string",
};

export const PARAM_TYPES = Object.keys(CHECKS);

export const param = (type, def, meaning, extra = {}) => ({ type, default: def, meaning, ...extra });

function valid(s, v) {
  if (!CHECKS[s.type](v, s)) return false;
  if (s.allowed && !s.allowed.includes(v)) return false;
  if (s.min !== undefined && v < s.min) return false;
  if (s.max !== undefined && v > s.max) return false;
  return true;
}

function describeAllowed(s) {
  if (s.allowed) return `one of ${s.allowed.map((a) => JSON.stringify(a)).join(", ")}`;
  if (s.length !== undefined) return `${s.length} character${s.length === 1 ? "" : "s"} long`;
  if (s.type === "color") return `"#rrggbb"${(s.keywords || []).map((k) => ` or "${k}"`).join("")}`;
  const range = s.min !== undefined && s.max !== undefined ? ` from ${s.min} to ${s.max}`
    : s.min !== undefined ? ` of at least ${s.min}` : "";
  return `a ${s.type}${range}`;
}

// The parameters a descriptor draws with: every declared parameter, the given value where it is
// valid, else the default. Each given parameter the schema does not declare, and each given value
// the schema does not allow, is reported in `problems` ({ param, problem, message }, problem
// "unknown" or "invalid") so the caller can say what it skipped.
export function validateParams(schema, given = {}) {
  const params = {};
  const problems = [];
  for (const [name, s] of Object.entries(schema)) params[name] = s.default;
  for (const [name, v] of Object.entries(given || {})) {
    const s = Object.hasOwn(schema, name) ? schema[name] : null;
    if (!s) {
      problems.push({ param: name, problem: "unknown", message: `unknown parameter "${name}"` });
    } else if (!valid(s, v)) {
      problems.push({ param: name, problem: "invalid", message: `parameter "${name}" must be ${describeAllowed(s)}` });
    } else {
      params[name] = s.type === "map" ? { ...s.default, ...v } : v;
    }
  }
  return { params, problems };
}

// A descriptor with its schema frozen and its own `validate(given)`.
export function define(desc) {
  const params = Object.freeze({ ...desc.params });
  return Object.freeze({ ...desc, params, validate: (given) => validateParams(params, given) });
}
