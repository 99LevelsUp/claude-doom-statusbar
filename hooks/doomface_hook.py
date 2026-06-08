#!/usr/bin/env python3
"""Claude Code hook: an event-bus for the DOOM HUD.

Each invocation reads the shared state file, folds in the lifecycle event, and
writes it back atomically. The state carries two things the status line reads:

  - face reaction: {"expr": <expr>, "ts": <epoch>}  (decays on the render side)
  - activity:      tools[] timestamps (geiger), agents[] (running subagents),
                   tasks{created,completed}, errors  (lights the FIGHT box)

Idle is stateless (wall clock); reactions and activity are stateful (here).
The hook always exits 0 so it never blocks the tool/turn.

Wire the events you want in settings.json (see the ideation doc's "Wiring"):
PostToolUse, PostToolUseFailure, Stop, PermissionDenied (face) and
SubagentStart, SubagentStop, TaskCreated, TaskCompleted (activity).

State file: $DOOMFACE_STATE, else <temp>/doomface_<session_id>.json.
"""

import json
import os
import re
import sys
import tempfile
import time

GEIGER_WINDOW = 30.0          # seconds of tool-call history kept for the sparkline

READ_TOOLS = {"Read", "Grep", "Glob",
              "ctx_read", "ctx_multi_read", "ctx_search", "ctx_semantic_search",
              "ctx_tree", "ctx_overview"}
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "Bash",
               "ctx_shell", "ctx_edit"}


def state_path(ev):
    env = os.environ.get("DOOMFACE_STATE")
    if env:
        return env
    sid = re.sub(r"[^A-Za-z0-9_-]", "_", str(ev.get("session_id") or "default"))[:48]
    return os.path.join(tempfile.gettempdir(), f"doomface_{sid}.json")


def _base(tool):
    return tool.split("__")[-1] if tool.startswith("mcp__") else tool


def expression(name, tool):
    """Map an event to a transient face expression (or None)."""
    base = _base(tool)
    if name in ("PostToolUseFailure", "StopFailure", "PermissionDenied"):
        return "ouch"
    if name in ("Stop", "TaskCompleted"):
        return "evl"
    if name == "PostToolUse":
        if base in READ_TOOLS:
            return "tl" if int(time.time() * 2) % 2 == 0 else "tr"
        if base in WRITE_TOOLS:
            return "kill"
    return None


def fold_activity(st, name, ev, now):
    st.setdefault("tools", [])
    st.setdefault("agents", [])
    st.setdefault("tasks", {"created": 0, "completed": 0})
    st.setdefault("errors", 0)

    if name == "PostToolUse":
        st["tools"].append(now)
    elif name in ("PostToolUseFailure", "StopFailure", "PermissionDenied"):
        st["errors"] += 1
    elif name == "SubagentStart":
        st["agents"].append(ev.get("agent_name") or ev.get("agent_type") or "agent")
    elif name == "SubagentStop":
        a = ev.get("agent_name") or ev.get("agent_type") or "agent"
        if a in st["agents"]:
            st["agents"].remove(a)
        elif st["agents"]:
            st["agents"].pop()
    elif name == "TaskCreated":
        st["tasks"]["created"] += 1
    elif name == "TaskCompleted":
        st["tasks"]["completed"] += 1

    cutoff = now - GEIGER_WINDOW                     # prune the geiger window
    st["tools"] = [t for t in st["tools"] if t >= cutoff]


def main():
    try:
        ev = json.load(sys.stdin)
    except Exception:
        ev = {}
    name = ev.get("hook_event_name", "")
    now = time.time()
    path = state_path(ev)

    try:
        with open(path) as fh:
            st = json.load(fh)
    except Exception:
        st = {}

    fold_activity(st, name, ev, now)
    expr = expression(name, ev.get("tool_name", ""))
    if expr:
        st["expr"], st["ts"] = expr, now

    # God mode while the advisor tool is running: set on PreToolUse(advisor),
    # cleared when it returns (PostToolUse / failure). Safety TTL on the read side.
    if _base(ev.get("tool_name", "")) == "advisor":
        if name == "PreToolUse":
            st["god_since"] = now
        elif name in ("PostToolUse", "PostToolUseFailure"):
            st.pop("god_since", None)

    tmp = f"{path}.{os.getpid()}.tmp"               # atomic write
    try:
        with open(tmp, "w") as fh:
            json.dump(st, fh)
        os.replace(tmp, path)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
