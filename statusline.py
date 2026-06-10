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
import pathlib
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
GOD_FLASH = 3.0        # seconds the mugshot stays god after an advisor consult lands
GEIGER_WINDOW = 30.0  # must match the hook's window
GEIGER_BINS = 14      # sparkline buckets (octant/braille pack 2 per cell)


def git(cwd, *args):
    try:
        r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=1)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def _dur(secs):
    """Humanise a duration in seconds: 3d4h / 2h13m / 7m."""
    secs = max(0, int(secs))
    d, r = divmod(secs, 86400)
    h, r = divmod(r, 3600)
    m, s = divmod(r, 60)
    if d:
        return f"{d}d{h}h"
    if h:
        return f"{h}h{m:02d}m"
    if m:
        return f"{m}m"
    return f"{s}s"


def _link(text, url):
    """Wrap text in an OSC 8 terminal hyperlink (Ctrl/Cmd-click). vlen strips it."""
    return f"\x1b]8;;{url}\x1b\\{text}\x1b]8;;\x1b\\" if url else text


def _pretty_model(mid):
    """claude-opus-4-8 -> Opus 4.8 (best-effort from a model id)."""
    mid = re.sub(r"\[.*?\]$", "", mid).replace("claude-", "")
    parts = mid.split("-")
    return f"{parts[0].capitalize()} {'.'.join(parts[1:])}".strip() if parts else mid


def _advisor_info(path):
    """(configured /advisor model, last advisor_tool_result timestamp) from the transcript
    tail. The model is stamped on ~every record; the result ts only appears at turn end
    (so it's a 'just consulted' signal, not a live one). Tail-read — the file is large."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 65536))
            chunk = f.read().decode("utf-8", "ignore")
    except Exception:
        return None, None
    model = res_ts = None
    for ln in chunk.splitlines():
        if "advisorModel" not in ln and "advisor_tool_result" not in ln:
            continue
        try:
            o = json.loads(ln)
        except Exception:
            continue
        if o.get("advisorModel"):
            model = o["advisorModel"]                    # last wins (most recent record)
        c = (o.get("message") or {}).get("content")
        if isinstance(c, list) and any(b.get("type") == "advisor_tool_result" for b in c):
            res_ts = o.get("timestamp") or res_ts
    return (_pretty_model(model) if model else None), res_ts


def _god_flash(data, adv_ts, now):
    """STFGOD0 window opened when a *new* advisor result first appears (flushed at the
    turn boundary). Discovery-based — keyed on the result timestamp, not its (older) value."""
    sid = re.sub(r"[^A-Za-z0-9_-]", "_", str(data.get("session_id") or "default"))[:48]
    cache = os.path.join(tempfile.gettempdir(), f"mugshot_adv_{sid}.json")
    try:
        c = json.load(open(cache))
    except Exception:
        c = {}
    if adv_ts and adv_ts != c.get("seen"):
        if "seen" in c:                                  # not the first scan -> a fresh consult
            c["god_until"] = now + GOD_FLASH
        c["seen"] = adv_ts
        try:
            json.dump(c, open(cache, "w"))
        except Exception:
            pass
    return c.get("god_until", 0)


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
    if rl.get("five_hour", {}).get("resets_at"):            # reset countdown -> bar suffix
        v["usage.reset5h"] = _dur(rl["five_hour"]["resets_at"] - time.time())
    if rl.get("seven_day", {}).get("resets_at"):
        v["usage.reset7d"] = _dur(rl["seven_day"]["resets_at"] - time.time())
    cost = data.get("cost") or {}
    if "total_cost_usd" in cost:
        v["cost.total"] = f"${cost['total_cost_usd']:.2f}"
    if "total_duration_ms" in cost:
        v["sys.session"] = _dur(cost["total_duration_ms"] / 1000)
    if "total_lines_added" in cost or "total_lines_removed" in cost:
        a, r = cost.get("total_lines_added", 0), cost.get("total_lines_removed", 0)
        v["loc.churn"] = f"{rp.f(rp.OK)}+{a}{rp.f(rp.TEXT)} / {rp.f(rp.CRIT)}-{r}"  # +green -red

    m = data.get("model") or {}
    if m.get("display_name"):
        v["model.name"] = m["display_name"].split(" (")[0]    # drop "(1M context)" tail
    eff = (data.get("effort") or {}).get("level")
    if eff:                                                   # waxing moon -> sun, icon only
        icon = {"low": "🌒", "medium": "🌓", "high": "🌔", "xhigh": "🌕", "max": "🌞"}
        v["model.effort"] = icon.get(eff, "🌓")
    cwm = (data.get("context_window") or {}).get("context_window_size")
    if cwm:                                                   # context window -> 🧠 bar suffix
        v["model.window"] = f"{cwm // 1000000}M" if cwm >= 1000000 else f"{cwm // 1000}K"
    th = data.get("thinking") or {}
    mode = []
    if "enabled" in th:
        mode.append(f"💭 {'on' if th['enabled'] else 'off'}")
    if "fast_mode" in data:
        mode.append(f"🚀 {'on' if data['fast_mode'] else 'off'}")
    if mode:
        v["model.mode"] = "  ".join(mode)                     # thinking + fast on one row
    style = (data.get("output_style") or {}).get("name")
    if style:
        v["model.style"] = style

    repo = (data.get("workspace") or {}).get("repo") or {}
    repo_url = ""
    if repo.get("host") and repo.get("owner") and repo.get("name"):
        repo_url = f"https://{repo['host']}/{repo['owner']}/{repo['name']}"

    cwd = data.get("cwd") or (data.get("workspace") or {}).get("current_dir")
    if cwd:
        name = os.path.basename(cwd.rstrip("/\\")) or cwd
        try:                                              # clickable -> opens the folder
            v["loc.cwd"] = _link(name, pathlib.Path(cwd).as_uri())
        except Exception:
            v["loc.cwd"] = name
        br = git(cwd, "branch", "--show-current")
        if br:                                            # clickable -> the branch on the host
            v["git.branch"] = _link(br, f"{repo_url}/tree/{br}") if repo_url else br
        lr = git(cwd, "rev-list", "--count", "--left-right", "@{u}...HEAD")
        if lr and "\t" in lr:
            behind, ahead = lr.split("\t")
            v["git.behind"], v["git.ahead"] = f"↓{behind}", f"↑{ahead}"
        st = git(cwd, "status", "--porcelain")
        if st is not None:
            v["git.status"] = str(len([ln for ln in st.splitlines() if ln.strip()]))

    pr = data.get("pr") or {}
    if pr.get("number") or pr.get("url"):                 # clickable -> the pull request
        label = f"#{pr['number']}" if pr.get("number") else (pr.get("review_state") or "PR")
        v["pr.state"] = _link(label, pr.get("url"))
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
    if "squad" in st:                                 # running-subagent count (also in SUBAGENTS)
        v["act.agents"] = str(len(st["squad"]))
    squad = st.get("squad") or {}
    if squad:                                         # live list of running subagents
        CAP = 4
        agents = sorted(squad.values(), key=lambda a: a["start"])
        rows = []
        for a in agents[:CAP]:
            label = a.get("desc") or a.get("type") or "agent"
            if len(label) > 20:
                label = label[:19] + "…"
            rows.append([label, _dur(now - a["start"])])   # [name, right-aligned runtime]
        if len(agents) > CAP:
            rows.append([f"+{len(agents) - CAP} more", ""])
        v["act.subagents"] = rows
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
    adv_model, adv_ts = _advisor_info(data.get("transcript_path") or "")
    if adv_model:
        values["advisor.model"] = adv_model             # 🧙 configured /advisor model
    god_until = _god_flash(data, adv_ts, now)           # brief god face after a consult lands
    rp.VALUES = values                                  # engine reads real data now

    # Death follows the same source as hp_row: usage headroom when rate limits
    # exist, context only as a fallback (so shrinking the context window by
    # switching models can't kill an otherwise-healthy face).
    if "ratelimit.5h" in values or "ratelimit.7d" in values:
        rem = min(100 - values.get("ratelimit.5h", 0),
                  100 - values.get("ratelimit.7d", 0) if "ratelimit.7d" in values else 100)
        exhausted = rem <= 0
    else:
        exhausted = values.get("context.hp", 0) >= 99

    def sprite_for(hp):
        if exhausted:
            return "STFDEAD0"
        if now < god_until:
            return "STFGOD0"                             # just consulted the advisor
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
