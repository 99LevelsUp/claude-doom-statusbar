#!/usr/bin/env python3
"""ANSI mock-ups of the status-bar box styles, for picking a visual direction.

Unified model (what the installer will ask):

    box.background  in { term-bg, <rgb> }            # fill behind a box
    border.color    in { term-bg, term-fg, <rgb> }   # separators / frame lines
    border.style    in { frame, vertical, none }      # A = frame, B/C = vertical
    headers         in { shown, hidden }              # title row per box

Variants A / B / C are then just presets of that model.

The mugshot is the real chafa face, loaded from
``doomguy_faces_ansi/<rows>/STFST01.ans`` at the height the bar needs. When
headers are shown (vertical/none styles) the mugshot has no title of its own,
so it grows by one row (size 4 -> size 5) to span the full bar height.

Run directly in a real terminal to see true colours:

    python tools/mockup_boxes.py
"""

import os
import sys

RESET = "\x1b[0m"
BOLD = "\x1b[1m"

TERM_BG = "term-bg"
TERM_FG = "term-fg"

TEXT = (170, 170, 170)
TITLE = (220, 200, 120)

ANSI_BASE = r"D:\Smeti\Dev\claude-doom-statusbar\doomguy_faces_ansi"

# Data boxes carry 4 lines so the bar is 4 rows tall (matching the size-4 face);
# with headers it becomes 5 rows (header + 4), matching the size-5 face.
DATA_BOXES = [
    ("CONTEXT", ["HP █████▓░ 78%", "31k / 200k tok", "window OPEN", "pace: fast"]),
    ("USAGE",   ["5h  ▮▮▮▮▯ 64%", "day ▮▮▯▯▯ 31%", "$1.83 today", "wpn: BFG"]),
    ("__FACE__", None),
    ("GIT",     ["br: main", "+124 / -37", "* 3 changed", "^ 2 ahead"]),
    ("AGENTS",  ["> 2 running", "explore,plan", "geiger ▒▒░", "depth 3"]),
]


def fg(color):
    if color == TERM_FG:
        return "\x1b[39m"
    if color == TERM_BG:
        return "\x1b[38;2;0;0;0m"
    return f"\x1b[38;2;{color[0]};{color[1]};{color[2]}m"


def bg(color):
    if color == TERM_BG:
        return "\x1b[49m"
    return f"\x1b[48;2;{color[0]};{color[1]};{color[2]}m"


def vlen(s):
    return len(s)


def pad(s, w):
    return s + " " * (w - vlen(s))


# --- real chafa face loading ------------------------------------------------

_face_cache = {}


def _apply_sgr(params, fgc, bgc, rev, dfg, dbg):
    i = 0
    while i < len(params):
        tok = params[i]
        try:
            p = int(tok) if tok else 0
        except ValueError:
            i += 1
            continue
        if p == 0:
            fgc, bgc, rev = dfg, dbg, False
        elif p == 7:
            rev = True
        elif p == 27:
            rev = False
        elif p in (38, 48) and i + 4 < len(params) and params[i + 1] == "2":
            col = (int(params[i + 2]), int(params[i + 3]), int(params[i + 4]))
            if p == 38:
                fgc = col
            else:
                bgc = col
            i += 4
        i += 1
    return fgc, bgc, rev


def load_face(rows):
    """Parse doomguy_faces_ansi/<rows>/STFST01.ans into rows of (char, fg, bg)."""
    if rows in _face_cache:
        return _face_cache[rows]
    path = os.path.join(ANSI_BASE, str(rows), "STFST01.ans")
    text = open(path, encoding="utf-8").read()
    ESC = "\x1b"
    dfg, dbg = (170, 170, 170), (0, 0, 0)
    fgc, bgc, rev = dfg, dbg, False
    out, row = [], []
    i = 0
    while i < len(text):
        c = text[i]
        if c == "\r":
            i += 1
        elif c == "\n":
            out.append(row)
            row = []
            i += 1
        elif c == ESC and i + 1 < len(text) and text[i + 1] == "[":
            j = i + 2
            while j < len(text) and text[j] not in "ABCDEFGHJKSTfhilmnpqrsu":
                j += 1
            if j < len(text) and text[j] == "m":
                fgc, bgc, rev = _apply_sgr(text[i + 2:j].split(";"), fgc, bgc, rev, dfg, dbg)
            i = j + 1
        else:
            efg, ebg = (bgc, fgc) if rev else (fgc, bgc)
            row.append((c, efg, ebg))
            i += 1
    if row:
        out.append(row)
    _face_cache[rows] = out
    return out


def face_cell(cells, w, box_background):
    """Render one face row as a box cell of inner width w (centered).

    On a coloured box background the sprite's own pure-black surround is mapped
    to the box background, so the face integrates into the panel instead of
    sitting in a black bounding box. On a terminal background it is left as is
    (black already blends into the terminal).
    """
    blend = box_background != TERM_BG
    vis = len(cells)
    total = max(0, w - vis)
    left = total // 2
    right = total - left
    s = bg(box_background) + " " + " " * left
    for ch, efg, ebg in cells:
        if blend and ebg == (0, 0, 0):
            ebg = box_background
        s += f"\x1b[38;2;{efg[0]};{efg[1]};{efg[2]}m\x1b[48;2;{ebg[0]};{ebg[1]};{ebg[2]}m" + ch
    s += RESET + bg(box_background) + " " * right + " " + RESET
    return s


# --- bar rendering ----------------------------------------------------------


def render(box_background, border_color, style, show_headers):
    data_rows = max(len(l) for _, l in DATA_BOXES if l)
    headered = show_headers and style != "frame"
    # The mugshot is never framed or headed; it spans the full bar height, so it
    # gains the rows the other boxes spend on chrome: +2 for frame top/bottom,
    # +1 for a header row.
    extra = 2 if style == "frame" else (1 if headered else 0)
    total_rows = data_rows + extra
    face = load_face(total_rows)
    face_w = max(len(r) for r in face)

    def frame_top(title, w):
        if show_headers and title:
            label = f" {title} "
            bar = ("─" + label + "─" * (w + 1 - len(label)))[:w + 2]
        else:
            bar = "─" * (w + 2)
        return bg(box_background) + fg(border_color) + "┌" + bar + "┐" + RESET

    def frame_bottom(w):
        return bg(box_background) + fg(border_color) + "└" + "─" * (w + 2) + "┘" + RESET

    columns = []
    for title, lines in DATA_BOXES:
        is_face = title.startswith("__")
        if is_face:
            # Bare, full-height mugshot: no frame, no header, ever.
            col = [face_cell(face[r], face_w, box_background) for r in range(total_rows)]
        else:
            w = max([len(title) + 2] + [vlen(x) for x in lines])
            col = []
            if style == "frame":
                col.append(frame_top(title, w))
            elif headered:
                col.append(bg(box_background) + BOLD + fg(TITLE) + " " + pad(title, w) + " " + RESET)
            for r in range(data_rows):
                cell = lines[r] if r < len(lines) else ""
                body = bg(box_background) + fg(TEXT) + " " + pad(cell, w) + " " + RESET
                if style == "frame":
                    wall = bg(box_background) + fg(border_color) + "│"
                    body = wall + bg(box_background) + fg(TEXT) + " " + pad(cell, w) + " " + wall + RESET
                col.append(body)
            if style == "frame":
                col.append(frame_bottom(w))
        columns.append(col)

    def sep():
        if style == "none":
            return (RESET + " ") if box_background == TERM_BG else (bg(box_background) + " ")
        if border_color == TERM_BG:
            return RESET + " "  # separator coloured as terminal bg = a true gap/cut
        return bg(box_background) + fg(border_color) + "│"

    out = []
    for r in range(total_rows):
        line = ""
        for i, col in enumerate(columns):
            if style != "frame" and i:
                line += sep()
            line += col[r]
        out.append(line + RESET)
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
    ("N  none   (background=dark slate, no borders -> one panel)",
     dict(box_background=(28, 32, 54), border_color=TERM_BG, style="none")),
    ("N' none   (background=term, no borders, gap-separated)",
     dict(box_background=TERM_BG, border_color=TERM_BG, style="none")),
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
    buf.append("=== headers ON (mugshot grows to size 5 in vertical/none styles) ===")
    for label, cfg in PRESETS:
        emit(buf, label, cfg, show_headers=True)
    buf.append("=== headers OFF (compact; mugshot back to size 4) ===")
    for label, cfg in (PRESETS[1], PRESETS[2], PRESETS[4]):  # B, C, N
        emit(buf, label, cfg, show_headers=False)
    sys.stdout.buffer.write(("\n".join(buf) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
