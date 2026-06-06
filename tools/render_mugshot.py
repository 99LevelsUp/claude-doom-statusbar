#!/usr/bin/env python3
"""Prepare the original DOOM face sprite to sit beside the block-art mugshot.

The block-art mugshot (``mugshot_blockart_08.png``) is a screenshot of chafa's
real terminal output: in a terminal the legacy-computing glyphs (U+1FB00.. and
the supplement U+1CD00..) are drawn by the terminal's built-in glyph rasteriser,
so no font is needed. A static PNG bake cannot reuse that path -- no common
installed font covers those code points -- so the faithful art comes from a
terminal capture rather than from re-rendering here.

This script only prepares the left-hand reference image: it takes the source
sprite, makes its magenta key colour transparent, and scales it (crisp, nearest
neighbour) to the exact pixel height of the block-art image so the two line up.
"""

import os
from PIL import Image

ORIG_PNG = r"D:\Smeti\Dev\claude-doom-statusbar\doomguy_faces_orig\STFST01.png"
OUT_DIR = r"D:\Smeti\Dev\Claude\claude-doom-statusbar\docs\images"
BLOCKART = os.path.join(OUT_DIR, "mugshot_blockart_08.png")
OUT_ORIG = os.path.join(OUT_DIR, "mugshot_orig_08.png")

MAGENTA = (255, 0, 255)
MAGENTA_TOL = 40


def make_transparent(img, key=MAGENTA, tol=MAGENTA_TOL):
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if abs(r - key[0]) <= tol and abs(g - key[1]) <= tol and abs(b - key[2]) <= tol:
                px[x, y] = (r, g, b, 0)
    return img


def trim(img):
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def main():
    target_h = Image.open(BLOCKART).height  # match the block-art image height

    sprite = trim(make_transparent(Image.open(ORIG_PNG)))
    scale = target_h / sprite.height
    out_w = max(1, round(sprite.width * scale))
    out = sprite.resize((out_w, target_h), Image.NEAREST)
    out.save(OUT_ORIG)

    print(f"block-art height: {target_h}")
    print(f"orig  saved     : {OUT_ORIG}  {out.size}")


if __name__ == "__main__":
    main()
