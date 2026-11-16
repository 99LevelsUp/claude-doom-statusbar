#!/usr/bin/env node
// Drawing a fitted skin, and the warning line under the bar. Containers draw their children inside
// their frames, the bar is centred in the terminal's width, and a skin drawn clipped never runs
// past it. A warning shows as one dim line naming the first cause and the count of others, for 60
// seconds after its cause first appeared.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-skin-draw-"));
Object.assign(process.env, { ...sandboxEnv(SB) });

const { loadSkin, buildSkin } = await import("../../src/kit/skin/load.js");
const { fitSkin } = await import("../../src/kit/skin/fit.js");
const { drawFit, clipLine } = await import("../../src/kit/skin/draw.js");
const { warningLine, memoryStore, fileStore, WARNING_SECONDS } = await import("../../src/kit/skin/warnings.js");
const { vlen } = await import("../../src/kit/text.js");

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "skins");
const byName = (name) => loadSkin(path.join(FIX, `${name}.toml`)).skin;
const plain = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");
const inline = (element) => {
  const { skin, warnings } = buildSkin({ version: 1, root: "bar", element });
  if (warnings.length) throw new Error(JSON.stringify(warnings));
  return skin;
};

const VALUES = { "model.name": "Opus", "model.window": "1M", "act.subagents": [["review", "12s"]] };
const CTX = { tick: 0 };

try {
  console.log("the 140-column skin drawn at 200, 120 and 60 columns");
  {
    const wide = byName("fit-wide");
    for (const width of [200, 120, 60]) {
      const fit = fitSkin(wide, { values: VALUES, width, loadSmaller: byName });
      const lines = drawFit(fit, { values: VALUES, width, ctx: CTX });
      ok(lines.length === fit.tree.rows, `${width}: as many lines as the fitted tree has rows (${lines.length})`);
      ok(lines.every((l) => vlen(l) <= width), `${width}: no line is wider than the terminal`);
      ok(lines.every((l) => vlen(l) === Math.floor((width - fit.width) / 2) + fit.width), `${width}: every line is the bar centred in the terminal`);
    }
    const at200 = drawFit(fitSkin(wide, { values: VALUES, width: 200, loadSmaller: byName }), { values: VALUES, width: 200, ctx: CTX });
    const top = plain(at200[0]);
    ok(top.startsWith(" ".repeat(25)) && /MODEL.*CONTEXT.*AGENTS/.test(top), "the boxes' titles head their columns, the bar 25 columns in");
    ok(plain(at200[1]).includes("Opus") && plain(at200[1]).includes("review") && plain(at200[1]).includes("12s"), "each box draws its metric inside it");
    ok(at200.length === 5, "the row is as tall as its tallest child, a box of a 4-row list under its title");
    const at120 = drawFit(fitSkin(wide, { values: VALUES, width: 120, loadSmaller: byName }), { values: VALUES, width: 120, ctx: CTX });
    ok(!plain(at120.join("\n")).includes("AGENTS") && at120.length === 2, "at 120 columns the dropped box is not drawn and the bar is two rows");
  }

  console.log("a skin drawn clipped");
  {
    const fit = fitSkin(byName("cycle-a"), { values: { "model.name": "x".repeat(100) }, width: 60, loadSmaller: byName });
    const lines = drawFit(fit, { values: { "model.name": "x".repeat(100) }, width: 60, ctx: CTX });
    ok(lines.length === 1 && vlen(lines[0]) === 60 && lines[0].endsWith("\x1b[0m"), "its lines are cut at the terminal's width and the colours reset");
  }

  console.log("clipping a line that carries colours and links");
  {
    const link = "\x1b]8;;https://example.com\x1b\\linked\x1b]8;;\x1b\\";
    const line = "\x1b[38;2;1;2;3m" + "ab" + link + "\x1b[0mtail";
    const cut = clipLine(line, 5);
    ok(plain(cut) === "ablin" && vlen(cut) === 5, "escapes take no columns; the visible text is cut");
    ok(cut.includes("\x1b[38;2;1;2;3m") && cut.endsWith("\x1b]8;;\x1b\\\x1b[0m"), "the colour stays and an open link is closed before the reset");
    ok(plain(clipLine("a😀b", 2)) === "a", "a wide glyph that would cross the edge is left out");
    ok(clipLine("short", 10) === "short", "a line that fits is left as it is");
  }

  console.log("absent metrics, empty lists and frames");
  {
    const skin = inline({
      bar: { kind: "row", children: ["name", "branch", "tasks"] },
      name: { kind: "text", metric: "model.name", width: 6, min_width: 6 },
      branch: { kind: "text", metric: "git.branch", width: 10, min_width: 10 },
      tasks: { kind: "scroll-list", metric: "act.tasklist", width: 8, min_width: 8, rows: 2 },
    });
    const values = { "model.name": "Opus" };
    const lines = drawFit(fitSkin(skin, { values, width: 14 }), { values, width: 14, ctx: CTX });
    ok(lines.length === 2 && lines.every((l) => vlen(l) === 14), "the absent text takes no space and the empty list keeps its 8 columns");
    ok(plain(lines[0]) === "Opus" + " ".repeat(10), "the list with no items draws blank");

    const face = inline({
      bar: { kind: "row", children: ["left", "mug", "right"] },
      left: { kind: "text", metric: "model.name", width: 4, min_width: 4 },
      mug: { kind: "animation", metric: "health.headroom", frames: "game:images/face", script: "game:scripts/face.js", width: 5, rows: 1 },
      right: { kind: "text", metric: "model.window", width: 2, min_width: 2 },
    });
    const fv = { "model.name": "Opus", "model.window": "1M", "health.headroom": 50 };
    const drawn = drawFit(fitSkin(face, { values: fv, width: 11 }), { values: fv, width: 11, ctx: CTX }).map(plain);
    ok(drawn.length === 1 && drawn[0] === "Opus" + " ".repeat(5) + "1M",
      `an element whose script did not run draws its default visual, a blank of its width, and its neighbours stay put (${JSON.stringify(drawn)})`);

    const hotbar = inline({
      bar: { kind: "row", children: ["a", "b"], frame: { kind: "grid", lines: "+-++|+++", selected_lines: "#=##I###" } },
      a: { kind: "text", metric: "model.name", width: 3, min_width: 3 },
      b: { kind: "text", metric: "model.window", width: 3, min_width: 3 },
    });
    const hv = { "model.name": "abc", "model.window": "xyz" };
    const fit = fitSkin(hotbar, { values: hv, width: 40 });
    ok(fit.width === 9, "a grid takes its cells and a line between and around them");
    const none = drawFit(fit, { values: hv, width: 9, ctx: CTX }).map(plain);
    ok(none.join("|") === "+---+---+||abc|xyz||+---+---+", `without a script no cell is selected${none.join("|") === "+---+---+||abc|xyz||+---+---+" ? "" : ` (${none.join("|")})`}`);
    const picked = drawFit(fit, { values: hv, width: 9, ctx: CTX, scripts: { bar: { selected: 1 } } }).map(plain);
    ok(picked[1] === "|abcIxyzI", `the cell the script selects is drawn with its own lines (${picked[1]})`);
  }

  console.log("the warning line");
  {
    const w = (key, message) => ({ key, cause: "unknown-param", message });
    const store = memoryStore();
    const first = [w("a", "skin \"mine.toml\", element \"x\": unknown parameter \"glow\"; ignored")];
    const at0 = warningLine(first, { store, now: 1000, width: 200 });
    ok(at0 !== null && at0.startsWith("\x1b[2m") && plain(at0).includes("unknown parameter \"glow\""), "a new cause shows as a dim line naming it");
    ok(warningLine(first, { store, now: 1030, width: 200 }) !== null, "it still shows 30 seconds later");
    ok(warningLine(first, { store, now: 1061, width: 200 }) === null, "61 seconds after it first appeared it shows no more");
    ok(WARNING_SECONDS === 60, "a cause shows for 60 seconds");

    const more = [first[0], w("b", "second"), w("c", "third"), w("b", "second")];
    const line = plain(warningLine(more, { store, now: 1070, width: 200 }));
    ok(line.includes("second") && line.includes("(+1 more)") && !line.includes("third") && !line.includes("glow"),
      `the line names the first young cause and counts the other young ones (${line})`);
    ok(vlen(warningLine(more, { store, now: 1070, width: 20 })) <= 20, "the line fits the terminal's width");
    ok(warningLine([], { store, now: 1070, width: 200 }) === null, "no warnings, no line");

    const file = path.join(SB, "warnings.json");
    ok(warningLine(first, { store: fileStore(file), now: 0, width: 200 }) !== null, "a file store records a cause at its first render");
    ok(warningLine(first, { store: fileStore(file), now: 30, width: 200 }) !== null, "another process reading the same file still shows it at 30 seconds");
    ok(warningLine(first, { store: fileStore(file), now: 61, width: 200 }) === null, "and no more at 61 seconds");
    writeFileSync(file, "not json");
    ok(warningLine(first, { store: fileStore(file), now: 100, width: 200 }) !== null, "a damaged file counts as no causes seen yet");
    ok(warningLine(first, { store: fileStore(path.join(SB, "missing-dir", "w.json")), now: 0, width: 200 }) !== null,
      "a file that cannot be written still shows the line");
  }
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
