#!/usr/bin/env node
// The frame file: one header line, one or more time slots, and a greyed copy of the last slot.
//
// The daemon writes it, the bash client picks the text for the current moment, and this module
// is the node-side reference for both. Body lines are arbitrary terminal text, so every section
// states its line count; a body line that looks like a header or a section line must come back
// as body text, never be mistaken for structure.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FRAME_VERSION, OFFLINE_MARKER, serializeFrame, parseFrame, resolveFrame, greyLines, writeFrame,
} from "../../src/platform/frame.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const sandbox = mkdtempSync(path.join(os.tmpdir(), "doombar-frame-"));

// Lines that would break a sentinel-based format, plus real ANSI and an emoji.
const TRICKY = [
  "slot 123 4",
  "grey 2",
  "doombar-frame v=9 daemon=x deadline=1 slots=1",
  "",
  "trailing spaces   ",
  "\x1b[1;38;2;224;84;64mHP 78%\x1b[22m \x1b[48;2;96;200;104m ✅ \x1b[0m",
];

// Every SGR colour in `s` must be a truecolor grey (r = g = b); no palette or basic colours.
function onlyGrey(s) {
  for (const m of s.matchAll(/\x1b\[([0-9;:]*)m/g)) {
    const p = m[1].split(";");
    for (let i = 0; i < p.length; i++) {
      if (p[i].includes(":")) return false; // colon forms must have been rewritten
      const n = Number(p[i]);
      if ((n >= 30 && n <= 37) || (n >= 40 && n <= 47) || (n >= 90 && n <= 97) || (n >= 100 && n <= 107)) return false;
      if (n === 38 || n === 48 || n === 58) {
        if (p[i + 1] !== "2") return false;
        const [r, g, b] = p.slice(i + 2, i + 5);
        if (!(r === g && g === b)) return false;
        i += 4;
      }
    }
  }
  return true;
}

try {
  // --- A one-slot frame round-trips -----------------------------------------------------------
  const one = { daemon: "0.14.0", deadline: 1762800003000000, slots: [{ start: 1762800000000000, lines: TRICKY }] };
  const text = serializeFrame(one);
  ok(text.startsWith(`doombar-frame v=${FRAME_VERSION} daemon=0.14.0 deadline=1762800003000000 slots=1\n`),
    "header line carries contract version, daemon version, deadline and slot count");
  ok(text.endsWith("\n") && !text.includes("\r"), "file is LF-only and ends with a newline");
  const parsed = parseFrame(text);
  ok(parsed && parsed.version === FRAME_VERSION && parsed.daemon === "0.14.0"
    && parsed.deadline === 1762800003000000, "header fields come back unchanged");
  ok(parsed && parsed.slots.length === 1 && parsed.slots[0].start === 1762800000000000
    && same(parsed.slots[0].lines, TRICKY), "slot body comes back unchanged, look-alike lines included");
  ok(parsed && same(parsed.grey, greyLines(TRICKY)), "greyed body comes back unchanged");
  ok(same(resolveFrame(text, 1762800001000000), { kind: "live", lines: TRICKY }),
    "a moment inside the window resolves to the live slot");

  // A line with an embedded newline is split, so the stated count stays true.
  const split = parseFrame(serializeFrame({ daemon: "1", deadline: 10, slots: [{ start: 1, lines: ["a\nb", "c\r\nd"] }] }));
  ok(split && same(split.slots[0].lines, ["a", "b", "c", "d"]), "embedded newlines become separate lines");
  const nul = parseFrame(serializeFrame({ daemon: "1", deadline: 10, slots: [{ start: 1, lines: ["a\0b"] }] }));
  ok(nul && same(nul.slots[0].lines, ["ab"]), "NUL bytes are dropped from body lines");

  // --- Three slots: the latest slot that has started ------------------------------------------
  const three = serializeFrame({
    daemon: "0.14.0", deadline: 4000,
    slots: [{ start: 1000, lines: ["first"] }, { start: 2000, lines: ["second"] }, { start: 3000, lines: ["third"] }],
  });
  ok(same(resolveFrame(three, 2500), { kind: "live", lines: ["second"] }),
    "between the second and third start resolves to the second slot");
  ok(same(resolveFrame(three, 2000), { kind: "live", lines: ["second"] }), "a slot covers its own start moment");
  ok(same(resolveFrame(three, 3500), { kind: "live", lines: ["third"] }), "after the last start resolves to the last slot");
  ok(same(resolveFrame(three, 4000), { kind: "live", lines: ["third"] }), "the deadline moment itself is still live");

  // --- Before the first slot ------------------------------------------------------------------
  ok(same(resolveFrame(three, 500), { kind: "live", lines: ["first"] }), "before the first slot resolves to the first slot");

  // --- Past the deadline ----------------------------------------------------------------------
  const past = resolveFrame(three, 4001);
  ok(past.kind === "grey" && same(past.lines, greyLines(["third"])),
    "past the deadline resolves to the greyed copy of the last slot");

  // Slots given out of order are written in start order, so the client can scan forward.
  const shuffled = parseFrame(serializeFrame({
    daemon: "1", deadline: 9, slots: [{ start: 3, lines: ["c"] }, { start: 1, lines: ["a"] }],
  }));
  ok(shuffled && same(shuffled.slots.map((s) => s.start), [1, 3]), "slots are written in ascending start order");

  // --- Unknown or unusable files --------------------------------------------------------------
  const newer = text.replace(`v=${FRAME_VERSION} `, `v=${FRAME_VERSION + 1} `);
  ok(same(resolveFrame(newer, 1762800001000000), { kind: "unknown", lines: [] }),
    "a higher contract version than the reader knows resolves to unknown");
  ok(resolveFrame("", 1).kind === "unknown", "an empty file resolves to unknown");
  // A read that stopped at a line boundary inside the greyed body: only the counts can tell.
  ok(resolveFrame(text.slice(0, text.lastIndexOf("\n", text.length - 2) + 1), 1762800001000000).kind === "unknown",
    "a file cut short at a line boundary resolves to unknown");
  ok(resolveFrame(text.replace(/\ngrey \d+\n[\s\S]*$/, "\n"), 1762800001000000).kind === "unknown",
    "a file without its greyed copy resolves to unknown");
  ok(resolveFrame(text.replace("slots=1", "slots=2"), 1762800001000000).kind === "unknown",
    "a slot count that does not match the sections resolves to unknown");
  ok(resolveFrame(`${text}extra\n`, 1762800001000000).kind === "unknown", "trailing junk resolves to unknown");
  ok(same(resolveFrame(text.replace(" slots=1", " extra=yes slots=1"), 1762800001000000), { kind: "live", lines: TRICKY }),
    "an unknown header field is ignored");

  // --- The greyed copy ------------------------------------------------------------------------
  const colourful = [
    "\x1b[27m\x1b[38;2;222;202;128m\x1b[48;2;0;0;0m▀\x1b[39m\x1b[49m",
    "\x1b[1;38;2;224;84;64mHP\x1b[22m \x1b[38;5;196mred\x1b[0m \x1b[31mbasic\x1b[0m \x1b[102mbright bg\x1b[0m",
    "\x1b[38:2::120:184:232mcolon\x1b[0m \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
    "plain",
  ];
  const grey = greyLines(colourful);
  ok(grey.length === colourful.length, "the greyed copy keeps the line count");
  ok(grey.every(onlyGrey), "the greyed copy uses no colour other than the grey palette");
  ok(grey[grey.length - 1].endsWith(OFFLINE_MARKER) && OFFLINE_MARKER.includes("OFFLINE"),
    "the greyed copy ends with the OFFLINE marker");
  const visible = (s) => s.replace(/\x1b\[[0-9;:]*m/g, "");
  ok(same(grey.slice(0, -1).map(visible), colourful.slice(0, -1).map(visible)),
    "greying keeps every visible character");
  ok(grey[2].includes("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\"), "hyperlinks pass through untouched");
  ok(same(greyLines([]), [OFFLINE_MARKER]), "an empty body greys to the marker alone");

  // --- Atomic write ---------------------------------------------------------------------------
  const target = path.join(sandbox, "mugshot_frame_test.json");
  ok(writeFrame(target, one) === true, "a frame write reports success");
  ok(readFileSync(target, "utf8") === text, "the written file holds the serialised frame");
  ok(!readdirSync(sandbox).some((n) => n.endsWith(".tmp")), "a successful write leaves no temp file");

  // The target is a non-empty directory, so the rename fails on every platform.
  const blocked = path.join(sandbox, "blocked.json");
  mkdirSync(blocked);
  writeFileSync(path.join(blocked, "keep"), "x");
  let threw = false;
  let result;
  try { result = writeFrame(blocked, one); } catch { threw = true; }
  ok(!threw && result === false, "a rename that fails is reported as failure, not thrown");
  ok(!readdirSync(sandbox).some((n) => n.endsWith(".tmp")), "a failed rename leaves no temp file behind");
  ok(existsSync(path.join(blocked, "keep")), "a failed rename leaves the target alone");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} failure(s)` : "\nall frame checks passed");
process.exit(fails ? 1 : 0);
