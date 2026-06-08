#!/usr/bin/env python3
"""Interactive prototype of the hook -> state-file -> render reaction loop.

Press a key to SIMULATE Claude Code firing a hook: it spawns the real hook
script (hooks/mugshot_hook.py) with a sample payload on stdin, which writes the
shared state file. The render loop below is independent — it only polls that
file, applies the decay timer, and otherwise plays the idle animation. That is
exactly the production decoupling: the hook process is not the render process.

Keys: o = tool error (ouch)   e = Stop (grin)   k = Bash tool (kill)
      l = Read tool (look)     d = damage   h = heal   q = quit

Usage: python tools/face_hook_demo.py [rows]
"""

import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from face_live import face, sprite_name, pick, read_key, out, MUG_BG  # noqa: E402
from mockup_boxes import face_cell, RESET  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(REPO, "hooks", "mugshot_hook.py")
STATE = os.path.join(tempfile.gettempdir(), "mugshot_demo_state.json")
DECAY = 1.5
CYCLE = 2

PAYLOADS = {
    "o": {"hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "error": "boom"},
    "e": {"hook_event_name": "Stop"},
    "k": {"hook_event_name": "PostToolUse", "tool_name": "Bash"},
    "l": {"hook_event_name": "PostToolUse", "tool_name": "Read"},
}


def fire(payload):
    env = dict(os.environ, MUGSHOT_STATE=STATE)
    subprocess.run([sys.executable, HOOK], input=json.dumps(payload).encode(), env=env)


def read_state():
    try:
        with open(STATE) as fh:
            return json.load(fh)
    except Exception:
        return None


def main():
    rows = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    hp = 1
    try:
        os.remove(STATE)
    except OSError:
        pass

    out("\x1b[2J\x1b[?25l")
    try:
        while True:
            k = read_key()
            if k == "q":
                break
            elif k in PAYLOADS:
                fire(PAYLOADS[k])
            elif k == "d":
                hp = min(4, hp + 1)
            elif k == "h":
                hp = max(0, hp - 1)

            now = time.time()
            st = read_state()
            if st and now - st["ts"] < DECAY:
                state = st["expr"]
                src = f"file -> {state}  ({DECAY - (now - st['ts']):.1f}s left)"
            else:
                state = "idle"
                src = "idle (wall clock)"
            frame = pick(int(now // CYCLE)) if state == "idle" else 0

            fc = face(state, hp, frame, rows)
            fw = max(len(r) for r in fc)
            buf = ["\x1b[H", "  Hook -> state file -> render  (reaction prototype)\x1b[K\n\x1b[K\n"]
            for r in range(rows):
                buf.append("  " + face_cell(fc[r], fw, MUG_BG) + "\x1b[K\n")
            buf.append("\x1b[K\n")
            buf.append(f"  HP lvl {hp}   {src}   sprite {sprite_name(state, hp, frame)}\x1b[K\n")
            buf.append("\x1b[K\n")
            buf.append("  [o] tool-error   [e] Stop   [k] Bash   [l] Read    [d]amage [h]eal   [q]uit\x1b[K\n")
            buf.append("  (each key spawns hooks/mugshot_hook.py, which writes the state file)\x1b[K\n")
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
