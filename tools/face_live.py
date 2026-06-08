#!/usr/bin/env python3
"""Interactive live demo of the mugshot: idle animation + reactions.

Two axes drive the face (see the ideation doc's "Mugshot - Face States"):
  - HP level 0..4 (healthiest..most hurt) -> the sprite row
  - expression -> idle (st0/1/2), look (tl/tr), or a reaction (ouch/evl/kill),
    plus the specials god / dead.

Idle is stateless (frame from the wall clock). A reaction is a persisted event
with a decay timer: it shows for ~1.5 s, then the face relaxes back to idle.
This menu lets you fire those events by hand.

Keys:
    o = ouch (took a hit)      e = evil grin (success)    k = kill (rampage)
    l = look left              r = look right
    d = damage (HP down)       h = heal (HP up)
    g = toggle god mode        x = toggle dead
    q = quit

Usage:
    python tools/face_live.py [rows]      # face height, default 10
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mockup_boxes import load_face_from, face_cell, RESET  # noqa: E402

ART_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "assets", "images", "mugshot", "wad")
MUG_BG = (0, 0, 0)
DECAY = 1.5          # seconds a reaction holds before relaxing to idle
CYCLE = 2            # seconds per idle frame

GREEN, AMBER, RED, GREY = (96, 200, 104), (224, 184, 64), (224, 84, 64), (120, 124, 150)


def fg(c):
    return f"\x1b[38;2;{c[0]};{c[1]};{c[2]}m"


def pick(bucket):
    x = (bucket * 0x9E3779B1) & 0xFFFFFFFF
    x ^= x >> 15
    x = (x * 0x85EBCA77) & 0xFFFFFFFF
    x ^= x >> 13
    return x % 3


def sprite_name(state, hp, frame):
    return {
        "dead": "STFDEAD0",
        "god": "STFGOD0",
        "ouch": f"STFOUCH{hp}",
        "kill": f"STFKILL{hp}",
        "evl": f"STFEVL{hp}",
        "tl": f"STFTL{hp}0",
        "tr": f"STFTR{hp}0",
    }.get(state, f"STFST{hp}{frame}")


def face(state, hp, frame, rows):
    name = sprite_name(state, hp, frame)
    return load_face_from(os.path.join(ART_DIR, f"{name}.png"), rows)


def out(s):
    sys.stdout.buffer.write(s.encode("utf-8"))


def read_key():
    """Non-blocking single keypress (Windows). Returns lowercase char or None."""
    try:
        import msvcrt
    except ImportError:
        return None
    if msvcrt.kbhit():
        ch = msvcrt.getwch()
        if ch in ("\x00", "\xe0"):   # special-key prefix; consume the second byte
            msvcrt.getwch()
            return None
        return ch.lower()
    return None


def hp_bar(hp):
    full = 5 - hp
    col = GREEN if hp <= 1 else AMBER if hp <= 3 else RED
    return fg(col) + "♥" * full + fg(GREY) + "·" * hp + RESET


STATE_LABEL = {
    "idle": "idle (glancing)", "tl": "look left", "tr": "look right",
    "ouch": "OUCH (hit)", "evl": "grin (success)", "kill": "RAMPAGE",
    "god": "GOD MODE", "dead": "DEAD",
}


def main():
    rows = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    hp = 0
    god = dead = False
    reaction = None
    rts = 0.0

    out("\x1b[2J\x1b[?25l")
    try:
        while True:
            k = read_key()
            if k == "q":
                break
            elif k in ("o", "e", "k", "l", "r"):
                reaction = {"o": "ouch", "e": "evl", "k": "kill", "l": "tl", "r": "tr"}[k]
                rts = time.time()
            elif k == "d":
                hp = min(4, hp + 1)
            elif k == "h":
                hp = max(0, hp - 1)
            elif k == "g":
                god = not god
            elif k == "x":
                dead = not dead

            now = time.time()
            if dead:
                state = "dead"
            elif god:
                state = "god"
            elif reaction and now - rts < DECAY:
                state = reaction
            else:
                state = "idle"
            frame = pick(int(now // CYCLE)) if state == "idle" else 0

            fc = face(state, hp, frame, rows)
            fw = max(len(r) for r in fc)

            buf = ["\x1b[H", "  DOOM mugshot — idle animation + reactions (live)\x1b[K\n\x1b[K\n"]
            for r in range(rows):
                buf.append("  " + face_cell(fc[r], fw, MUG_BG) + "\x1b[K\n")
            buf.append("\x1b[K\n")
            buf.append(f"  HP {hp_bar(hp)}  lvl {hp}   state: {STATE_LABEL[state]}   sprite: {sprite_name(state, hp, frame)}\x1b[K\n")
            buf.append("\x1b[K\n")
            buf.append("  [o]uch  [e]grin  [k]ill   [l]/[r] look   [d]amage [h]eal   [g]od [x]dead   [q]uit\x1b[K\n")
            out("".join(buf) + RESET)
            sys.stdout.flush()
            time.sleep(0.08)
    except KeyboardInterrupt:
        pass
    finally:
        out("\x1b[?25h\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
