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
    "context.hp": 78, "ratelimit.5h": 64, "ratelimit.7d": 31, "cost.total": "$1.83",
    "git.branch": "main", "git.behind": "↓2", "git.ahead": "↑3", "git.status": "3",
    "pr.state": "#1234", "act.geiger": [1, 0, 2, 4, 3, 6, 4], "act.agents": "2",
    "act.tasks": "2/5", "act.errors": "0", "sys.ram": 47, "sys.cpu": "12%",
    "sys.disk": 63, "sys.clock": "14:23",
}
EIGHTHS = " ▏▎▍▌▋▊▉"
HP_THRESHOLDS = [20, 40, 60, 80]


def f(c):
    return f"\x1b[38;2;{c[0]};{c[1]};{c[2]}m"


def vlen(s):
    return sum(2 if ord(ch) >= 0x1F000 else 1 for ch in ANSI_RE.sub("", s))


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
    return s + bgsgr_box(box_rgb) + f(c) + f" {pct}%"


def bgsgr_box(box_rgb):
    if box_rgb == TERM_RGB:
        return "\x1b[49m"
    return f"\x1b[48;2;{box_rgb[0]};{box_rgb[1]};{box_rgb[2]}m"


def r_ammo(pct, color_spec, segs=5):
    c = threshold(pct) if color_spec == "threshold" else WARN
    filled = round(pct / 100 * segs)
    return f(c) + "▮" * filled + f((90, 95, 120)) + "▯" * (segs - filled) + f(c) + f" {pct}%"


def r_spark(values):
    lo, hi = min(values), max(values)
    g = "▁▂▃▄▅▆▇"
    return f(SPARK) + "".join(g[0 if hi == lo else round((v - lo) / (hi - lo) * 6)] for v in values)


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
        return label + r_bar(val, cells, box_rgb, color or "threshold")
    if render == "ammo":
        return label + r_ammo(val, color or "threshold")
    if render == "spark":
        return label + r_spark(val)
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
        pct = VALUES.get(entry["id"], 0)
        return lw, vlen(f" {pct}%"), entry.get("render")
    return lw, 0, entry.get("render", "text")


# --- layout & assembly ------------------------------------------------------

def metric_fixed_width(entry):
    """Width of a non-bar metric (bars are width-flexible)."""
    icon = entry.get("icon", "")
    lw = vlen((icon + " ") if icon else "")
    r = entry.get("render", "text")
    if "group" in entry:
        sep = entry.get("sep", " ")
        return lw + vlen(sep.join(str(VALUES[i]) for i in entry["group"] if i in VALUES))
    if r == "spark":
        return lw + len(VALUES.get(entry["id"], []))
    if r == "ammo":
        return lw + 5 + vlen(f" {VALUES.get(entry['id'], 0)}%")
    if r == "bar":
        return None                       # flexible
    return lw + vlen(str(VALUES.get(entry["id"], "?")))


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
    row = sum(1 for t in thresholds if headroom < t)
    return 4 - row                        # higher headroom -> lower row (healthier)


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

    def total_width(cells):
        tot = 2 + (n_cols - 1)
        for s in segs:
            tot += (face_w + 2) if s["type"] == "mugshot" else (box_width(s, cells) + 2)
        return tot

    cells = 4
    for c in range(14, 3, -1):
        if total_width(c) <= target:
            cells = c
            break

    columns = []
    for s in segs:
        if s["type"] == "mugshot":
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
            if m.get("render") == "bar":
                lw, sw, _ = bar_meta(m)
                body = render_value(m, max(1, w - lw - sw), box_rgb)
            else:
                body = render_value(m, 0, box_rgb)
            body += " " * max(0, w - vlen(body))
            col.append(bgsgr_box(box_rgb) + " " + body + " " + RESET)
        while len(col) < total_rows:                      # pad to face floor
            col.append(bgsgr_box(box_rgb) + " " * (w + 2) + RESET)
        columns.append(col)

    def sep():
        if style == "none":
            return (RESET + " ") if box_rgb == TERM_RGB else (bgsgr_box(box_rgb) + " ")
        if bcol == "term-bg":
            return RESET + " "
        return bgsgr_box(box_rgb) + border_fg(bcol) + "│"

    lines = []
    for r in range(total_rows):
        lines.append("".join((sep() if i else "") + c[r] for i, c in enumerate(columns)) + RESET)
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
    out += ["  " + ln for ln in res["lines"]]
    out += [""]
    sys.stdout.buffer.write(("\n".join(out) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
