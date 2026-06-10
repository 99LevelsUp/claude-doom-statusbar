#!/usr/bin/env python3
"""Claude Code hook: an event-bus for the DOOM HUD.

Each invocation reads the shared state file, folds in the lifecycle event, and
writes it back atomically. The state carries two things the status line reads:

  - face reaction: {"expr": <expr>, "ts": <epoch>}  (decays on the render side)
  - activity:      spans[] [start, end] tool run intervals (geiger duty cycle),
                   agents[] (running subagents), tasks{created,completed},
                   errors  (lights the ACTIVITY box)

Idle is stateless (wall clock); reactions and activity are stateful (here).
The hook always exits 0 so it never blocks the tool/turn.

Wire the events you want in settings.json (see the ideation doc's "Wiring"):
PostToolUse, PostToolUseFailure, Stop, PermissionDenied (face) and
SubagentStart, SubagentStop, TaskCreated, TaskCompleted (activity).

State file: $MUGSHOT_STATE, else <temp>/mugshot_<session_id>.json.
"""

import json
import os
import re
import sys
import tempfile
import time

GEIGER_WINDOW = 30.0          # seconds of tool-run history kept for the sparkline
MAX_RUN = 300.0               # drop an unclosed span after this (assume the Post was lost)

READ_TOOLS = {"Read", "Grep", "Glob",
              "ctx_read", "ctx_multi_read", "ctx_search", "ctx_semantic_search",
              "ctx_tree", "ctx_overview"}
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "Bash",
               "ctx_shell", "ctx_edit"}


def state_path(ev):
    env = os.environ.get("MUGSHOT_STATE")
    if env:
        return env
    sid = re.sub(r"[^A-Za-z0-9_-]", "_", str(ev.get("session_id") or "default"))[:48]
    return os.path.join(tempfile.gettempdir(), f"mugshot_{sid}.json")


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
    st.setdefault("spans", [])
    st.setdefault("squad", {})
    st.setdefault("pending", [])
    st.setdefault("tasks", {"created": 0, "completed": 0})
    st.setdefault("errors", 0)

    tool = _base(ev.get("tool_name", ""))
    if name == "PreToolUse":
        st["spans"].append([now, None])              # open a run interval
        if tool == "Agent":                          # stash the launch label (no shared id
            ti = ev.get("tool_input") or {}          # with SubagentStart, so match by type)
            st["pending"].append({"type": ti.get("subagent_type", ""),
                                  "desc": ti.get("description", ""), "ts": now})
            st["pending"] = [p for p in st["pending"] if now - p["ts"] < 60][-16:]
    elif name in ("PostToolUse", "PostToolUseFailure", "PermissionDenied"):
        for s in reversed(st["spans"]):              # close the most recent open one
            if s[1] is None:
                s[1] = now
                break

    if name in ("PostToolUseFailure", "StopFailure", "PermissionDenied"):
        st["errors"] += 1
    elif name == "SubagentStart":
        aid = str(ev.get("agent_id") or now)
        atype = ev.get("agent_type") or "agent"
        desc = ""
        for i, p in enumerate(st["pending"]):        # FIFO match the launch by agent type
            if p["type"] == atype:
                desc = p["desc"]
                st["pending"].pop(i)
                break
        st["squad"][aid] = {"type": atype, "start": now, "desc": desc}
    elif name == "SubagentStop":
        st["squad"].pop(str(ev.get("agent_id") or ""), None)
    elif name == "TaskCreated":
        st["tasks"]["created"] += 1
    elif name == "TaskCompleted":
        st["tasks"]["completed"] += 1

    win = now - GEIGER_WINDOW                         # prune: closed spans out of the
    kept = []                                         # window, orphaned open spans
    for s in st["spans"]:
        if s[1] is None:
            if s[0] >= now - MAX_RUN:
                kept.append(s)
        elif s[1] >= win:
            kept.append(s)
    st["spans"] = kept
    st["squad"] = {k: v for k, v in st["squad"].items()  # drop orphaned subagents
                   if now - v["start"] < MAX_RUN}


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

    if ev.get("permission_mode"):                  # not in the statusline payload, only here
        st["mode"] = ev["permission_mode"]

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
