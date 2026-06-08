#!/usr/bin/env python3
"""Live ANSI mock-up of the metric render styles in a DOOM status bar.

Shows the rendering model from the ideation doc on a dark panel with a real
chafa mugshot in the centre:
  - text       : plain string (git branch, clock)
  - number     : value + optional unit ($1.83, 31k/200k, 12%)
  - bar        : progress bar with threshold colour (green -> amber -> red)
  - ammo       : segmented gauge (5h / weekly clips)
  - spark      : sparkline from a rolling history (context growth, activity)
  - group      : several metrics side by side (git +124 -37, ahead/behind)
  - icon headers (unicode) instead of text labels

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
MUG_BG = (0, 0, 0)
DIVIDER = (0, 0, 0)
TITLE = (222, 202, 128)
TEXT = (182, 186, 200)
DIM = (92, 98, 126)
GREEN = (96, 200, 104)
AMBER = (224, 184, 64)
RED = (224, 84, 64)
SPARK = (120, 184, 232)


def f(color):
    return f"\x1b[38;2;{color[0]};{color[1]};{color[2]}m"


def vlen(s):
    """Visible width: strip ANSI; count emoji/symbols (>= U+1F000) as width 2."""
    n = 0
    for ch in ANSI_RE.sub("", s):
        n += 2 if ord(ch) >= 0x1F000 else 1
    return n


def threshold(pct):
    return GREEN if pct < 60 else AMBER if pct < 85 else RED


# --- render styles ----------------------------------------------------------

def r_text(s, color=TEXT):
    return f(color) + s


def r_number(s, color=TEXT):
    return f(color) + s


def r_bar(pct, cells=8):
    """Fine progress bar: 8 sub-steps per cell via left eighth-blocks."""
    eighths = round(pct / 100 * cells * 8)
    full = eighths // 8
    rem = eighths % 8
    parts = " ▏▎▍▌▋▊▉"  # 0..7 eighths; '█' is the full cell
    c = threshold(pct)
    s = f(c) + "█" * full
    if rem:
        s += f(c) + parts[rem]
    empty = cells - full - (1 if rem else 0)
    s += f(DIM) + "░" * empty
    return s + f(c) + f" {pct}%"


def r_ammo(pct, segs=5, color=AMBER):
    filled = round(pct / 100 * segs)
    return f(color) + "▮" * filled + f(DIM) + "▯" * (segs - filled) + f(color) + f" {pct}%"


def r_spark(values, color=SPARK):
    chars = "▁▂▃▄▅▆▇█"
    lo, hi = min(values), max(values)
    out = []
    for v in values:
        idx = 0 if hi == lo else round((v - lo) / (hi - lo) * (len(chars) - 1))
        out.append(chars[idx])
    return f(color) + "".join(out)


def r_group(*parts):
    return (f(TEXT) + " ").join(parts)


# --- boxes ------------------------------------------------------------------

# Box titles are TEXT; each metric line is prefixed by its own unicode icon.
BOXES = [
    ("USAGE", [
        "🧠 " + r_bar(78),                       # context
        "🕔 " + r_bar(64),                       # 5-hour usage
        "📅 " + r_bar(31),                       # weekly usage
    ]),
    ("__FACE__", None),
    ("GIT", [
        "🌿 " + r_text("main"),
        "⇅ " + r_group(f(AMBER) + "↓2", f(GREEN) + "↑3"),
        "✎ " + f(GREEN) + "+124 " + f(RED) + "-37",
    ]),
    ("SYS", [
        "💾 " + r_bar(47),                       # RAM
        "🔥 " + r_number("12%", GREEN),          # CPU
        "🕓 " + r_number("14:23"),               # clock
    ]),
]


def cell(content, w, box_bg):
    pad = w - vlen(content)
    return bg(box_bg) + " " + content + (" " * max(0, pad)) + " " + RESET


def header_cell(h, w, box_bg):
    pad = w - vlen(h)
    left = pad // 2
    right = pad - left
    return bg(box_bg) + BOLD + f(TITLE) + " " + (" " * left) + h + (" " * right) + " " + RESET


def main():
    total_rows = 1 + 3  # header + 3 metric lines
    face = load_face(total_rows)
    face_w = max(len(r) for r in face)

    columns = []
    for header, lines in BOXES:
        if header == "__FACE__":
            col = [face_cell(face[r], face_w, MUG_BG) for r in range(total_rows)]
            columns.append(col)
            continue
        w = max([vlen(header)] + [vlen(ln) for ln in lines])
        col = [header_cell(header, w, PANEL)]
        for ln in lines:
            col.append(cell(ln, w, PANEL))
        columns.append(col)

    sep = bg(PANEL) + f(DIVIDER) + "│"
    out = []
    for r in range(total_rows):
        line = ""
        for i, c in enumerate(columns):
            if i:
                line += sep
            line += c[r]
        out.append("  " + line + RESET)

    buf = ["", "  Metric render — text box titles, per-metric icon labels, fine bars (eighths)", ""]
    buf += out
    buf += ["", "  USAGE: 🧠 context · 🕔 5h · 📅 weekly (threshold-coloured fine bars)   GIT: text + group   SYS: bar/number", ""]
    sys.stdout.buffer.write(("\n".join(buf) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
