// Make sure a Linux desktop can draw the bar's emoji, and install Noto Color Emoji for the user
// when it cannot. Called by `claude-doom-statusbar install` (bin/cli.js).
//
// Only Linux needs this: Windows ships Segoe UI Emoji and macOS ships Apple Color Emoji, and the
// bar draws fine there out of the box. A Linux install without a colour emoji font (Raspberry Pi
// OS, minimal Debian/Ubuntu) shows "tofu" boxes with hex codes instead of 🧠 💾 🪓.
//
// The install is per-user and needs no sudo: the font goes to $XDG_DATA_HOME/fonts (by default
// ~/.local/share/fonts), which fontconfig reads, then `fc-cache` refreshes the cache. The file is
// a pinned release of googlefonts/noto-emoji (SIL OFL 1.1), checked against its SHA-256 before it
// is written, so a changed or truncated download is never installed.
//
// Everything that touches the system comes in through `deps`, so the test drives every branch
// without a network or fontconfig.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const FONT_FILE = "NotoColorEmoji.ttf";
export const FONT_URL = "https://github.com/googlefonts/noto-emoji/raw/v2.051/fonts/NotoColorEmoji.ttf";
export const FONT_SHA256 = "72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b";

// Emoji the bar draws, picked from the newest Unicode versions it uses (🪶 is Emoji 13, 🪓 12,
// 🦴 11) plus an old one. A font with all of them draws the rest too.
export const PROBE = ["1f479", "1f9b4", "1fa93", "1fab6"];

// Family names of fonts that cover every probe, or null when fontconfig is not there to ask.
function coveringFonts(run) {
  let out;
  try {
    out = run("fc-list", [`:charset=${PROBE.join(" ")}`, "family"]);
  } catch {
    return null;
  }
  return [...new Set(String(out).split("\n").map((s) => s.split(",")[0].trim()).filter(Boolean))];
}

export function fontDir(env = process.env, home = os.homedir()) {
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : path.join(home, ".local", "share");
  return path.join(data, "fonts");
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const defaults = {
  platform: process.platform,
  env: process.env,
  home: os.homedir(),
  run: (cmd, args) => execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }),
  download,
  sha256: FONT_SHA256,
  writeFont(dir, data) {
    mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, FONT_FILE);
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    try { renameSync(tmp, dest); } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
    return dest;
  },
};

// Returns { status, notes }. status is one of: skipped (not Linux, or turned off), ok (a font
// already covers the emoji), unknown (no fontconfig), remote (SSH: the font belongs on the client),
// installed, failed.
export async function ensureEmojiFont(opts = {}) {
  const d = { ...defaults, ...opts };
  if (d.platform !== "linux") return { status: "skipped", notes: [] };
  if (d.skip || d.env.DOOMBAR_NO_FONTS === "1") {
    return { status: "skipped", notes: ["emoji font check skipped (--no-fonts)"] };
  }

  const have = coveringFonts(d.run);
  if (have === null) {
    return { status: "unknown", notes: ["could not check for an emoji font (fc-list not found); if the bar shows boxes, install fonts-noto-color-emoji"] };
  }
  if (have.length) return { status: "ok", notes: [`emoji font : ${have[0]}`] };

  // Over SSH the terminal draws the glyphs on the machine you sit at, so a font installed here
  // would change nothing. Say so instead.
  if (d.env.SSH_CONNECTION || d.env.SSH_TTY) {
    return { status: "remote", notes: ["no emoji font here, but this is an SSH session: install a colour emoji font (e.g. Noto Color Emoji) on the machine running your terminal"] };
  }

  const dir = fontDir(d.env, d.home);
  try {
    const data = await d.download(FONT_URL);
    const sum = createHash("sha256").update(data).digest("hex");
    if (sum !== d.sha256) throw new Error(`checksum mismatch (got ${sum.slice(0, 12)}…)`);
    const dest = d.writeFont(dir, data);
    try { d.run("fc-cache", ["-f", dir]); } catch {}
    return { status: "installed", notes: [`emoji font : installed Noto Color Emoji into ${dest}`, "restart your terminal so it picks up the new font"] };
  } catch (e) {
    return { status: "failed", notes: [`could not install Noto Color Emoji (${e.message}); install it yourself: sudo apt install fonts-noto-color-emoji`] };
  }
}
