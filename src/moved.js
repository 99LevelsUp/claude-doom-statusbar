// 0.16.0 is the last release of claude-doom-statusbar: the bar has moved to claude-game-bar.
// The bar shows this as its last row (statusline.js), and install and uninstall print it.
export const MOVED_TEXT = "claude-doom-statusbar has moved: npm i -g claude-game-bar && claude-game-bar install";

// Shorter forms for narrow terminals, longest first. The bar row uses the longest that fits.
const VARIANTS = [
  MOVED_TEXT,
  "moved: npm i -g claude-game-bar && claude-game-bar install",
  "moved to claude-game-bar",
];

export function movedText(cols) {
  return VARIANTS.find((v) => v.length <= cols) || VARIANTS.at(-1);
}
