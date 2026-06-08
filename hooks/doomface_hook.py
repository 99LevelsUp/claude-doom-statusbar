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


# Read-class (scanning -> look around) and write-class (-> rampage). Covers both
# native tools and lean-ctx MCP tools (mcp__lean-ctx__ctx_*), matched by base name.
READ_TOOLS = {"Read", "Grep", "Glob",
              "ctx_read", "ctx_multi_read", "ctx_search", "ctx_semantic_search",
              "ctx_tree", "ctx_overview"}
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "Bash",
               "ctx_shell", "ctx_edit"}


def _base(tool):
    """Strip the mcp__<server>__ prefix so lean-ctx tools match by base name."""
    return tool.split("__")[-1] if tool.startswith("mcp__") else tool


def expression(ev):
    """Map a hook event to a face expression (or None for no reaction)."""
    name = ev.get("hook_event_name", "")
    base = _base(ev.get("tool_name", ""))
    if name in ("PostToolUseFailure", "StopFailure", "PermissionDenied"):
        return "ouch"                                   # took a hit / blocked
    if name in ("Stop", "TaskCompleted"):
        return "evl"                                    # success grin (every clean end)
    if name == "PostToolUse":
        if base in READ_TOOLS:                          # scanning -> look around
            return "tl" if int(time.time() * 2) % 2 == 0 else "tr"
        if base in WRITE_TOOLS:                          # write/edit/bash/shell -> rampage
            return "kill"
    return None                                         # other events: no reaction


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
