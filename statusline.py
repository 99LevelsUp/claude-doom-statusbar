#!/usr/bin/env python3
"""Claude Code statusLine — the live DOOM HUD wired to real session data.

Reads the statusline JSON on stdin, fills metric values from it (+ git via
shell + the reaction state file written by hooks/doomface_hook.py), picks the
mugshot (HP from usage headroom, expression from the hook state with decay,
idle from the wall clock, dead at exhaustion), and renders a preset.

settings.json:
  "statusLine": { "type": "command",
      "command": "python /abs/path/statusline.py", "refreshInterval": 1 }
  plus map the lifecycle events to hooks/doomface_hook.py (see that file).

Config:  $DOOMBAR_PRESET  (default: presets/default.toml)
State:   $DOOMFACE_STATE  (default: <temp>/doomface_state.json)
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "tools"))
import render_preset as rp  # noqa: E402

DECAY = 1.5            # seconds a reaction holds before relaxing to idle
IDLE_CYCLE = 2         # seconds per idle glance


def git(cwd, *args):
    try:
        r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=1)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def build_values(data):
    """Map the statusline JSON (+ git shell) to catalog metric ids."""
    v = {}
    cw = data.get("context_window") or {}
    if "used_percentage" in cw:
        v["context.hp"] = round(cw["used_percentage"])
    rl = data.get("rate_limits") or {}
    if rl.get("five_hour"):
        v["ratelimit.5h"] = round(rl["five_hour"]["used_percentage"])
    if rl.get("seven_day"):
        v["ratelimit.7d"] = round(rl["seven_day"]["used_percentage"])
    cost = data.get("cost") or {}
    if "total_cost_usd" in cost:
        v["cost.total"] = f"${cost['total_cost_usd']:.2f}"

    cwd = data.get("cwd") or (data.get("workspace") or {}).get("current_dir")
    if cwd:
        br = git(cwd, "branch", "--show-current")
        if br:
            v["git.branch"] = br
        lr = git(cwd, "rev-list", "--count", "--left-right", "@{u}...HEAD")
        if lr and "\t" in lr:
            behind, ahead = lr.split("\t")
            v["git.behind"], v["git.ahead"] = f"↓{behind}", f"↑{ahead}"
        st = git(cwd, "status", "--porcelain")
        if st is not None:
            v["git.status"] = str(len([ln for ln in st.splitlines() if ln.strip()]))
    return v


def _pick(bucket):
    x = (bucket * 0x9E3779B1) & 0xFFFFFFFF
    x ^= x >> 15
    x = (x * 0x85EBCA77) & 0xFFFFFFFF
    x ^= x >> 13
    return x % 3


def read_reaction():
    path = os.environ.get("DOOMFACE_STATE") or os.path.join(tempfile.gettempdir(), "doomface_state.json")
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}

    preset = os.environ.get("DOOMBAR_PRESET") or os.path.join(HERE, "presets", "default.toml")
    cfg = tomllib.load(open(preset, "rb"))

    values = build_values(data)
    rp.VALUES = values                                  # engine reads real data now

    now = time.time()
    react = read_reaction()
    exhausted = values.get("context.hp", 0) >= 99
    if "ratelimit.5h" in values or "ratelimit.7d" in values:
        rem = min(100 - values.get("ratelimit.5h", 0),
                  100 - values.get("ratelimit.7d", 0) if "ratelimit.7d" in values else 100)
        exhausted = exhausted or rem <= 0

    def sprite_for(hp):
        if exhausted:
            return "STFDEAD0"
        if react and now - react.get("ts", 0) < DECAY:
            return {
                "ouch": f"STFOUCH{hp}", "kill": f"STFKILL{hp}", "evl": f"STFEVL{hp}",
                "tl": f"STFTL{hp}0", "tr": f"STFTR{hp}0",
            }.get(react.get("expr"), f"STFST{hp}1")
        return f"STFST{hp}{_pick(int(now // IDLE_CYCLE))}"   # idle glance from the clock

    target = int(os.environ.get("COLUMNS") or 100)
    res = rp.build_bar(cfg, target, sprite_for=sprite_for)
    sys.stdout.buffer.write(("\n".join(res["lines"]) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
