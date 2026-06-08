#!/usr/bin/env python3
"""Live ANSI mock-up of the metric render styles in a DOOM status bar.

Demonstrates the rendering model from the ideation doc:
  - text / number / group / bar render styles, per-metric unicode icon labels
  - threshold colour on bars (green -> amber -> red)
  - fine bars: 8 sub-steps per cell via eighth-blocks
  - empty bar track = 50% blend of box background and terminal background
    (yellow boxes + red terminal -> orange empty track)
  - responsive layout: box/bar widths shrink with the terminal; each metric has
    a minimum width and the box takes the width of its widest metric
  - a real chafa mugshot in the centre (its own background)

Run in a real terminal to see true colours:

    python tools/mockup_metrics.py
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mockup_boxes import load_face, face_cell, bg, RESET, BOLD  # noqa: E402

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

# Palette
PANEL = (28, 32, 54)
TERM = (0, 0, 0)          # assumed terminal background (for blend)
MUG_BG = (0, 0, 0)
DIVIDER = (0, 0, 0)
TITLE = (222, 202, 128)
TEXT = (182, 186, 200)
GREEN = (96, 200, 104)
AMBER = (224, 184, 64)
RED = (224, 84, 64)

BAR_MAX = 14              # max bar cells — cap on wide screens so boxes don't stretch
BAR_MIN = 4               # min bar cells — floor on narrow screens
EIGHTHS = " ▏▎▍▌▋▊▉"      # 0..7 eighths; '█' is a full cell


def f(color):
    return f"\x1b[38;2;{color[0]};{color[1]};{color[2]}m"


def blend(a, b):
    return tuple((a[i] + b[i]) // 2 for i in range(3))


def vlen(s):
    """Visible width: strip ANSI; count emoji/symbols (>= U+1F000) as width 2."""
    return sum(2 if ord(ch) >= 0x1F000 else 1 for ch in ANSI_RE.sub("", s))


def threshold(pct):
    return GREEN if pct < 60 else AMBER if pct < 85 else RED


def track(pct, cells, box_bg):
    """Bar track: threshold fill + eighth-block partial; empty = box/term blend."""
    empty_col = blend(box_bg, TERM)
    eighths = round(pct / 100 * cells * 8)
    full = min(cells, eighths // 8)
    rem = eighths % 8 if full < cells else 0
    c = threshold(pct)
    s = bg(empty_col) + f(c) + "█" * full
    if rem:
        s += EIGHTHS[rem]                       # fg=fill on blend bg -> smooth edge
    empty = cells - full - (1 if rem else 0)
    s += " " * max(0, empty)                    # blend bg shows through
    return s + bg(box_bg) + f(c)                # reset bg for the trailing % text


# Box title + metrics. A metric is a bar (icon+pct) or a value (pre-coloured).
BOXES = [
    ("USAGE", [
        {"bar": True, "icon": "🧠", "pct": 78},     # context
        {"bar": True, "icon": "🕔", "pct": 64},     # 5-hour
        {"bar": True, "icon": "📅", "pct": 31},     # weekly
    ]),
    ("__FACE__", None),
    ("GIT", [
        {"val": "🌿 " + f(TEXT) + "main"},
        {"val": "⇅ " + f(AMBER) + "↓2" + f(TEXT) + " " + f(GREEN) + "↑3"},
        {"val": "✎ " + f(GREEN) + "+124 " + f(RED) + "-37"},
    ]),
    ("SYS", [
        {"bar": True, "icon": "💾", "pct": 47},     # RAM
        {"val": "🔥 " + f(GREEN) + "12%"},          # CPU
        {"val": "🕓 " + f(TEXT) + "14:23"},         # clock
    ]),
]


def metric_min_width(m, cells):
    if m.get("bar"):
        return vlen(m["icon"] + " ") + cells + vlen(f" {m['pct']}%")
    return vlen(m["val"])


def box_width(metrics, cells):
    return max(metric_min_width(m, cells) for m in metrics)


def render_metric(m, w, box_bg):
    if m.get("bar"):
        label = m["icon"] + " "
        pct = f" {m['pct']}%"
        cells = max(1, w - vlen(label) - vlen(pct))
        return label + track(m["pct"], cells, box_bg) + pct
    content = m["val"]
    return content + " " * max(0, w - vlen(content))


def cell(content, box_bg):
    return bg(box_bg) + " " + content + " " + RESET


def header_cell(title, w, box_bg):
    pad = w - vlen(title)
    left = pad // 2
    return bg(box_bg) + BOLD + f(TITLE) + " " + " " * left + title + " " * (pad - left) + " " + RESET


def choose_cells(face_w, target):
    """Largest bar width that fits the target terminal width (down to BAR_MIN)."""
    cols = len(BOXES)            # boxes + face column
    for cells in range(BAR_MAX, BAR_MIN - 1, -1):
        total = 2 + (cols - 1)   # leading indent + separators
        for title, metrics in BOXES:
            total += (face_w + 2) if title == "__FACE__" else (box_width(metrics, cells) + 2)
        if total <= target:
            return cells
    return BAR_MIN


def render_bar(target):
    total_rows = 1 + 3                       # header + 3 metric rows
    face = load_face(total_rows)
    face_w = max(len(r) for r in face)
    cells = choose_cells(face_w, target)

    columns = []
    for title, metrics in BOXES:
        if title == "__FACE__":
            columns.append([face_cell(face[r], face_w, MUG_BG) for r in range(total_rows)])
            continue
        w = box_width(metrics, cells)
        col = [header_cell(title, w, PANEL)]
        col += [cell(render_metric(m, w, PANEL), PANEL) for m in metrics]
        columns.append(col)

    sep = bg(PANEL) + f(DIVIDER) + "│"
    rows = []
    for r in range(total_rows):
        line = "".join((sep if i else "") + c[r] for i, c in enumerate(columns))
        rows.append("  " + line + RESET)
    return rows, cells


def main():
    buf = []
    for label, target in [("ULTRA-WIDE terminal (capped at max)", 200),
                          ("WIDE terminal", 110),
                          ("NARROW terminal", 60)]:
        rows, cells = render_bar(target)
        buf += ["", f"  {label}  (~{target} cols, bar={cells} cells)", ""]
        buf += rows
        buf += [""]
    buf += ["  bar width clamped to [min 4, max 14] cells · empty track = 50% blend(box, terminal) · responsive", ""]
    sys.stdout.buffer.write(("\n".join(buf) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
