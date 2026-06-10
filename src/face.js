// STUB — replaced in the next step (task #3) by the real chafa/ANSI face loader.
// Exists so render.js imports resolve and the pure render functions can be tested.
// loadFace returns a blank face of the requested height; faceCell a blank cell.

export function loadFace(spriteName, rows) {
  return Array.from({ length: rows }, () => []);
}

export function faceCell(rowCells, w) {
  return " ".repeat(w + 2);
}
