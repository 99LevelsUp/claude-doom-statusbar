#!/usr/bin/env python3
"""ANSI mock-ups of the status-bar box styles, for picking a visual direction.

Unified model (what the installer will ask):

    box.background  in { term-bg, <rgb> }            # fill behind a box
    border.color    in { term-bg, term-fg, <rgb> }   # separators / frame lines
    border.style    in { frame, vertical }            # A = frame, B/C = vertical
    headers         in { shown, hidden }              # title row per box

Variants A / B / C are then just presets of that model:

    A  frame     : background=term-bg, border=gray  , style=frame
    B  lines     : background=term-bg, border=gray  , style=vertical
    C  panel     : background=dark    , border=term-bg, style=vertical

Headers: when shown as their own row (vertical style), the mugshot box has no
title of its own, so it gains one extra face row to span the full bar height.

Run directly in a real terminal to see true colours:

    python tools/mockup_boxes.py
"""

import sys

RESET = "\x1b[0m"
BOLD = "\x1b[1m"

# Tokens for "use the terminal's own colour".
TERM_BG = "term-bg"
TERM_FG = "term-fg"

TEXT = (170, 170, 170)
TITLE = (220, 200, 120)

# Data boxes: (title, data lines). The mugshot box is generated separately so
# its height can follow the bar (and grow by one row when headers are shown).
DATA_BOXES = [
    ("CONTEXT", ["HP █████▓░ 78%", "31k / 200k tok", "window OPEN"]),
    ("USAGE",   ["5h  ▮▮▮▮▯ 64%", "day ▮▮▯▯▯ 31%", "$1.83  BFG"]),
    ("__FACE__", None),  # placeholder, filled per render
    ("GIT",     ["br: main", "+124 / -37", "* 3 changed"]),
    ("AGENTS",  ["> 2 running", "explore,plan", "geiger ▒▒░"]),
]

# Mugshot placeholder at two heights: with and without the extra header row.
FACE = {
    3: ["  ▟█████▙  ", "  ██▀▄▀██  ", "  ▜█████▛  "],
    4: ["  ▟█████▙  ", "  ███████  ", "  ██▀▄▀██  ", "  ▜█████▛  "],
}


def fg(color):
    if color == TERM_FG:
        return "\x1b[39m"
    if color == TERM_BG:
        return "\x1b[38;2;0;0;0m"  # no portable default-bg-as-fg; approximate black
    return f"\x1b[38;2;{color[0]};{color[1]};{color[2]}m"


def bg(color):
    if color == TERM_BG:
        return "\x1b[49m"
    return f"\x1b[48;2;{color[0]};{color[1]};{color[2]}m"


def vlen(s):
    return len(s)  # all demo glyphs are width-1


def pad(s, w):
    return s + " " * (w - vlen(s))


def box_width(title, lines):
    titlen = (len(title) + 2) if not title.startswith("__") else 0
    return max([titlen] + [vlen(ln) for ln in lines])


def render(box_background, border_color, style, show_headers):
    data_rows = max(len(l) for _, l in DATA_BOXES if l)
    face_rows = data_rows + (1 if (show_headers and style == "vertical") else 0)
    face = FACE[face_rows]

    # Build each box's full column of (already styled) cell strings.
    widths = []
    columns = []
    titles = []
    for title, lines in DATA_BOXES:
        is_face = title.startswith("__")
        body = face if is_face else lines
        w = max([0 if is_face else len(title) + 2] + [vlen(x) for x in body])
        widths.append(w)
        titles.append("" if is_face else title)

        col = []
        if show_headers and style == "vertical":
            if is_face:
                # Face fills the header band too (its first row).
                col.append(bg(box_background) + fg(TEXT) + " " + pad(face[0], w) + " " + RESET)
            else:
                col.append(bg(box_background) + BOLD + fg(TITLE) + " " + pad(title, w) + " " + RESET)
        start = 1 if (show_headers and style == "vertical" and is_face) else 0
        for r in range(len(body) - start) if is_face else range(data_rows):
            cell = (face[start + r] if is_face else (lines[r] if r < len(lines) else ""))
            col.append(bg(box_background) + fg(TEXT) + " " + pad(cell, w) + " " + RESET)
        columns.append(col)

    nrows = max(len(c) for c in columns)
    sep_is_hole = (border_color == TERM_BG and style == "vertical")

    def sep():
        if sep_is_hole:
            return RESET + " "
        return bg(box_background) + fg(border_color) + "│"

    out = []

    if style == "frame":
        top = ""
        for i, t in enumerate(titles):
            w = widths[i]
            if show_headers and t:
                label = f" {t} "
                bar = ("─" + label + "─" * (w + 1 - len(label)))[:w + 2]
            else:
                bar = "─" * (w + 2)
            top += bg(box_background) + fg(border_color) + "┌" + bar + "┐"
        out.append(top + RESET)

    for r in range(nrows):
        line = ""
        for i, col in enumerate(columns):
            cell = col[r] if r < len(col) else (bg(box_background) + " " * (widths[i] + 2) + RESET)
            if style == "frame":
                wall = bg(box_background) + fg(border_color) + "│"
                line += wall + cell + wall
            else:
                if i:
                    line += sep()
                line += cell
        out.append(line + RESET)

    if style == "frame":
        bottom = ""
        for i in range(len(columns)):
            bottom += bg(box_background) + fg(border_color) + "└" + "─" * (widths[i] + 2) + "┘"
        out.append(bottom + RESET)

    return out


PRESETS = [
    ("A  frame  (background=term, border=gray)",
     dict(box_background=TERM_BG, border_color=(110, 110, 110), style="frame")),
    ("B  lines  (background=term, border=gray, vertical only)",
     dict(box_background=TERM_BG, border_color=(110, 110, 110), style="vertical")),
    ("C  panel  (background=dark slate, border=term-bg cut)",
     dict(box_background=(28, 32, 54), border_color=TERM_BG, style="vertical")),
    ("C' panel  (background=dark slate, border=black line)",
     dict(box_background=(28, 32, 54), border_color=(0, 0, 0), style="vertical")),
]


def emit(buf, label, cfg, show_headers):
    buf.append("")
    buf.append(f"  {label}   headers={'on' if show_headers else 'off'}")
    buf.append("")
    for row in render(show_headers=show_headers, **cfg):
        buf.append("  " + row)
    buf.append("")


def main():
    buf = []
    buf.append("=== headers ON (mugshot gains a row in vertical styles) ===")
    for label, cfg in PRESETS:
        emit(buf, label, cfg, show_headers=True)
    buf.append("=== headers OFF (compact; mugshot back to base height) ===")
    for label, cfg in (PRESETS[1], PRESETS[2]):  # B and C for comparison
        emit(buf, label, cfg, show_headers=False)
    sys.stdout.buffer.write(("\n".join(buf) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
