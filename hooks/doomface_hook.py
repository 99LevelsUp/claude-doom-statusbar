#!/usr/bin/env python3
"""Claude Code hook: map a lifecycle event to a transient mugshot expression.

Reads the hook JSON on stdin and writes {expr, ts} to a small state file that
the status line reads (and decays) on its next render. This is the bridge that
lets the bar REACT to events the render pass didn't witness — the event-driven
layer (Idea #2). Idle is stateless (wall clock); reactions are stateful (here).

Wire in settings.json, mapping the events you care about to this script, e.g.:

  "hooks": {
    "PostToolUse":        [{ "hooks": [{ "type": "command",
        "command": "python /abs/path/hooks/doomface_hook.py" }] }],
    "PostToolUseFailure": [{ "hooks": [{ "type": "command",
        "command": "python /abs/path/hooks/doomface_hook.py" }] }],
    "Stop":               [{ "hooks": [{ "type": "command",
        "command": "python /abs/path/hooks/doomface_hook.py" }] }]
  }

State file: $DOOMFACE_STATE, else <temp>/doomface_state.json.
The hook always exits 0 so it never blocks the tool/turn.
"""

import json
import os
import sys
import tempfile
import time


def state_path():
    return os.environ.get("DOOMFACE_STATE") or os.path.join(
        tempfile.gettempdir(), "doomface_state.json")


def expression(ev):
    """Map a hook event to a face expression (or None for no reaction)."""
    name = ev.get("hook_event_name", "")
    tool = ev.get("tool_name", "")
    if name in ("PostToolUseFailure", "StopFailure"):
        return "ouch"                                   # took a hit
    if name in ("Stop", "TaskCompleted"):
        return "evl"                                    # success grin
    if name == "PostToolUse":
        if tool in ("Read", "Grep", "Glob"):            # scanning -> look around
            return "tl" if int(time.time() * 2) % 2 == 0 else "tr"
        return "kill"                                   # acting -> rampage
    return None


def main():
    try:
        ev = json.load(sys.stdin)
    except Exception:
        ev = {}
    expr = expression(ev)
    if expr:
        with open(state_path(), "w") as fh:
            json.dump({"expr": expr, "ts": time.time()}, fh)
    sys.exit(0)


if __name__ == "__main__":
    main()
