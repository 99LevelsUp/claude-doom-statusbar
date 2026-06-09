#!/usr/bin/env python3
"""Render a status-bar preset (TOML) to the terminal — a preview of the config.

Reads a preset that follows the ideation doc's Configuration Schema, fills each
metric with a simulated value, and renders the bar with the configured styling
(border style, backgrounds, headers, icons, threshold colours, responsive
widths) and a real chafa mugshot whose HP level reflects the simulated usage.

Usage:
    python tools/render_preset.py [PRESET.toml] [width]
Defaults: presets/default.toml at width 100. Run in a real terminal for colour.

Note: this preview supports border_style "none" and "vertical" (the shipped
presets); "frame" is in the schema but not yet drawn here.
"""

import os
import re
import sys
import tomllib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mockup_boxes import load_face_from, face_cell, bg, RESET, BOLD, WAD_DIR  # noqa: E402

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

TITLE = (222, 202, 128)
TEXT = (182, 186, 200)
OK, WARN, CRIT = (96, 200, 104), (224, 184, 64), (224, 84, 64)
SPARK = (120, 184, 232)
TERM_RGB = (0, 0, 0)            # assumed terminal background (for blends/look)

# Simulated metric values + availability (no live Claude Code data here).
SAMPLE = {
    "model.name": "Opus 4.8", "model.effort": "🌔", "advisor.state": "sleeping",
    "model.window": "1M", "model.mode": "💭 on  🚀 off", "model.style": "default",
    "usage.reset5h": "2h13m", "usage.reset7d": "3d4h", "sys.session": "5h55m", "loc.churn": "+185 / -62",
    "context.hp": 78, "ratelimit.5h": 64, "ratelimit.7d": 31, "cost.total": "$1.83",
    "git.branch": "main", "git.behind": "↓2", "git.ahead": "↑3", "git.status": "3",
    "pr.state": "#1234", "act.agents": "2",
    "act.geiger": [0, .25, .5, 1, .75, 1, .5, .6, .3, .1, .4, 1, .8, .4],  # duty 0..1
    "act.tasks": "2/5", "act.errors": "0", "sys.ram": 47, "sys.cpu": "12%",
    "sys.disk": 63, "sys.clock": "14:23",
}
EIGHTHS = " ▏▎▍▌▋▊▉"
HP_THRESHOLDS = [20, 40, 60, 80]


def f(c):
    return f"\x1b[38;2;{c[0]};{c[1]};{c[2]}m"


def vlen(s):
    # Width 2 only for the emoji block (U+1F300..U+1FAFF, our icons). Legacy-
    # computing block glyphs (U+1FB00.. and the U+1CC00.. supplement, used by the
    # face) and block elements render width 1 — must NOT be counted as 2.
    return sum(2 if 0x1F300 <= ord(ch) <= 0x1FAFF else 1 for ch in ANSI_RE.sub("", s))


def threshold(pct):
    return OK if pct < 60 else WARN if pct < 85 else CRIT


def rgb_of(spec):
    if isinstance(spec, str) and spec.startswith("#"):
        return tuple(int(spec[i:i + 2], 16) for i in (1, 3, 5))
    return TERM_RGB                       # term-bg / term-fg approximated for blends


def bgsgr(spec):
    if isinstance(spec, str) and spec.startswith("#"):
        r, g, b = rgb_of(spec)
        return f"\x1b[48;2;{r};{g};{b}m"
    return "\x1b[49m"                     # term-bg


def border_fg(spec):
    if isinstance(spec, str) and spec.startswith("#"):
        return f(rgb_of(spec))
    if spec == "term-fg":
        return "\x1b[39m"
    return "\x1b[38;2;0;0;0m"             # term-bg -> black-ish line


# --- render styles ----------------------------------------------------------

def r_bar(pct, cells, box_rgb, color_spec):
    empty = tuple((box_rgb[i] + TERM_RGB[i]) // 2 for i in range(3))
    eighths = round(pct / 100 * cells * 8)
    full = min(cells, eighths // 8)
    rem = eighths % 8 if full < cells else 0
    c = threshold(pct) if color_spec == "threshold" else (rgb_of(color_spec) if color_spec else TEXT)
    s = f"\x1b[48;2;{empty[0]};{empty[1]};{empty[2]}m" + f(c) + "█" * full
    if rem:
        s += EIGHTHS[rem]
    s += " " * max(0, cells - full - (1 if rem else 0))
    return s + bgsgr_box(box_rgb) + f(c) + f" {pct:>3}%"   # fixed-width % (aligned)


def bgsgr_box(box_rgb):
    if box_rgb == TERM_RGB:
        return "\x1b[49m"
    return f"\x1b[48;2;{box_rgb[0]};{box_rgb[1]};{box_rgb[2]}m"


def r_ammo(pct, color_spec, segs=5):
    c = threshold(pct) if color_spec == "threshold" else WARN
    filled = round(pct / 100 * segs)
    return f(c) + "▮" * filled + f((90, 95, 120)) + "▯" * (segs - filled) + f(c) + f" {pct:>3}%"


# Sparkline glyph tables: rows = left sub-bar height 0..4, cols = right height 0..4.
# Two sub-columns per cell double the time resolution vs. the single-column block
# ramp. Octant is solid bars (U+1CD.., Unicode 16); braille is dots (U+2800..,
# universal). Holes in the octant block fall back to half/quadrant/eighth chars;
# a lone lowest sub-bar rounds up to its quadrant (reads ~half a cell hotter).
SPARK_OCTANT = (
    " ▗▗\U0001cd96▐",
    "▖▂\U0001cdcb\U0001cdd3\U0001cdd5",
    "▖\U0001cdbb▄\U0001cde1▟",
    "\U0001cd48\U0001cdbf\U0001cdde▆\U0001cde5",
    "▌\U0001cdc0▙\U0001cde4█",
)
SPARK_BRAILLE = (
    "⠀⢀⢠⢰⢸",
    "⡀⣀⣠⣰⣸",
    "⡄⣄⣤⣴⣼",
    "⡆⣆⣦⣶⣾",
    "⡇⣇⣧⣷⣿",
)


def r_spark(values, style="block", box_rgb=TERM_RGB, vmax=None):
    """Sparkline. block: 7-level ramp, one cell per bin. octant / braille: two
    sub-bars per cell (4 levels each) -> double the time resolution, same width
    (block pair-downsamples to match). The track sits on the same 50% box/term
    blend as r_bar's empty region, then resets to the box background.

    vmax: absolute full-scale value -> heights are v/vmax (clamped 0..1), so a
    steady reading stays at a fixed bar height. Without it, scale is relative to
    the series min..max."""
    empty = tuple((box_rgb[i] + TERM_RGB[i]) // 2 for i in range(3))
    bg = f"\x1b[48;2;{empty[0]};{empty[1]};{empty[2]}m"
    if not values:
        return f(SPARK)
    if vmax:
        def nrm(v):
            return max(0.0, min(1.0, v / vmax))
    else:
        lo, span = min(values), max(values) - min(values)
        def nrm(v):
            return 0.0 if span == 0 else (v - lo) / span
    if style in ("octant", "braille"):
        tbl = SPARK_OCTANT if style == "octant" else SPARK_BRAILLE
        def h(v):
            return round(nrm(v) * 4)
        body = "".join(tbl[h(values[i])][h(values[i + 1]) if i + 1 < len(values) else 0]
                       for i in range(0, len(values), 2))
    else:
        g = "▁▂▃▄▅▆▇"                                    # block: pair-max downsample
        body = "".join(g[round(nrm(max(values[i:i + 2])) * 6)]
                       for i in range(0, len(values), 2))
    return bg + f(SPARK) + body + bgsgr_box(box_rgb)


# The engine reads metric values from VALUES (statusline.py swaps in real data).
VALUES = SAMPLE


def render_value(entry, cells, box_rgb):
    """Return the metric body string (icon label + rendered value)."""
    icon = entry.get("icon", "")
    label = (icon + " ") if icon else ""
    render = entry.get("render", "text")
    color = entry.get("color")

    if "group" in entry:
        sep = entry.get("sep", " ")
        parts = [str(VALUES[i]) for i in entry["group"] if i in VALUES]
        return label + f(TEXT) + sep.join(parts)
    val = VALUES.get(entry["id"], "?")
    if render == "bar":
        s = label + r_bar(val, cells, box_rgb, color or "threshold")
        sid = entry.get("suffix")                       # text appended after the % (e.g. "1M")
        if sid and sid in VALUES:
            s += f(TEXT) + " " + str(VALUES[sid])
        return s
    if render == "ammo":
        return label + r_ammo(val, color or "threshold")
    if render == "spark":
        return label + r_spark(val, entry.get("spark_style", "block"), box_rgb,
                               entry.get("spark_max"))
    # number / text
    if color == "threshold":
        try:
            col = threshold(int(re.sub(r"\D", "", str(val)) or 0))
        except ValueError:
            col = TEXT
    else:
        col = rgb_of(color) if color else TEXT
    return label + f(col) + str(val)


def bar_meta(entry):
    """(label_width, suffix_width, render) for width budgeting."""
    icon = entry.get("icon", "")
    lw = vlen((icon + " ") if icon else "")
    if entry.get("render") in ("bar", "ammo"):
        sw = 5                                          # fixed " NNN%" suffix
        sid = entry.get("suffix")
        if sid and sid in VALUES:
            sw += 1 + vlen(str(VALUES[sid]))            # + " <suffix>"
        return lw, sw, entry.get("render")
    return lw, 0, entry.get("render", "text")


# --- layout & assembly ------------------------------------------------------

def metric_fixed_width(entry):
    """Width of a non-bar metric (bars are width-flexible)."""
    icon = entry.get("icon", "")
    lw = vlen((icon + " ") if icon else "")
    r = entry.get("render", "text")
    rid = entry.get("right")
    rextra = (1 + vlen(str(VALUES[rid]))) if rid and rid in VALUES else 0  # gap + right value
    if "group" in entry:
        sep = entry.get("sep", " ")
        return lw + vlen(sep.join(str(VALUES[i]) for i in entry["group"] if i in VALUES)) + rextra
    if r == "spark":
        return lw + (len(VALUES.get(entry["id"], [])) + 1) // 2   # 2 bins per cell
    if r == "ammo":
        return lw + 5 + vlen(f" {VALUES.get(entry['id'], 0)}%")
    if r == "bar":
        return None                       # flexible
    return lw + vlen(str(VALUES.get(entry["id"], "?"))) + rextra


def available(entry):
    """A metric is shown only if its value(s) are present in VALUES."""
    if "group" in entry:
        return any(i in VALUES for i in entry["group"])
    return entry["id"] in VALUES


def box_width(box, cells):
    widths = [vlen(box.get("title", ""))]
    for m in box["metric"]:
        fw = metric_fixed_width(m)
        if fw is None:                    # bar
            lw, sw, _ = bar_meta(m)
            fw = lw + cells + sw
        widths.append(fw)
    w = max(widths)
    if "min_width" in box:
        w = max(w, box["min_width"])
    if "max_width" in box:
        w = min(w, box["max_width"])
    return w


def hp_row(thresholds=HP_THRESHOLDS):
    """HP row 0..4 from usage headroom; falls back to context when no rate limits."""
    if "ratelimit.5h" in VALUES or "ratelimit.7d" in VALUES:
        rem5 = 100 - VALUES.get("ratelimit.5h", 0)
        rem7 = 100 - VALUES.get("ratelimit.7d", 0) if "ratelimit.7d" in VALUES else 100
        headroom = min(rem5, rem7)
    else:
        headroom = 100 - VALUES.get("context.hp", 0)      # context fallback
    # sprite row 0 = healthiest, 4 = most hurt; row = how many thresholds the
    # headroom falls below (high headroom -> 0 -> healthy).
    return sum(1 for t in thresholds if headroom < t)


def build_bar(cfg, target, sprite_for=None):
    """Assemble the bar from a parsed preset + the current VALUES. sprite_for(hp)
    returns the mugshot sprite basename. Returns {lines, style, headers, cells, hp}."""
    if sprite_for is None:
        def sprite_for(hp):
            return f"STFST{hp}1"

    bar = cfg.get("bar", {})
    style = bar.get("border_style", "vertical")
    headers = bar.get("headers", True) and style != "frame"
    box_rgb = rgb_of(bar.get("box_background", "term-bg"))
    bcol = bar.get("border_color", "term-fg")
    mug_rgb = rgb_of(cfg.get("mugshot", {}).get("background", "#000000"))

    # availability: drop metrics whose value is absent; collapse empty boxes.
    segs = []
    for s in cfg["segment"]:
        if s["type"] == "mugshot":
            segs.append(s)
            continue
        mets = [m for m in s["metric"] if available(m)]
        if mets:
            segs.append({**s, "metric": mets})

    boxes = [s for s in segs if s["type"] == "box"]
    data_rows = max((len(b["metric"]) for b in boxes), default=0)
    headers_extra = 1 if headers else 0
    total_rows = max(data_rows + headers_extra, 4)        # 4 = mugshot floor
    n_cols = len(segs)

    hp = hp_row()
    face = load_face_from(os.path.join(WAD_DIR, sprite_for(hp) + ".png"), total_rows)
    face_w = max(len(r) for r in face)

    def col_widths(cells):
        ws, mug = [], None
        for i, s in enumerate(segs):
            if s["type"] == "mugshot":
                ws.append(face_w + 2)
                mug = i
            else:
                ws.append(box_width(s, cells) + 2)
        return ws, mug

    def balanced_width(cells):
        """Bar width once the narrower side is padded to centre the mugshot."""
        ws, mug = col_widths(cells)
        if mug is None:
            return sum(ws) + (len(ws) - 1)
        left = sum(ws[:mug]) + mug                          # left cols + seps incl. sep to mug
        right = sum(ws[mug + 1:]) + (len(ws) - 1 - mug)
        return 2 * max(left, right) + ws[mug]

    cells = 4
    for c in range(14, 3, -1):
        if balanced_width(c) <= target:
            cells = c
            break

    columns, mug_idx = [], None
    for s in segs:
        if s["type"] == "mugshot":
            mug_idx = len(columns)
            columns.append([face_cell(face[r], face_w, mug_rgb) for r in range(total_rows)])
            continue
        w = box_width(s, cells)
        col = []
        if headers:
            t = s.get("title", "")
            pad = w - vlen(t)
            left = pad // 2
            col.append(bgsgr_box(box_rgb) + BOLD + f(TITLE) + " " + " " * left + t + " " * (pad - left) + " " + RESET)
        for m in s["metric"]:
            # bars render at the global `cells` width so every bar (any box)
            # shrinks together; the box pads around them.
            body = render_value(m, cells if m.get("render") == "bar" else 0, box_rgb)
            rid = m.get("right")                            # value flushed to the box's right edge
            rhs = f(TEXT) + str(VALUES[rid]) if rid and rid in VALUES else ""
            body += " " * max(0, w - vlen(body) - vlen(rhs)) + rhs
            col.append(bgsgr_box(box_rgb) + " " + body + " " + RESET)
        while len(col) < total_rows:                       # pad to face floor
            col.append(bgsgr_box(box_rgb) + " " * (w + 2) + RESET)
        columns.append(col)

    if style == "none":
        sepstr = (RESET + " ") if box_rgb == TERM_RGB else (bgsgr_box(box_rgb) + " ")
    elif bcol == "term-bg":
        sepstr = RESET + " "
    else:
        sepstr = bgsgr_box(box_rgb) + border_fg(bcol) + "│"

    lines = []
    for r in range(total_rows):
        if mug_idx is None:                                 # no mugshot: centre whole bar
            body = sepstr.join(c[r] for c in columns)
            outer = max(0, (target - sum(vlen(c[r]) for c in columns) - (len(columns) - 1)) // 2)
            lines.append(RESET + " " * outer + body + RESET)
            continue
        left_seg = ""
        for i in range(mug_idx):
            left_seg += (sepstr if i else "") + columns[i][r]
        if mug_idx:
            left_seg += sepstr                              # sep between left group and mugshot
        right_seg = ""
        for j in range(mug_idx + 1, len(columns)):
            right_seg += sepstr + columns[j][r]
        lw, rw, mw = vlen(left_seg), vlen(right_seg), vlen(columns[mug_idx][r])
        side = max(lw, rw)
        left_seg = " " * (side - lw) + left_seg             # pad narrower side -> mugshot centred in bar
        right_seg = right_seg + " " * (side - rw)
        outer = max(0, (target - (2 * side + mw)) // 2)     # centre the symmetric bar on screen
        lines.append(RESET + " " * outer + left_seg + columns[mug_idx][r] + right_seg + RESET)
    return {"lines": lines, "style": style, "headers": headers, "cells": cells, "hp": hp}


def main():
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        path = arg if os.path.isabs(arg) else os.path.join(os.getcwd(), arg)
        if not os.path.exists(path):
            path = os.path.join(repo, "presets", os.path.basename(arg))
    else:
        path = os.path.join(repo, "presets", "default.toml")
    target = int(sys.argv[2]) if len(sys.argv) > 2 else 100

    cfg = tomllib.load(open(path, "rb"))
    res = build_bar(cfg, target)
    out = ["", f"  preset: {os.path.basename(path)}   style={res['style']}  "
           f"headers={str(res['headers']).lower()}  bar={res['cells']}", ""]
    out += res["lines"]
    out += [""]
    sys.stdout.buffer.write(("\n".join(out) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
