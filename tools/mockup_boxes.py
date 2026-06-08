#!/usr/bin/env python3
"""ANSI mock-ups of the status-bar box styles, for picking a visual direction.

Unified model (what the installer will ask):

    box.background      in { term-bg, <rgb> }        # fill behind a data box
    mugshot.background  in { term-bg, <rgb> }        # fill behind the face (independent)
    border.color        in { term-bg, term-fg, <rgb> }  # separators / frame lines
    border.style        in { frame, vertical, none }    # A = frame, B/C = vertical
    headers             in { shown, hidden }            # title row per box

Variants A / B / C are then just presets of that model.

The mugshot is the real chafa face. It is baked at run time from the *magenta-
keyed sprite made transparent first*, so chafa encodes the transparent surround
as an unset (default) cell colour rather than black. The bar then composites the
face by mapping only that unset colour to the box background -- explicit colours,
including any genuine black inside the face, are left untouched. This is the
"fix the data, not the algorithm" approach: transparency stays distinguishable
from real black, so faces of any state (even ones with black interior pixels)
composite correctly onto a coloured panel.

The face is baked at exactly the height the bar needs. With headers (vertical/
none) the headerless mugshot grows one row; in frame style it grows two.

Run directly in a real terminal to see true colours:

    python tools/mockup_boxes.py
"""

import os
import subprocess
import sys
import tempfile

RESET = "\x1b[0m"
BOLD = "\x1b[1m"

TERM_BG = "term-bg"
TERM_FG = "term-fg"

TEXT = (170, 170, 170)
TITLE = (220, 200, 120)

SPRITE = r"D:\Smeti\Dev\claude-doom-statusbar\doomguy_faces_orig\STFST01.png"
SYMS = "block+half+quad+sextant+wedge+legacy"
MAGENTA_TOL = 40

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
_alpha_sprite = None


def alpha_sprite():
    """Return a path to the sprite with its magenta key colour made transparent.

    Feeding chafa a transparent sprite makes it encode the surround as an unset
    (default) colour, never black -- which is what keeps transparency
    distinguishable from genuine black inside the face.
    """
    global _alpha_sprite
    if _alpha_sprite:
        return _alpha_sprite
    from PIL import Image
    im = Image.open(SPRITE).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if abs(r - 255) <= MAGENTA_TOL and g <= MAGENTA_TOL and abs(b - 255) <= MAGENTA_TOL:
                px[x, y] = (r, g, b, 0)
    path = os.path.join(tempfile.gettempdir(), "doomguy_STFST01_alpha.png")
    im.save(path)
    _alpha_sprite = path
    return path


def load_face(rows):
    """Bake the face at the given character height via chafa on the transparent
    sprite. Returns rows of (char, fg, bg) where fg/bg are an (r,g,b) tuple or
    None when chafa left that colour unset (i.e. transparent)."""
    if rows in _face_cache:
        return _face_cache[rows]
    cmd = ["chafa", "-f", "symbols", "--polite", "on", "--colors", "full",
           "--symbols", SYMS, "--size", f"9999x{rows}", alpha_sprite()]
    text = subprocess.run(cmd, capture_output=True).stdout.decode("utf-8", "replace")

    ESC = "\x1b"
    fgc, bgc, rev = None, None, False
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
                ps = text[i + 2:j].split(";")
                k = 0
                while k < len(ps):
                    p = int(ps[k]) if ps[k] else 0
                    if p == 0:
                        fgc, bgc, rev = None, None, False
                    elif p == 7:
                        rev = True
                    elif p == 27:
                        rev = False
                    elif p == 39:
                        fgc = None
                    elif p == 49:
                        bgc = None
                    elif p in (38, 48) and k + 4 < len(ps) and ps[k + 1] == "2":
                        col = (int(ps[k + 2]), int(ps[k + 3]), int(ps[k + 4]))
                        if p == 38:
                            fgc = col
                        else:
                            bgc = col
                        k += 4
                    k += 1
            i = j + 1
        else:
            efg, ebg = (bgc, fgc) if rev else (fgc, bgc)
            row.append((c, efg, ebg))
            i += 1
    if row:
        out.append(row)
    _face_cache[rows] = out
    return out


def _truecolor(code, c):
    return f"\x1b[{code};2;{c[0]};{c[1]};{c[2]}m"


def _emit_cell(ch, efg, ebg, box_background):
    """Emit one face cell, compositing the transparent (unset) colour.

    On a coloured box the transparent colour becomes the box colour. On a
    term-bg (transparent) box the transparent colour must become the *terminal*
    background. That is trivial when transparency sits in the cell background
    (default bg, \x1b[49m), but when it sits in the foreground a default fg
    would paint it white. We instead flip the cell with reverse video
    (\x1b[7m): the glyph's "on" pixels then take the (default) background, i.e.
    the terminal, and the explicit colour moves to the "off" pixels -- same
    picture, no white edge, fully portable.
    """
    if box_background != TERM_BG:
        f = efg if efg is not None else box_background
        b = ebg if ebg is not None else box_background
        return "\x1b[27m" + _truecolor(38, f) + _truecolor(48, b) + ch
    if efg is None and ebg is None:
        return "\x1b[27m\x1b[39m\x1b[49m" + ch
    if efg is None:  # transparent foreground -> reverse so "on" pixels show terminal
        return "\x1b[7m" + _truecolor(38, ebg) + "\x1b[49m" + ch
    if ebg is None:  # transparent background -> terminal shows through directly
        return "\x1b[27m" + _truecolor(38, efg) + "\x1b[49m" + ch
    return "\x1b[27m" + _truecolor(38, efg) + _truecolor(48, ebg) + ch


def face_cell(cells, w, box_background):
    """Render one face row as a box cell of inner width w (centered).

    Only the transparent (unset) colour is composited onto the box background;
    explicit colours -- including any real black inside the face -- are kept.
    """
    vis = len(cells)
    total = max(0, w - vis)
    left = total // 2
    right = total - left
    s = bg(box_background) + " " + " " * left
    for ch, efg, ebg in cells:
        s += _emit_cell(ch, efg, ebg, box_background)
    s += RESET + bg(box_background) + " " * right + " " + RESET
    return s


# --- bar rendering ----------------------------------------------------------


def render(box_background, border_color, style, show_headers, mugshot_background=None):
    # The mugshot has its own background, independent of the data boxes
    # (e.g. blue boxes with a black mugshot). Defaults to the box background.
    mug_bg = box_background if mugshot_background is None else mugshot_background
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
            # Bare, full-height mugshot: no frame, no header, ever; own background.
            col = [face_cell(face[r], face_w, mug_bg) for r in range(total_rows)]
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
    ("M  panel  (BLUE boxes, BLACK mugshot -- independent backgrounds)",
     dict(box_background=(28, 32, 54), border_color=TERM_BG, style="vertical",
          mugshot_background=(0, 0, 0))),
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
