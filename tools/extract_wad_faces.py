#!/usr/bin/env python3
"""Extract the status-bar face graphics (STF* lumps) from a DOOM WAD to PNGs.

Files are named exactly as the WAD lumps (e.g. STFST01.png, STFGOD0.png).
Decoding follows the DOOM picture (patch) format and uses the PLAYPAL palette;
transparency is preserved as a real alpha channel (no magenta key colour).

Usage:
    python tools/extract_wad_faces.py [WAD] [OUT_DIR]

Defaults:
    WAD     = D:\\Smeti\\Dev\\claude-doom-statusbar\\DOOM1.WAD
    OUT_DIR = <WAD dir>\\wad_faces
"""

import os
import struct
import sys

from PIL import Image

DEFAULT_WAD = r"D:\Smeti\Dev\claude-doom-statusbar\DOOM1.WAD"


def read_directory(data):
    magic = data[:4].decode("ascii", "replace")
    if magic not in ("IWAD", "PWAD"):
        raise SystemExit(f"Not a WAD file (magic={magic!r})")
    numlumps, infoofs = struct.unpack("<ii", data[4:12])
    lumps = []
    for i in range(numlumps):
        e = infoofs + i * 16
        filepos, size = struct.unpack("<ii", data[e:e + 8])
        name = data[e + 8:e + 16].split(b"\x00")[0].decode("ascii", "replace")
        lumps.append((name, filepos, size))
    return lumps


def get_palette(data, lumps):
    for name, pos, size in lumps:
        if name == "PLAYPAL":
            raw = data[pos:pos + 768]                  # first of 14 palettes
            return [(raw[i], raw[i + 1], raw[i + 2]) for i in range(0, 768, 3)]
    raise SystemExit("PLAYPAL not found")


def decode_patch(buf, palette):
    """Decode a DOOM patch lump into an RGBA PIL image."""
    width, height, _lo, _to = struct.unpack("<hhhh", buf[:8])
    column_ofs = struct.unpack(f"<{width}I", buf[8:8 + width * 4])
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    px = img.load()
    for x in range(width):
        o = column_ofs[x]
        while True:
            topdelta = buf[o]; o += 1
            if topdelta == 0xFF:
                break
            length = buf[o]; o += 1
            o += 1                                     # unused padding byte
            for i in range(length):
                idx = buf[o + i]
                y = topdelta + i
                if 0 <= y < height:
                    r, g, b = palette[idx]
                    px[x, y] = (r, g, b, 255)
            o += length + 1                            # skip pixels + trailing pad
    return img


def is_face(name):
    # All STF* lumps are the status-face namespace; STFB0-3 are multiplayer
    # background tiles, not faces, so they are excluded.
    return name.startswith("STF") and not name.startswith("STFB")


def main():
    wad = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_WAD
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    default_out = os.path.join(repo, "assets", "images", "mugshot", "wad")
    out = sys.argv[2] if len(sys.argv) > 2 else default_out
    os.makedirs(out, exist_ok=True)

    data = open(wad, "rb").read()
    lumps = read_directory(data)
    palette = get_palette(data, lumps)

    n = 0
    for name, pos, size in lumps:
        if not is_face(name):
            continue
        img = decode_patch(data[pos:pos + size], palette)
        img.save(os.path.join(out, f"{name}.png"))
        n += 1
        print(f"  {name:9s} {img.width}x{img.height}")
    print(f"\nExtracted {n} faces to {out}")


if __name__ == "__main__":
    main()
