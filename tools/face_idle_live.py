#!/usr/bin/env python3
"""Live demo of the idle mugshot animation.

When the session is idle, DOOM's face glances around — it cycles the three
"straight ahead" frames (STFST00 / STFST01 / STFST02) at random. We pick the
frame from the WALL CLOCK so the renderer stays stateless:

    bucket = floor(epoch_seconds / 2)        # a new bucket every 2 s
    frame  = pick(bucket)                    # deterministic pseudo-random (repeats ok)

In production this needs no daemon: Claude Code re-runs the status line on a
timer when `refreshInterval` (min 1 s) is set in settings.json, so each
re-invocation independently computes the current frame from the clock. This
script just simulates that timer in a loop so you can watch it.

Usage:
    python tools/face_idle_live.py [rows]      # rows = face height, default 8

Press Ctrl+C to quit.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mockup_boxes import load_face_from, face_cell, RESET  # noqa: E402

ART_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "assets", "images", "mugshot", "wad")
IDLE = ["STFST00", "STFST01", "STFST02"]
MUG_BG = (0, 0, 0)            # native black backdrop
CYCLE = 2                     # seconds per idle frame


def pick(bucket):
    """Pseudo-random 0..2 from the bucket (a linear map mod 3 only cycles)."""
    x = (bucket * 0x9E3779B1) & 0xFFFFFFFF
    x ^= x >> 15
    x = (x * 0x85EBCA77) & 0xFFFFFFFF
    x ^= x >> 13
    return x % 3


def frame_for(bucket):
    """Pseudo-random frame for a 2-second bucket. Repeats are fine and
    authentic — DOOM's idle face also re-rolls and sometimes holds a frame."""
    return pick(bucket)


def out(s):
    sys.stdout.buffer.write(s.encode("utf-8"))


def main():
    rows = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    faces = [load_face_from(os.path.join(ART_DIR, f"{n}.png"), rows) for n in IDLE]
    face_w = max(len(r) for fc in faces for r in fc)

    out("\x1b[2J\x1b[?25l")          # clear screen, hide cursor
    try:
        while True:
            now = time.time()
            bucket = int(now // CYCLE)
            fr = frame_for(bucket)
            remain = CYCLE - (now - bucket * CYCLE)

            buf = ["\x1b[H"]          # cursor home; overwrite in place
            buf.append("  DOOM idle face — random STFST00/01/02 every 2 s (stateless, from the clock)\x1b[K\n\x1b[K\n")
            for r in range(rows):
                buf.append("  " + face_cell(faces[fr][r], face_w, MUG_BG) + "\x1b[K\n")
            buf.append("\x1b[K\n")
            buf.append(f"  frame {fr} = {IDLE[fr]}   bucket {bucket}   next glance in {remain:0.1f}s\x1b[K\n")
            buf.append("  production: settings.json refreshInterval re-runs the bar on a timer;\x1b[K\n")
            buf.append("  the frame is computed from wall-clock time, so no daemon is needed.\x1b[K\n")
            buf.append("  Ctrl+C to quit.\x1b[K\n")
            out("".join(buf) + RESET)
            sys.stdout.flush()
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    finally:
        out("\x1b[?25h\n")           # show cursor
        sys.stdout.flush()


if __name__ == "__main__":
    main()
