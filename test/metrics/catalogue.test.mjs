#!/usr/bin/env node
// The metric catalogue and the raw values the producers emit.
//
// Every key collectValues emits for a full session has a catalogue entry whose value type matches
// the value's shape, and no value carries a colour, an icon or a hyperlink escape: presentation is
// the job of whatever draws the value.

import "../_temp-sandbox.mjs"; // before the modules that name temp paths
import { deepStrictEqual } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CATALOGUE, VALUE_TYPES } from "../../src/metrics/catalogue.js";
import { collectValues } from "../../src/metrics/index.js";
import { buildValues } from "../../src/metrics/session.js";
import { activityValues } from "../../src/metrics/activity.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const same = (a, b, m) => {
  try { deepStrictEqual(a, b); ok(true, m); } catch { ok(false, `${m}\n         got  ${JSON.stringify(a)}\n         want ${JSON.stringify(b)}`); }
};

// The shape a value of each type has (see src/metrics/catalogue.js).
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const SHAPE = {
  percentage: (v) => isNum(v) && v >= 0 && v <= 100,
  number: isNum,
  text: (v) => typeof v === "string"
    || (v !== null && typeof v === "object" && typeof v.text === "string" && (v.url === null || typeof v.url === "string")),
  list: Array.isArray,
  timeseries: (v) => Array.isArray(v) && v.every((x) => isNum(x) && x >= 0 && x <= 1),
  conversation: Array.isArray,
};
const hasEscape = (v) => (typeof v === "string" ? v.includes("\x1b")
  : v && typeof v === "object" ? Object.values(v).some(hasEscape) : false);

// --- The catalogue itself ------------------------------------------------------------------
ok(VALUE_TYPES.length === 6 && VALUE_TYPES.every((t) => t in SHAPE), "the catalogue names the six value types");
for (const [id, e] of Object.entries(CATALOGUE)) {
  ok(typeof e.name === "string" && e.name.length > 0 && VALUE_TYPES.includes(e.type),
    `${id}: has a human name and a known value type (${JSON.stringify(e)})`);
}

// --- A full session through collectValues --------------------------------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), "gamebar-catalogue-"));
try {
  const NOW = Date.now() / 1000;
  const sid = "catalogue-" + process.pid;
  const cwd = path.join(tmp, "repo");
  mkdirSync(cwd);

  // The folded session state, as a checkpoint without an offset (taken as current).
  const checkpoint = path.join(tmp, "state.json");
  writeFileSync(checkpoint, JSON.stringify({
    git: { cwd, br: "main", lr: "2\t3", st: " M a.js\n?? b.js\n" },
    mode: "plan",
    spans: [[NOW - 20, NOW - 12], [NOW - 3, null]],
    squad: { a: { desc: "hook events", start: NOW - 133 } },
    tasks: { 1: { status: "completed", title: "scaffold", ts: 1 }, 2: { status: "pending", title: "hook bus", ts: 2 } },
    tasks_ts: NOW, errors: 1, msys: { n: 4 },
  }));
  // A transcript whose last lines name the advisor model.
  const transcript = path.join(tmp, "transcript.jsonl");
  writeFileSync(transcript, JSON.stringify({ advisorModel: "claude-opus-4-8" }) + "\n");
  // Token savings: one lean-ctx event under the working directory, one LLMLingua session.
  const events = path.join(tmp, "events.jsonl");
  writeFileSync(events, JSON.stringify({ kind: { type: "ToolCall", path: path.join(cwd, "a.js"), tokens_saved: 800, tokens_original: 1000 } }) + "\n");
  const savings = path.join(tmp, "savings.json");
  writeFileSync(savings, JSON.stringify({ offset: 0, saved: 0, original: 0 }));
  const lingua = path.join(tmp, "lingua.json");
  writeFileSync(lingua, JSON.stringify({ sessions: { [sid]: { tokens_saved: 1200, last_ratio: 1.3 } } }));

  const env = {
    ...process.env, GAMEBAR_STATE: checkpoint, GAMEBAR_TASKS_DIR: path.join(tmp, "no-tasks"),
    GAMEBAR_RATELIMITS_SHARE: "0", GAMEBAR_EVENTS: events, GAMEBAR_LLMLINGUA: lingua,
    GAMEBAR_SAVINGS_STATE: savings, GAMEBAR_COLLECT_MS: "1",
  };
  const payload = {
    session_id: sid, session_name: "demo", cwd, transcript_path: transcript,
    workspace: { repo: { host: "github.com", owner: "acme", name: "bar" } },
    context_window: { used_percentage: 42.4, context_window_size: 1000000 },
    rate_limits: { five_hour: { used_percentage: 64, resets_at: NOW + 7980 }, seven_day: { used_percentage: 31, resets_at: NOW + 273600 } },
    cost: { total_cost_usd: 1.834, total_duration_ms: 21300000, total_lines_added: 185, total_lines_removed: 62 },
    model: { display_name: "Opus 4.8 (1M context)" }, effort: { level: "high" },
    thinking: { enabled: true }, fast_mode: false, output_style: { name: "default" },
    pr: { number: 1234, url: "https://github.com/acme/bar/pull/1234" },
  };
  // The first collect has no earlier CPU sample to diff against; the second, a moment later, does.
  collectValues({ ...payload }, env, NOW);
  const until = Date.now() + 40; while (Date.now() < until) { /* let the CPU counters move */ }
  const { values } = collectValues({ ...payload }, env, NOW);

  for (const [id, v] of Object.entries(values)) {
    const e = CATALOGUE[id];
    ok(!!e && SHAPE[e.type](v), `${id}: in the catalogue, and its value fits type ${e ? e.type : "?"} (got ${JSON.stringify(v)})`);
  }
  const missing = Object.keys(CATALOGUE).filter((id) => !(id in values));
  ok(missing.length === 0, `the full session emits every catalogue entry (missing: ${missing.join(", ") || "none"})`);
  const escaped = Object.keys(values).filter((id) => hasEscape(values[id]));
  ok(escaped.length === 0, `no value carries an escape sequence (found in: ${escaped.join(", ") || "none"})`);

  ok(typeof values["sys.cpu"] === "number", `sys.cpu is a number (got ${JSON.stringify(values["sys.cpu"])})`);
  ok(values["loc.churn"] === "+185 / -62", `loc.churn is plain text (got ${JSON.stringify(values["loc.churn"])})`);
  same(values["git.branch"], { text: "main", url: "https://github.com/acme/bar/tree/main" }, "git.branch carries its text and its forge link");
  same(values["loc.cwd"], { text: "repo", url: pathToFileURL(cwd).href }, "loc.cwd carries its name and a file link");
  same(values["pr.state"], { text: "#1234", url: "https://github.com/acme/bar/pull/1234" }, "pr.state carries its label and link");
  ok(values["model.permission"] === "plan", `model.permission is the mode's name (got ${JSON.stringify(values["model.permission"])})`);
  same(values["model.mode"], [["thinking", "on"], ["fast", "off"]], "model.mode lists each flag and its state, without icons");
  same(values["git.work"], [["changed", 2], ["behind", 2], ["ahead", 3]], "git.work lists its counts, without icons");
  same(values["act.tasklist"], [{ status: "completed", text: "scaffold" }, { status: "pending", text: "hook bus" }],
    "act.tasklist items carry a status, not a mark or a colour");
  ok(values["act.errors"] === 1 && values["sys.zombies"] === 4 && values["git.status"] === 2 && values["loc.added"] === 185,
    "counts are numbers");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// --- Effort is the level name ----------------------------------------------------------------
for (const level of ["low", "medium", "high", "xhigh", "max"]) {
  const v = buildValues({ effort: { level } }, null);
  ok(v["model.effort"] === level && !("model.effort_level" in v), `model.effort for ${level} is "${level}" (got ${JSON.stringify(v["model.effort"])})`);
}

// --- Absent when unknown ----------------------------------------------------------------------
{
  const v = { ...buildValues({}, null), ...activityValues({}, 1000) };
  const absent = ["git.branch", "git.status", "git.work", "git.behind", "pr.state", "loc.cwd", "loc.churn",
    "model.effort", "model.mode", "model.permission", "act.errors", "sys.zombies"];
  const present = absent.filter((id) => id in v);
  ok(present.length === 0, `keys a session does not report stay absent (present: ${present.join(", ") || "none"})`);
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
