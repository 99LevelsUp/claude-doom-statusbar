#!/usr/bin/env python3
"""Build the in-project mugshot assets.

1. Copy the extracted WAD face PNGs into  assets/images/mugshot/wad/
2. Render every face with chafa (the symbol set defined in the ideation doc)
   at every height 4..16 into  assets/images/mugshot/ans/<size>/<NAME>.ans

The chafa parameters match the project's mugshot rendering contract:
    -f symbols --polite on --colors full
    --symbols block+half+quad+sextant+wedge+legacy --size 9999x<N>

Usage:
    python tools/build_mugshot_assets.py [SRC_PNG_DIR]
SRC_PNG_DIR defaults to the freshly-extracted wad_faces beside DOOM1.WAD.
"""

import glob
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WAD_DST = os.path.join(REPO, "assets", "images", "mugshot", "wad")
ANS_DST = os.path.join(REPO, "assets", "images", "mugshot", "ans")
SRC_DEFAULT = r"D:\Smeti\Dev\claude-doom-statusbar\wad_faces"

SYMS = "block+half+quad+sextant+wedge+legacy"
SIZES = range(4, 17)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else SRC_DEFAULT
    os.makedirs(WAD_DST, exist_ok=True)

    pngs = sorted(glob.glob(os.path.join(src, "*.png")))
    if not pngs:
        raise SystemExit(f"No PNGs in {src}")
    for p in pngs:
        shutil.copy2(p, os.path.join(WAD_DST, os.path.basename(p)))
    print(f"Copied {len(pngs)} PNGs -> {WAD_DST}")

    total = 0
    for size in SIZES:
        d = os.path.join(ANS_DST, str(size))
        os.makedirs(d, exist_ok=True)
        for p in pngs:
            name = os.path.splitext(os.path.basename(p))[0]
            cmd = ["chafa", "-f", "symbols", "--polite", "on", "--colors", "full",
                   "--symbols", SYMS, "--size", f"9999x{size}",
                   os.path.join(WAD_DST, f"{name}.png")]
            ans = subprocess.run(cmd, capture_output=True).stdout
            with open(os.path.join(d, f"{name}.ans"), "wb") as fh:
                fh.write(ans)
            total += 1
        print(f"  size {size:2d}: {len(pngs)} faces")
    print(f"\nGenerated {total} .ans files -> {ANS_DST}")


if __name__ == "__main__":
    main()
