// The scroll-list visual: a list one item a row, as many rows as it is given. A longer list shows a
// window of it, with ↑n and ↓n for the items above and below. Items are [left, right] pairs (a
// running subagent and its time), { status, text } tasks marked by status, or plain values.

import { sgrFg } from "../ansi.js";
import { vlen, marquee, scrollWindow } from "../text.js";
import { rgbOf } from "../meters.js";
import { define, param } from "./schema.js";
import { iconParam, labelOf, labelWidth, block, blank, TEXT_HEX } from "./paint.js";

const isTask = (item) => item !== null && typeof item === "object" && !Array.isArray(item);

export const scrollList = define({
  name: "scroll-list",
  title: "Scrolling list",
  description: "A list one item a row; a list longer than its rows shows a window with the count above and below",
  accepts: ["list"],
  params: {
    icon: iconParam(),
    anchor: param("text", "top", "Which part of a long list shows: the top, or the boundary between settled and open tasks", { allowed: ["top", "boundary"] }),
    marks: param("map", { completed: "✅", deleted: "❌", in_progress: "⏩", pending: "🎯" }, "The mark drawn before a task of each status"),
    mark_colors: param("map", { completed: "#60c868", deleted: "#e05440" }, "Colour (#rrggbb) of the mark of a task of each status; the text colour when unset"),
    settled: param("list", ["completed", "deleted"], "Task statuses that count as settled, for the boundary anchor"),
    color: param("color", TEXT_HEX, "Colour of the items"),
    marker_color: param("color", "#deca80", "Colour of the ↑n and ↓n markers"),
    overflow: param("text", "scroll", "How an item longer than its row fits: scroll back and forth, or clip it with an ellipsis", { allowed: ["scroll", "clip"] }),
    width: param("integer", 22, "Columns of the list when there is room", { min: 1 }),
    min_width: param("integer", 10, "Columns the list keeps when the bar is narrow", { min: 1 }),
    rows: param("integer", 4, "Rows the list asks for; it fills the rows it is given", { min: 1 }),
  },
  widths: (p) => ({ min: labelWidth(p) + Math.min(p.min_width, p.width), natural: labelWidth(p) + p.width }),
  rows: (p) => p.rows,
  draw({ value, params: p, width, height = p.rows, ctx = {} }) {
    const tick = ctx.tick ?? 0;
    const lbl = labelOf(p);
    const text = sgrFg(rgbOf(p.color));
    const markerFg = sgrFg(rgbOf(p.marker_color));
    const items = Array.isArray(value) ? value : [];
    const boundary = items.filter((it) => isTask(it) && p.settled.includes(it.status)).length;
    const win = scrollWindow(items.length, height, p.anchor, boundary);
    const shown = items.slice(win.start, win.start + height);
    const lines = shown.map((item, k) => {
      const first = k === 0, last = k === shown.length - 1;
      const marker = first && win.up > 0 ? `↑${win.up}` : last && win.down > 0 ? `↓${win.down}` : "";
      const tail = marker ? " " + marker : "";
      const tailW = vlen(tail);
      if (Array.isArray(item)) {
        const right = String(item[1]);
        const rightW = vlen(right) + tailW;
        const left = lbl + text + marquee(String(item[0]), Math.max(0, width - vlen(lbl) - rightW - 1), tick, p.overflow);
        return left + blank(width - vlen(left) - rightW) + text + right + (tail ? markerFg + tail : "");
      }
      let s;
      if (isTask(item)) {
        const mark = Object.hasOwn(p.marks, item.status) ? p.marks[item.status] : "•";
        const markRgb = Object.hasOwn(p.mark_colors, item.status) ? rgbOf(p.mark_colors[item.status]) : null;
        const m = mark + (vlen(mark) < 2 ? " " : ""); // marks take 2 columns so the texts line up
        const max = Math.max(0, width - vlen(m) - 1 - tailW);
        s = (markRgb ? sgrFg(markRgb) : text) + m + " " + text + marquee(String(item.text ?? ""), max, tick, p.overflow);
      } else {
        s = lbl + text + marquee(String(item), Math.max(0, width - vlen(lbl) - tailW), tick, p.overflow);
      }
      return s + blank(width - tailW - vlen(s)) + (tail ? markerFg + tail : "");
    });
    return block(lines, width, height);
  },
});
