// Shared low-level ANSI primitives, used by both the face loader and the render
// engine. Kept dependency-free and tiny.

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const TERM_RGB = [0, 0, 0]; // assumed terminal background (for blends/look)

// Truecolor foreground / background SGR from an [r,g,b] array.
export const sgrFg = (c) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
export const sgrBg = (c) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;

// Python's round() is round-half-to-even (banker's); JS Math.round is half-up.
// We must match Python exactly or bar/spark heights drift by one at .5 boundaries.
export function pyround(x) {
  const fl = Math.floor(x);
  const d = x - fl;
  if (d < 0.5) return fl;
  if (d > 0.5) return fl + 1;
  return fl % 2 === 0 ? fl : fl + 1; // exactly .5 -> nearest even
}
