// Which glyph step a session's images may use. A status line cannot ask the terminal what it
// draws, so the step comes from the terminal's identity in the session's environment, checked in
// this order:
//
//   DOOMBAR_GLYPHS            an explicit step name always wins
//   TMUX, TERM=screen*/tmux*  a multiplexer hides the real terminal: half blocks
//   TERM_PROGRAM, TERM        terminals known to draw the legacy-computing glyphs themselves
//   VTE_VERSION               VTE terminals (GNOME Terminal and others): up to wedges
//   WT_SESSION                Windows Terminal: the step its test card passed on the owner's PC
//   anything else             half blocks, which every font draws (the Windows console host too)
//
// The terminal-specific variables come before WT_SESSION because every process started from a
// Windows Terminal tab inherits it, VS Code included, while Windows Terminal itself sets no
// TERM_PROGRAM. VTE gets wedges, not octants: the VTE release that started drawing octants
// itself could not be confirmed, and DOOMBAR_GLYPHS=octant turns them on.

import { STEPS, stepIndex } from "./glyphs.js";

// Windows Terminal draws every step of the test card correctly.
export const WINDOWS_TERMINAL_STEP = "octant";

const PROGRAMS = { vscode: "wedge", wezterm: "wedge", ghostty: "octant" };
const TERMS = { "xterm-kitty": "octant", "xterm-ghostty": "octant" };

export function terminalStep(env = {}) {
  const override = String(env.DOOMBAR_GLYPHS || "").trim().toLowerCase();
  if (STEPS.includes(override)) return override;
  const term = String(env.TERM || "").toLowerCase();
  if (env.TMUX || term.startsWith("screen") || term.startsWith("tmux")) return "half";
  const program = PROGRAMS[String(env.TERM_PROGRAM || "").toLowerCase()];
  if (program) return program;
  if (TERMS[term]) return TERMS[term];
  if (env.VTE_VERSION) return "wedge";
  if (env.WT_SESSION) return WINDOWS_TERMINAL_STEP;
  return "half";
}

// The step an image is drawn with: its own step, never above what the terminal draws. An image
// that names no step (or an unknown one) may use everything the terminal allows.
export function effectiveStep(env, imageStep) {
  const terminal = terminalStep(env);
  const own = stepIndex(imageStep);
  return own >= 0 && own < stepIndex(terminal) ? imageStep : terminal;
}
