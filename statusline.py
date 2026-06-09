#!/usr/bin/env python3
"""Claude Code statusLine — the live DOOM HUD wired to real session data.

Reads the statusline JSON on stdin, fills metric values from it (+ git via
shell + the reaction state file written by hooks/mugshot_hook.py), picks the
mugshot (HP from usage headroom, expression from the hook state with decay,
idle from the wall clock, dead at exhaustion), and renders a preset.

settings.json:
  "statusLine": { "type": "command",
      "command": "python /abs/path/statusline.py", "refreshInterval": 1 }
  plus map the lifecycle events to hooks/mugshot_hook.py (see that file).

Config:  $DOOMBAR_PRESET  (default: presets/default.toml)
State:   $MUGSHOT_STATE  (default: <temp>/mugshot_state.json)
"""

import json
import os
import re
import shutil
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
GOD_TTL = 180.0        # safety cap on god mode if the advisor never returns
GEIGER_WINDOW = 30.0  # must match the hook's window
GEIGER_BINS = 14      # sparkline buckets (octant/braille pack 2 per cell)


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
        v["loc.cwd"] = os.path.basename(cwd.rstrip("/\\")) or cwd
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


def state_path(data):
    env = os.environ.get("MUGSHOT_STATE")
    if env:
        return env
    sid = re.sub(r"[^A-Za-z0-9_-]", "_", str(data.get("session_id") or "default"))[:48]
    return os.path.join(tempfile.gettempdir(), f"mugshot_{sid}.json")


def read_state(data):
    try:
        with open(state_path(data)) as fh:
            return json.load(fh)
    except Exception:
        return {}


def _ram_percent():
    try:
        import psutil
        return round(psutil.virtual_memory().percent)
    except Exception:
        pass
    if sys.platform == "win32":                          # stdlib-only Windows fallback
        try:
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            m = MS()
            m.dwLength = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return int(m.dwMemoryLoad)
        except Exception:
            return None
    return None


def _cpu_percent():
    """Non-blocking CPU%: delta of cumulative cpu_times between renders (cached)."""
    try:
        import psutil
        t = psutil.cpu_times()
        total, idle = sum(t), t.idle
    except Exception:
        return None
    cache = os.path.join(tempfile.gettempdir(), "mugshot_cpu.json")
    prev = None
    try:
        prev = json.load(open(cache))
    except Exception:
        pass
    try:
        json.dump({"total": total, "idle": idle}, open(cache, "w"))
    except Exception:
        pass
    if not prev:
        return None
    dt, di = total - prev["total"], idle - prev["idle"]
    return round(max(0, min(100, 100 * (1 - di / dt)))) if dt > 0 else None


def sys_values(cwd):
    """OS metrics (psutil if present, else stdlib fallbacks). Absent -> hidden."""
    v = {}
    ram = _ram_percent()
    if ram is not None:
        v["sys.ram"] = ram
    cpu = _cpu_percent()
    if cpu is not None:
        v["sys.cpu"] = f"{cpu}%"
    try:
        du = shutil.disk_usage(cwd or os.getcwd())
        v["sys.disk"] = round(du.used / du.total * 100)
    except Exception:
        pass
    v["sys.clock"] = time.strftime("%H:%M")
    return v


def activity_values(st, now):
    """Derive act.* metrics from the hook-bus state (absent keys -> hidden)."""
    v = {}
    if "spans" in st:
        binw = GEIGER_WINDOW / GEIGER_BINS
        start0 = now - GEIGER_WINDOW                  # left edge = oldest, right = now
        series = [0.0] * GEIGER_BINS
        for s, e in st["spans"]:
            e = now if e is None else e               # open span runs until now
            s, e = max(s, start0), min(e, now)
            if e <= s:
                continue
            i0 = max(0, int((s - start0) / binw))
            i1 = min(GEIGER_BINS - 1, int((e - start0) / binw - 1e-9))
            for i in range(i0, i1 + 1):
                bs = start0 + i * binw
                series[i] += min(e, bs + binw) - max(s, bs)   # seconds covered in bin
        v["act.geiger"] = [min(1.0, c / binw) for c in series]  # duty cycle 0..1
    if "agents" in st:
        v["act.agents"] = str(len(st["agents"]))
    if "tasks" in st:
        v["act.tasks"] = f"{st['tasks'].get('completed', 0)}/{st['tasks'].get('created', 0)}"
    if "errors" in st:
        v["act.errors"] = str(st["errors"])
    return v


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}

    preset = os.environ.get("DOOMBAR_PRESET") or os.path.join(HERE, "presets", "default.toml")
    cfg = tomllib.load(open(preset, "rb"))

    now = time.time()
    st = read_state(data)
    cwd = data.get("cwd") or (data.get("workspace") or {}).get("current_dir")
    values = build_values(data)
    values.update(activity_values(st, now))             # act.* from the hook-bus
    values.update(sys_values(cwd))                      # sys.* from the OS
    rp.VALUES = values                                  # engine reads real data now

    exhausted = values.get("context.hp", 0) >= 99
    if "ratelimit.5h" in values or "ratelimit.7d" in values:
        rem = min(100 - values.get("ratelimit.5h", 0),
                  100 - values.get("ratelimit.7d", 0) if "ratelimit.7d" in values else 100)
        exhausted = exhausted or rem <= 0

    def sprite_for(hp):
        if exhausted:
            return "STFDEAD0"
        if st.get("god_since") and now - st["god_since"] < GOD_TTL:
            return "STFGOD0"                             # invulnerable while the advisor thinks
        if st.get("expr") and now - st.get("ts", 0) < DECAY:
            return {
                "ouch": f"STFOUCH{hp}", "kill": f"STFKILL{hp}", "evl": f"STFEVL{hp}",
                "tl": f"STFTL{hp}0", "tr": f"STFTR{hp}0",
            }.get(st["expr"], f"STFST{hp}1")
        return f"STFST{hp}{_pick(int(now // IDLE_CYCLE))}"   # idle glance from the clock

    target = int(os.environ.get("COLUMNS") or 100)
    res = rp.build_bar(cfg, target, sprite_for=sprite_for)
    sys.stdout.buffer.write(("\n".join(res["lines"]) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
