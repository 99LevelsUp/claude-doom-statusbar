#!/usr/bin/env node
// Unit test for src/emoji-font.js: every branch, driven through injected deps (no network,
// no fontconfig, no writes outside a temp dir).

import { createHash } from "node:crypto";
import path from "node:path";
import { ensureEmojiFont, fontDir, FONT_FILE, FONT_URL, FONT_SHA256, PROBE } from "../src/emoji-font.js";

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { console.log(`  FAIL ${msg}`); failures++; }
};

const notFound = () => { const e = new Error("spawn fc-list ENOENT"); e.code = "ENOENT"; throw e; };

// A fake system: fc-list answers from `families`, downloads return `payload`, writes are recorded.
function sys({ families = "", payload = Buffer.from("font"), env = {}, platform = "linux", run } = {}) {
  const calls = { run: [], download: [], write: [] };
  return {
    calls,
    deps: {
      platform, env, home: "/home/u",
      run: run ?? ((cmd, args) => { calls.run.push([cmd, ...args]); return cmd === "fc-list" ? families : ""; }),
      download: async (url) => { calls.download.push(url); return payload; },
      writeFont: (dir, data) => { calls.write.push([dir, data.length]); return path.join(dir, FONT_FILE); },
    },
  };
}

{
  for (const platform of ["win32", "darwin"]) {
    const s = sys({ platform });
    const r = await ensureEmojiFont(s.deps);
    ok(r.status === "skipped" && r.notes.length === 0 && s.calls.run.length === 0,
      `${platform}: nothing is checked or installed`);
  }
}
{
  const s = sys();
  const r = await ensureEmojiFont({ ...s.deps, skip: true });
  ok(r.status === "skipped" && s.calls.run.length === 0, "--no-fonts skips the check");
  const s2 = sys({ env: { DOOMBAR_NO_FONTS: "1" } });
  const r2 = await ensureEmojiFont(s2.deps);
  ok(r2.status === "skipped" && s2.calls.run.length === 0, "DOOMBAR_NO_FONTS=1 skips the check");
}
{
  const s = sys({ families: "Noto Color Emoji\nTwemoji,Twitter Color Emoji\n" });
  const r = await ensureEmojiFont(s.deps);
  ok(r.status === "ok" && r.notes[0].includes("Noto Color Emoji"), "a covering font is reported, nothing installed");
  ok(s.calls.download.length === 0 && s.calls.write.length === 0, "no download when a font covers the emoji");
  ok(s.calls.run[0][1] === `:charset=${PROBE.join(" ")}`, "fc-list is asked for all probe code points at once");
}
{
  const s = sys({ run: notFound });
  const r = await ensureEmojiFont(s.deps);
  ok(r.status === "unknown" && s.calls.download.length === 0, "no fontconfig: reported, nothing installed");
}
{
  const s = sys({ env: { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" } });
  const r = await ensureEmojiFont(s.deps);
  ok(r.status === "remote" && s.calls.download.length === 0, "SSH session: told to install on the client");
}
{
  const s = sys({ payload: Buffer.from("not the font") });
  const r = await ensureEmojiFont(s.deps);
  ok(r.status === "failed" && /checksum/.test(r.notes[0]), "a download with the wrong hash is refused");
  ok(s.calls.write.length === 0, "a refused download is never written");
  ok(s.calls.download[0] === FONT_URL, "the pinned URL is fetched");
}
{
  const s = sys();
  const r = await ensureEmojiFont({ ...s.deps, download: async () => { throw new Error("offline"); } });
  ok(r.status === "failed" && r.notes[0].includes("offline"), "a failed download is reported, not thrown");
}
{
  ok(/^[0-9a-f]{64}$/.test(FONT_SHA256), "the pinned hash is a SHA-256");
  const payload = Buffer.from("pretend font");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const s = sys({ payload });
  const r = await ensureEmojiFont({ ...s.deps, sha256 });
  const dir = path.join("/home/u", ".local", "share", "fonts");
  ok(r.status === "installed", "a verified download is installed");
  ok(s.calls.write.length === 1 && s.calls.write[0][0] === dir, "written into ~/.local/share/fonts");
  ok(s.calls.run.some((c) => c[0] === "fc-cache" && c.includes(dir)), "fc-cache refreshes the font dir");
  ok(r.notes.some((n) => /restart your terminal/.test(n)), "the user is told to restart the terminal");
}
{
  ok(fontDir({}, "/home/u") === path.join("/home/u", ".local", "share", "fonts"), "default font dir is ~/.local/share/fonts");
  ok(fontDir({ XDG_DATA_HOME: "/data" }, "/home/u") === path.join("/data", "fonts"), "XDG_DATA_HOME is honoured");
  ok(fontDir({ XDG_DATA_HOME: "rel" }, "/home/u") === path.join("/home/u", ".local", "share", "fonts"), "a relative XDG_DATA_HOME is ignored");
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nemoji-font: all ok");
