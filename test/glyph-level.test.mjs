#!/usr/bin/env node
// Glyph step from the session's terminal, capped per image.
import { terminalStep, effectiveStep, WINDOWS_TERMINAL_STEP } from "../src/glyph-level.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const is = (env, want, what) => { const got = terminalStep(env); ok(got === want, `${what} → ${want} (got ${got})`); };

is({}, "half", "nothing identifies the terminal (the Windows console host)");
ok(effectiveStep({}, "octant") === "half", "an image allowed octants is drawn with half blocks in the console host");
is({ WT_SESSION: "x" }, WINDOWS_TERMINAL_STEP, "Windows Terminal");
is({ WT_SESSION: "x", DOOMBAR_GLYPHS: "sextant" }, "sextant", "DOOMBAR_GLYPHS overrides Windows Terminal");
ok(effectiveStep({ WT_SESSION: "x", DOOMBAR_GLYPHS: "sextant" }, "octant") === "sextant", "an override caps an image allowed octants");
is({ WT_SESSION: "x", TMUX: "/tmp/tmux-1/default,1,0" }, "half", "tmux inside Windows Terminal");
is({ TERM: "screen-256color" }, "half", "GNU screen");
is({ WT_SESSION: "x", TERM_PROGRAM: "vscode" }, "wedge", "VS Code started from a Windows Terminal tab");
is({ TERM_PROGRAM: "vscode" }, "wedge", "VS Code");
is({ TERM_PROGRAM: "WezTerm" }, "wedge", "WezTerm");
is({ TERM_PROGRAM: "ghostty" }, "octant", "Ghostty");
is({ TERM: "xterm-kitty" }, "octant", "kitty");
is({ VTE_VERSION: "7600" }, "wedge", "a VTE terminal");
is({ DOOMBAR_GLYPHS: "huge", WT_SESSION: "x" }, WINDOWS_TERMINAL_STEP, "an unknown DOOMBAR_GLYPHS value is ignored");
is({ DOOMBAR_GLYPHS: " Quadrant " }, "quadrant", "DOOMBAR_GLYPHS ignores case and spaces");
ok(effectiveStep({ TERM: "xterm-kitty" }, "quadrant") === "quadrant", "an image's own step below the terminal's is kept");
ok(effectiveStep({ TERM: "xterm-kitty" }, undefined) === "octant", "an image without a step gets the terminal's step");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
