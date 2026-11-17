#!/usr/bin/env node
// The element and visual descriptors: every parameter a draw reads is declared with a default, a
// visual takes only the value types it declares, and the visuals draw what today's renderers draw.

import { mkdtempSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

// Before the import: the sandbox is the runtime directory the raster caches its images in.
const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-elements-"));
Object.assign(process.env, { ...sandboxEnv(SB) });

const { VISUALS, CONTAINERS, FRAMES, elementKind, canShow, accepts } = await import("../../src/kit/elements/index.js");
const { VALUE_TYPES, CATALOGUE } = await import("../../src/metrics/catalogue.js");
const { vlen } = await import("../../src/kit/text.js");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPRITES = path.join(ROOT, "games", "doom", "assets", "images", "mugshot");
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
    // What the box layout's bar drew before skins, byte for byte.
    const oracle = "\x1b[48;2;0;0;0m\x1b[38;2;204;187;70m█████▉        \x1b[49m\x1b[38;2;204;187;70m  42%";
    const drawn = VISUALS.progress.draw({ value: 42, params: p, width: VISUALS.progress.widths(p).natural });
    ok(drawn.length === 1 && drawn[0] === oracle, `42 % at 14 cells draws what the old bar draws (${JSON.stringify(drawn[0])})`);
    const boxRgb = [28, 32, 54];
    const inBox = VISUALS.progress.draw({ value: 77, params: { ...p, icon: "🧠" }, width: 3 + 9 + 5, surface: boxRgb });
    ok(inBox[0] === "🧠 \x1b[48;2;14;16;27m\x1b[38;2;224;130;64m██████▉  \x1b[48;2;28;32;54m\x1b[38;2;224;130;64m  77%",
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
    const hearts = VISUALS["icon-row"].validate({ glyph: "♥", empty_glyph: "♡", count: 10, gap: 1 }).params;
    const hw = VISUALS["icon-row"].widths(hearts);
    ok(hw.min === 10 && hw.natural === 19 && hw.max === 19, `gaps make the row 19 columns, and it can close them up to 10 (${JSON.stringify(hw)})`);
    ok(plain(VISUALS["icon-row"].draw({ value: 40, params: hearts, width: 19 })[0]) === "♥ ♥ ♥ ♥ ♡ ♡ ♡ ♡ ♡ ♡"
      && plain(VISUALS["icon-row"].draw({ value: 40, params: hearts, width: 10 })[0]) === "♥♥♥♥♡♡♡♡♡♡",
      "with room the hearts stand a space apart; in a narrow bar side by side");
  }

  console.log("icon:");
  {
    const p = VISUALS.icon.validate({ width: 13 }).params;
    ok(plain(VISUALS.icon.draw({ value: "high", params: p, width: 13 })[0]).trim() === "🌔", "an effort level is drawn as its moon by default");
    ok(plain(VISUALS.icon.draw({ value: [["thinking", "on"], ["fast", "off"]], params: p, width: 13 })[0]).trim() === "💡  🚶",
      "mode flags with an icon for their state are drawn as that icon alone (thinking on 💡, fast off 🚶)");
    ok(plain(VISUALS.icon.draw({ value: [["thinking", "off"], ["fast", "on"]], params: p, width: 13 })[0]).trim() === "👄  🏃",
      "and the other states as theirs (thinking off 👄, fast on 🏃)");
    ok(plain(VISUALS.icon.draw({ value: [["thinking", "maybe"]], params: p, width: 13 })[0]).trim() === "💭 maybe",
      "a state without an icon of its own keeps the name's icon and the state's text");
    ok(["default", "explanatory", "learning"].map((v) => plain(VISUALS.icon.draw({ value: v, params: p, width: 2 })[0])).join(" ") === "👷 💁 🙋",
      "Claude Code's output styles have their figures");
    const other = VISUALS.icon.validate({ width: 2, other: "🎨" }).params;
    ok(plain(VISUALS.icon.draw({ value: "my-style", params: other, width: 2 })[0]) === "🎨" && plain(VISUALS.icon.draw({ value: "my-style", params: p, width: 8 })[0]).trim() === "my-style",
      "`other` gives a value the map has no icon for its icon; without it the value is drawn as it is");
  }

  console.log("text, first words:");
  {
    const p = VISUALS.text.validate({ width: 8, min_width: 4, words: 1 }).params;
    ok(plain(VISUALS.text.draw({ value: "Opus 5.5", params: p, width: 8 })[0]).trim() === "Opus", "words = 1 draws a model's name without its version");
    const all = VISUALS.text.validate({ width: 8, min_width: 4 }).params;
    ok(plain(VISUALS.text.draw({ value: "Opus 5.5", params: all, width: 8 })[0]).trim() === "Opus 5.5", "by default the whole value is drawn");
  }

  console.log("grid frame:");
  {
    const g = FRAMES.grid;
    const p = g.validate({ selected_lines: "╔═╦╗║╚╩╝" }).params;
    const kids = Array.from({ length: 9 }, (_, i) => ({ lines: [` ${i} `], width: 3 }));
    const width = 9 * 3 + g.extra(p, 9).columns;
    const lines = g.draw({ params: p, width, height: 3, children: kids, selected: 4 }).map(plain);
    ok(lines[0] === "┏━━━┳━━━┳━━━┳━━━╔═══╗━━━┳━━━┳━━━┳━━━┓", `the selected cell's top has its highlight lines, its joints drawn as its corners (${lines[0]})`);
    ok(lines[1] === "┃ 0 ┃ 1 ┃ 2 ┃ 3 ║ 4 ║ 5 ┃ 6 ┃ 7 ┃ 8 ┃", `the selected cell's sides have its highlight lines (${lines[1]})`);
    ok(lines[2] === "┗━━━┻━━━┻━━━┻━━━╚═══╝━━━┻━━━┻━━━┻━━━┛", "and so does its bottom");
    const ends = (sel) => g.draw({ params: p, width, height: 3, children: kids, selected: sel }).map(plain);
    ok(ends(0)[0].startsWith("╔═══╗━━━┳") && ends(8)[2].endsWith("┻━━━╚═══╝"), "a selected cell at either end has its own corners");
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
    ok(FRAMES.box.minWidth(bx) === 7 && FRAMES.box.minWidth({ ...bx, padding: 2 }) === 9, "a box is at least as wide as its title and padding");
    ok(FRAMES.box.minWidth({ ...bx, header: false }) === 0, "a box without its title row asks for nothing more");
  }

  console.log("grow:");
  {
    const growing = [{ min: 2, natural: 4, max: Infinity }, { min: 3, natural: 3, max: 3 }, { min: 1, natural: 2, max: Infinity }];
    const fill = (c) => c.validate({ grow: "fill" }).params;
    ok(JSON.stringify(CONTAINERS.column.share(defaults(CONTAINERS.column), 10, growing)) === JSON.stringify([4, 3, 2]),
      "a column's children keep their own widths by default");
    ok(JSON.stringify(CONTAINERS.column.share(fill(CONTAINERS.column), 10, growing)) === JSON.stringify([10, 3, 10]),
      "with grow = fill each takes the column's width, up to the most it can use");
    ok(JSON.stringify(CONTAINERS.row.share(defaults(CONTAINERS.row), 15, growing)) === JSON.stringify([4, 3, 2]),
      "a row leaves its surplus to its alignment by default");
    ok(JSON.stringify(CONTAINERS.row.share(fill(CONTAINERS.row), 16, growing)) === JSON.stringify([8, 3, 5]),
      "with grow = fill the surplus is shared evenly by the children that can grow, the first taking the odd column");
    ok(JSON.stringify(CONTAINERS.row.share(fill(CONTAINERS.row), 7, growing)) === JSON.stringify(CONTAINERS.row.share(defaults(CONTAINERS.row), 7, growing)),
      "a row short of width shrinks as it always does");
  }

  console.log("equalizer sizing:");
  {
    const eq = VISUALS.equalizer;
    const cores = [0.1, 0.5, 0.9, 1];
    const stretch = defaults(eq);
    ok(JSON.stringify(eq.widths(stretch, cores)) === JSON.stringify(eq.widths(stretch, [0.1]))
      && eq.widths(stretch, cores).natural === 16, "stretch, the default: the values spread over its columns, however many there are");
    const per = eq.validate({ sizing: "values", icon: "🔥" }).params;
    const w = eq.widths(per, cores);
    ok(w.natural === 3 + 4 && w.max === 3 + 4 && w.min === 3 + 4, `values: one column per value, 4 cores in 4 columns (${JSON.stringify(w)})`);
    ok(plain(eq.draw({ value: cores, params: per, width: w.natural })[0]) === "🔥 ▁▄▇█", "each value drawn in its own column");
    const wide = eq.validate({ sizing: "values", column_width: 2 }).params;
    ok(eq.widths(wide, cores).natural === 8 && plain(eq.draw({ value: cores, params: wide, width: 8 })[0]) === "▁▁▄▄▇▇██",
      "column_width columns per value");
    ok(eq.widths(per, Array(40).fill(0.5)).natural === 3 + 16 && eq.widths(per, Array(40).fill(0.5)).min === 3 + 4,
      "at most `columns` wide, and min_columns when the bar is narrow");
    ok(eq.widths(per, undefined).natural === 3, "no values, no columns");
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
    // A frame name that is not a plain file name never reaches outside the frames folder: an image
    // beside the folder exists, and the escaped name still draws the default frame.
    copyFileSync(path.join(SPRITES, "STFDEAD0.png"), path.join(SB, "outside.png"));
    for (const frame of ["../outside", "../outside.png", path.join(SB, "outside.png"), "sub/../dead", "sub\\..\\dead", ".", ".."]) {
      const escaped = a.draw({ params: withDefault, width: w, height: 4, ctx: CTX, script: { frame } });
      ok(JSON.stringify(escaped) === JSON.stringify(idle), `a frame named ${JSON.stringify(frame)} draws the default frame`);
    }
    const half = a.draw({ params: withDefault, width: w, height: 4, ctx: { ...CTX, step: "half" } });
    const glyphs = new Set(half.flatMap((l) => [...plain(l)]));
    ok([...glyphs].every((ch) => " █▀▄▌▐".includes(ch)), "the terminal's glyph step is the ceiling");

    const a3 = VISUALS["animation-3d"];
    const model = a3.validate({ model: "test:model.glb", default_frame: "test:idle" }).params;
    ok(JSON.stringify(a3.draw({ params: model, width: w, height: 4, ctx: CTX })) === JSON.stringify(idle), "a 3D animation draws its default frame");
    const bare = a3.validate({ model: "test:model.glb" }).params;
    ok(a3.draw({ params: bare, width: w, height: 4, ctx: CTX }).every((l) => l === " ".repeat(w)), "and without one a blank");
  }

  console.log("coverage of the games' bars:");
  {
    ok(["box", "grid"].every((f) => FRAMES[f]) && VISUALS.animation && VISUALS["icon-row"] && VISUALS.progress,
      "the boxes, the hotbar, the mugshot, hearts and hunger, and the XP bar have descriptors");
  }
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
