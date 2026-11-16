#!/usr/bin/env node
// The element and visual descriptors: every parameter a draw reads is declared with a default, a
// visual takes only the value types it declares, and the visuals draw what today's renderers draw.

import { mkdtempSync, readFileSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { sandboxEnv } from "../_sandbox-env.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

// Before the import: the sandbox is the runtime directory the raster caches its images in.
const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-elements-"));
Object.assign(process.env, { ...sandboxEnv(SB) });

const { VISUALS, CONTAINERS, FRAMES, elementKind, canShow, accepts } = await import("../../src/kit/elements/index.js");
const { VALUE_TYPES, CATALOGUE } = await import("../../src/metrics/catalogue.js");
const { renderValue } = await import("../../src/kit/meters.js");
const { vlen } = await import("../../src/kit/text.js");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPRITES = path.join(ROOT, "src", "games", "doom", "assets", "mugshot", "alpha");
const plain = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");
const defaults = (d) => d.validate({}).params;

// A frames folder and a default frame, reached through the render context's resolveAsset.
const FRAMES_DIR = path.join(SB, "frames");
mkdirSync(FRAMES_DIR);
copyFileSync(path.join(SPRITES, "STFST01.png"), path.join(FRAMES_DIR, "idle.png"));
copyFileSync(path.join(SPRITES, "STFDEAD0.png"), path.join(FRAMES_DIR, "dead.png"));
const ASSETS = { "test:frames": FRAMES_DIR, "test:idle": path.join(FRAMES_DIR, "idle.png") };
const CTX = { tick: 3, step: "octant", resolveAsset: (ref) => ASSETS[ref] ?? null };

// Raw values of each type, several shapes where a type has several.
const SAMPLES = {
  percentage: [42, 0, 100],
  number: [7],
  text: ["Opus 5.5", { text: "feature/a-very-long-branch-name", url: "https://example.test" }, "high", "plan"],
  list: [
    [["thinking", "on"], ["fast", "off"]],
    [{ status: "completed", text: "done" }, { status: "in_progress", text: "now" }, { status: "pending", text: "next" },
      { status: "pending", text: "later" }, { status: "pending", text: "last" }],
    [["Explore the repo", "12s"]],
    [0.1, 0.5, 0.9, 1],
  ],
  timeseries: [[0, 0.2, 0.4, 1, 0.6, 0, 0.3]],
  conversation: [[]],
};

try {
  console.log("parameters read by a draw are declared with a default:");
  {
    // A parameter object that records every name read from it.
    const recorder = (params, reads) => new Proxy(params, {
      get(t, k) { if (typeof k === "string") reads.add(k); return t[k]; },
      has(t, k) { if (typeof k === "string") reads.add(k); return k in t; },
    });
    const undeclared = (d, reads) => [...reads].filter((k) => !Object.hasOwn(d.params, k) || !("default" in d.params[k]));
    const lineWidths = (lines, width) => lines.every((l) => vlen(l) === width);

    for (const v of Object.values(VISUALS)) {
      const reads = new Set();
      const p = recorder(defaults(v), reads);
      const { min, natural } = v.widths(p);
      const rows = v.rows(p);
      let sized = true;
      for (const type of v.accepts) {
        for (const value of SAMPLES[type]) {
          for (const width of [natural, min]) {
            const lines = v.draw({ value, params: p, width, height: rows, ctx: CTX, script: { frame: "dead" } });
            sized &&= lines.length === rows && lineWidths(lines, width);
          }
        }
      }
      const bad = undeclared(v, reads);
      ok(bad.length === 0, `${v.name} reads only declared parameters with defaults${bad.length ? ` (undeclared: ${bad.join(", ")})` : ""}`);
      ok(sized, `${v.name} draws its rows at exactly the width it is given`);
      ok(v.accepts.length > 0 && v.accepts.every((t) => VALUE_TYPES.includes(t)), `${v.name} accepts catalogue value types (${v.accepts.join(", ")})`);
    }

    const kids = [{ lines: ["aa", "bb"], width: 2 }, { lines: ["c"], width: 1 }];
    for (const c of Object.values(CONTAINERS)) {
      const reads = new Set();
      const p = recorder(defaults(c), reads);
      const w = c.widths(p, [{ min: 1, natural: 2 }, { min: 1, natural: 1 }]);
      c.share(p, 2, [{ min: 1, natural: 2 }, { min: 1, natural: 1 }]);
      const height = c.rows(p, [2, 1]);
      const lines = c.draw({ params: p, width: w.natural + 2, height, children: kids });
      const bad = undeclared(c, reads);
      ok(bad.length === 0, `${c.name} reads only declared parameters with defaults${bad.length ? ` (undeclared: ${bad.join(", ")})` : ""}`);
      ok(lines.length === height && lineWidths(lines, w.natural + 2), `${c.name} draws ${height} rows at its width`);
    }
    for (const f of Object.values(FRAMES)) {
      const reads = new Set();
      const p = recorder(defaults(f), reads);
      const extra = f.extra(p, kids.length);
      f.surface(p);
      const width = 3 + extra.columns, height = 2 + extra.rows;
      const lines = f.draw({ params: p, width, height, content: ["abc", "def"], children: kids, selected: 0 });
      const bad = undeclared(f, reads);
      ok(bad.length === 0, `${f.name} reads only declared parameters with defaults${bad.length ? ` (undeclared: ${bad.join(", ")})` : ""}`);
      ok(lines.length === height && lineWidths(lines, width), `${f.name} draws ${height} rows at its width`);
    }
  }

  console.log("value types:");
  {
    const bar = VISUALS.progress;
    ok(!accepts(bar, "text") && !canShow(bar, "model.name"), "a progress bar is not offered for a text metric (model.name)");
    ok(canShow(bar, "context.hp") && canShow(bar, "ratelimit.5h"), "a progress bar is offered for percentage metrics");
    ok(!canShow(bar, "no.such.metric"), "nothing is offered for a metric the catalogue does not have");
    ok(canShow(VISUALS.sparkline, "act.geiger") && !canShow(VISUALS.sparkline, "sys.ram"), "a sparkline is offered only for a time series");
    ok(canShow(VISUALS.equalizer, "sys.cores"), "the equalizer takes the per-core list");
    ok(canShow(VISUALS.icon, "model.effort") && canShow(VISUALS.icon, "model.mode") && canShow(VISUALS.icon, "git.work"),
      "the icon visual takes effort levels and lists of [name, value] pairs");
    ok(canShow(VISUALS["scroll-list"], "act.tasklist") && canShow(VISUALS["scroll-list"], "act.subagents"), "the scrolling list takes tasks and subagents");
    ok(Object.keys(CATALOGUE).every((id) => Object.values(VISUALS).some((v) => canShow(v, id))), "every catalogue metric has a visual that can show it");
  }

  console.log("parameters are validated:");
  {
    const { params, problems } = VISUALS.progress.validate({ cells: 10, colour: "#ff0000", percent: "top", fill: "##" });
    ok(params.cells === 10, "a valid parameter is used");
    ok(params.percent === "right" && params.fill === "█", "an invalid parameter falls back to its default");
    const by = Object.fromEntries(problems.map((p) => [p.param, p.problem]));
    ok(by.colour === "unknown" && by.percent === "invalid" && by.fill === "invalid" && problems.length === 3,
      `unknown and invalid parameters are reported (${problems.map((p) => p.message).join("; ")})`);
    const icons = VISUALS.icon.validate({ icons: { high: "H" } }).params.icons;
    ok(icons.high === "H" && icons.low === "🌒", "a skin's icon map is laid over the platform's");
    ok(elementKind("row") === CONTAINERS.row && elementKind("progress") === VISUALS.progress && elementKind("box") === null,
      "an element kind is a container or a visual; a frame is not an element kind");
  }

  console.log("progress bar:");
  {
    const p = defaults(VISUALS.progress);
    const oracle = renderValue({ values: { x: 42 } }, { id: "x", render: "bar" }, 14, [0, 0, 0]);
    const drawn = VISUALS.progress.draw({ value: 42, params: p, width: VISUALS.progress.widths(p).natural });
    ok(drawn.length === 1 && drawn[0] === oracle, `42 % at 14 cells draws what the old bar draws (${JSON.stringify(drawn[0])})`);
    const boxRgb = [28, 32, 54];
    const inBox = VISUALS.progress.draw({ value: 77, params: { ...p, icon: "🧠" }, width: 3 + 9 + 5, surface: boxRgb });
    ok(inBox[0] === renderValue({ values: { x: 77 } }, { id: "x", render: "bar", icon: "🧠" }, 9, boxRgb),
      "with an icon, at 9 cells on a box background it still draws what the old bar draws");
    const xp = VISUALS.progress.validate({ fill: "━", partials: "", empty: "━", empty_color: "#1f3a12", track: "none", percent: "middle", color: "#80ff20" }).params;
    ok(plain(VISUALS.progress.draw({ value: 31, params: xp, width: 20 })[0]) === "━━━━━━━━ 31 ━━━━━━━━", "an XP-style bar has its level cut into its middle");
  }

  console.log("icon row:");
  {
    const p = VISUALS["icon-row"].validate({ glyph: "♥", empty_glyph: "♡", count: 10 }).params;
    const [line] = VISUALS["icon-row"].draw({ value: 60, params: p, width: VISUALS["icon-row"].widths(p).natural });
    ok(plain(line) === "♥♥♥♥♥♥♡♡♡♡", `60 % over 10 icons draws 6 full and 4 empty (${plain(line)})`);
    const food = VISUALS["icon-row"].validate({ glyph: "🍖", empty_glyph: "🦴", count: 5, invert: true, from_right: true, gap: 1 }).params;
    ok(plain(VISUALS["icon-row"].draw({ value: 60, params: food, width: 14 })[0]) === "🦴 🦴 🦴 🍖 🍖", "inverted and from the right, 60 % used leaves 2 of 5 lit at the right end");
  }

  console.log("icon:");
  {
    const p = VISUALS.icon.validate({ width: 13 }).params;
    ok(plain(VISUALS.icon.draw({ value: "high", params: p, width: 13 })[0]).trim() === "🌔", "an effort level is drawn as its moon by default");
    ok(plain(VISUALS.icon.draw({ value: [["thinking", "on"], ["fast", "off"]], params: p, width: 13 })[0]) === "💭 on  🚀 off", "mode flags are drawn as their icons and states");
  }

  console.log("grid frame:");
  {
    const g = FRAMES.grid;
    const p = g.validate({ selected_lines: "╔═╦╗║╚╩╝" }).params;
    const kids = Array.from({ length: 9 }, (_, i) => ({ lines: [` ${i} `], width: 3 }));
    const width = 9 * 3 + g.extra(p, 9).columns;
    const lines = g.draw({ params: p, width, height: 3, children: kids, selected: 4 }).map(plain);
    ok(lines[0] === "┏━━━┳━━━┳━━━┳━━━╦═══╦━━━┳━━━┳━━━┳━━━┓", `the selected cell's top has its highlight lines (${lines[0]})`);
    ok(lines[1] === "┃ 0 ┃ 1 ┃ 2 ┃ 3 ║ 4 ║ 5 ┃ 6 ┃ 7 ┃ 8 ┃", `the selected cell's sides have its highlight lines (${lines[1]})`);
    ok(lines[2] === "┗━━━┻━━━┻━━━┻━━━╩═══╩━━━┻━━━┻━━━┻━━━┛", "and so does its bottom");
    const raw = g.draw({ params: p, width, height: 3, children: kids, selected: 4 })[1];
    ok(raw.includes("\x1b[38;2;255;255;255m║"), "the highlight lines are drawn in the selected colour");
    for (const selected of [undefined, -1, 9]) {
      const none = g.draw({ params: p, width, height: 3, children: kids, selected });
      ok(none.every((l) => !/[╔═╦╗║╚╩╝]/.test(plain(l)) && !l.includes("\x1b[38;2;255;255;255m")),
        `with no selected cell (${selected}) no line is highlighted`);
    }
  }

  console.log("box frame and row:");
  {
    const bx = FRAMES.box.validate({ title: "USAGE", background: "#1c2036" }).params;
    const lines = FRAMES.box.draw({ params: bx, width: 11, height: 3, content: ["abcdefghi"] });
    ok(plain(lines[0]) === "   USAGE   " && plain(lines[1]) === " abcdefghi " && plain(lines[2]) === " ".repeat(11), "a box draws its centred title, padded content and blank rows");
    const r = CONTAINERS.row.validate({ separator: "│", align: "center" }).params;
    const rowLines = CONTAINERS.row.draw({ params: r, width: 9, height: 1, children: [{ lines: ["ab"], width: 2 }, { lines: ["cd"], width: 2 }] });
    ok(plain(rowLines[0]) === "  ab│cd  ", `a centred row joins its children with its separator (${plain(rowLines[0])})`);
    const kids = [{ min: 4, natural: 14 }, { min: 10, natural: 24 }, { min: 5, natural: 5 }];
    ok(JSON.stringify(CONTAINERS.row.share(defaults(CONTAINERS.row), 43, kids)) === JSON.stringify([14, 24, 5]), "children that fit keep their natural widths");
    const lock = CONTAINERS.row.share(defaults(CONTAINERS.row), 30, kids);
    ok(lock.reduce((a, b) => a + b, 0) <= 30 && lock[0] < 14 && lock[1] < 24 && lock[2] === 5, `in lockstep the elastic children shrink together (${lock})`);
    const fromEnd = CONTAINERS.row.share(CONTAINERS.row.validate({ shrink: "end" }).params, 30, kids);
    ok(JSON.stringify(fromEnd) === JSON.stringify([14, 11, 5]), `from the end the last elastic child shrinks first (${fromEnd})`);
  }

  console.log("animation:");
  {
    const a = VISUALS.animation;
    const none = a.validate({}).params;
    const w = a.widths(none).min;
    const blank = a.draw({ params: none, width: w, height: 4, ctx: CTX });
    ok(blank.length === 4 && blank.every((l) => l === " ".repeat(w)), "with no frames and no default frame it draws a blank of its minimum width");
    const withDefault = a.validate({ frames: "test:frames", default_frame: "test:idle" }).params;
    const idle = a.draw({ params: withDefault, width: w, height: 4, ctx: CTX });
    ok(idle.every((l) => vlen(l) === w) && idle.some((l) => plain(l).trim()), "with a default frame it draws that frame");
    const missing = a.draw({ params: withDefault, width: w, height: 4, ctx: CTX, script: { frame: "nosuchframe" } });
    ok(JSON.stringify(missing) === JSON.stringify(idle), "a frame the folder does not have draws the default frame");
    const dead = a.draw({ params: withDefault, width: w, height: 4, ctx: CTX, script: { frame: "dead" } });
    ok(JSON.stringify(dead) !== JSON.stringify(idle) && dead.every((l) => vlen(l) === w), "a frame from the script is drawn instead");
    const half = a.draw({ params: withDefault, width: w, height: 4, ctx: { ...CTX, step: "half" } });
    const glyphs = new Set(half.flatMap((l) => [...plain(l)]));
    ok([...glyphs].every((ch) => " █▀▄▌▐".includes(ch)), "the terminal's glyph step is the ceiling");

    const a3 = VISUALS["animation-3d"];
    const model = a3.validate({ model: "test:model.glb", default_frame: "test:idle" }).params;
    ok(JSON.stringify(a3.draw({ params: model, width: w, height: 4, ctx: CTX })) === JSON.stringify(idle), "a 3D animation draws its default frame");
    const bare = a3.validate({ model: "test:model.glb" }).params;
    ok(a3.draw({ params: bare, width: w, height: 4, ctx: CTX }).every((l) => l === " ".repeat(w)), "and without one a blank");
  }

  console.log("coverage of today's bars:");
  {
    // Today's render types and the visuals that take their place.
    const OLD = { text: "text", number: "number", bar: "progress", spark: "sparkline", equalizer: "equalizer", scroll: "scroll-list", icons: "icon-row" };
    const presets = ["doom/presets/full.toml", "doom/presets/standard.toml", "doom/presets/minimal.toml"]
      .map((f) => parseToml(readFileSync(path.join(ROOT, "src", "games", f), "utf8")));
    const used = new Set(presets.flatMap((p) => p.segment.flatMap((s) => (s.metric || []).map((m) => m.render || "text"))));
    const missing = [...used].filter((r) => !(OLD[r] && VISUALS[OLD[r]]));
    ok(missing.length === 0, `every render type of the box presets has a visual (${[...used].join(", ")})`);
    ok(["box", "grid"].every((f) => FRAMES[f]) && VISUALS.animation && VISUALS["icon-row"] && VISUALS.progress,
      "the boxes, the hotbar, the mugshot, hearts and hunger, and the XP bar have descriptors");
  }
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
