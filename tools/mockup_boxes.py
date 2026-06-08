#!/usr/bin/env python3
"""ANSI mock-ups of the status-bar box styles, for picking a visual direction.

Unified model (what the installer will ask):

    box.background  in { term-bg, term-fg, <rgb> }   # fill behind a box
    border.color    in { term-bg, term-fg, <rgb> }   # separators / frame lines
    border.style    in { frame, vertical }            # A = frame, B/C = vertical

Variants A / B / C are then just presets of that model:

    A  frame     : background=term-bg, border=gray  , style=frame
    B  lines     : background=term-bg, border=gray  , style=vertical
    C  panel     : background=dark    , border=term-bg, style=vertical

Run directly in a real terminal to see true colours:

    python tools/mockup_boxes.py
"""

import sys

RESET = "\x1b[0m"
BOLD = "\x1b[1m"

# Tokens for "use the terminal's own colour".
TERM_BG = "term-bg"
TERM_FG = "term-fg"


def fg(color):
    if color == TERM_FG:
        return "\x1b[39m"
    if color == TERM_BG:
        # No portable "default-bg as foreground"; approximate with black.
        return "\x1b[38;2;0;0;0m"
    return f"\x1b[38;2;{color[0]};{color[1]};{color[2]}m"


def bg(color):
    if color == TERM_BG:
        return "\x1b[49m"
    if color == TERM_FG:
        return "\x1b[7m\x1b[27m"  # rarely used; keep simple
    return f"\x1b[48;2;{color[0]};{color[1]};{color[2]}m"


# Demo content. All glyphs are width-1 so columns line up.
TEXT = (170, 170, 170)
TITLE = (220, 200, 120)
BOXES = [
    ("CONTEXT", ["HP █████▓░ 78%", "31k / 200k tok", "window OPEN"]),
    ("USAGE",   ["5h  ▮▮▮▮▯ 64%", "day ▮▮▯▯▯ 31%", "$1.83  BFG"]),
    ("",        ["  ▟█████▙  ", "  ██▀▄▀██  ", "  ▜█████▛  "]),
    ("GIT",     ["br: main", "+124 / -37", "* 3 changed"]),
    ("AGENTS",  ["> 2 running", "explore,plan", "geiger ▒▒░"]),
]


def box_width(title, lines):
    return max([len(title) + 2] + [len(ln) for ln in lines])


def pad(s, w):
    return s + " " * (w - len(s))


def render(box_background, border_color, style):
    widths = [box_width(t, l) for t, l in BOXES]
    sep_is_hole = (border_color == TERM_BG)  # render separator as a true term-bg gap

    def sep():
        if sep_is_hole:
            return RESET + " "  # 1-wide gap in the real terminal background
        return bg(box_background) + fg(border_color) + "│"

    out = []
    nrows = max(len(l) for _, l in BOXES)

    if style == "frame":
        # Top border with embedded titles.
        top = ""
        for i, (t, _) in enumerate(BOXES):
            w = widths[i]
            label = f" {t} " if t else "─" * (w)
            bar = ("─" + label + "─" * (w - len(label) + 1))[:w + 2]
            top += bg(box_background) + fg(border_color) + "┌" + bar + "┐"
        out.append(top + RESET)

    # Title row (only when NOT in frame mode; frame puts titles in the border).
    if style != "frame":
        line = ""
        for i, (t, _) in enumerate(BOXES):
            if i:
                line += sep()
            line += bg(box_background) + BOLD + fg(TITLE) + " " + pad(t, widths[i]) + " " + RESET
        out.append(line + RESET)

    # Data rows.
    for r in range(nrows):
        line = ""
        for i, (_, lines) in enumerate(BOXES):
            if i:
                line += sep()
            cell = lines[r] if r < len(lines) else ""
            wall = (bg(box_background) + fg(border_color) + "│") if style == "frame" else bg(box_background)
            endwall = (bg(box_background) + fg(border_color) + "│") if style == "frame" else ""
            line += wall + bg(box_background) + fg(TEXT) + " " + pad(cell, widths[i]) + " " + endwall + RESET
        out.append(line + RESET)

    if style == "frame":
        bottom = ""
        for i in range(len(BOXES)):
            w = widths[i]
            bottom += bg(box_background) + fg(border_color) + "└" + "─" * (w + 2) + "┘"
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


def main():
    buf = []
    for label, cfg in PRESETS:
        buf.append("")
        buf.append(f"  {label}")
        buf.append("")
        for row in render(**cfg):
            buf.append("  " + row)
        buf.append("")
    sys.stdout.buffer.write(("\n".join(buf) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
