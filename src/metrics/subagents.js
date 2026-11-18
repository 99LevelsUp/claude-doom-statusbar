// What Claude Code itself says about a running subagent.
//
// The hooks tell the bar only a subagent's id and type (SubagentStart). Its description is in the
// Agent launch, but parallel launches of one type start in any order and a launch without a type
// names none, so matching the two by order mixes the labels up. Claude Code keeps a small file per
// subagent next to the session's transcript, <transcript>/subagents/agent-<id>.meta.json, with the
// launch's `description` and `finished` once the subagent is done. The bar reads that file, by the
// subagent's id, for its label, and leaves out a subagent that is finished even when its
// SubagentStop never arrived.
//
// Read on the render path, so each file is read again only when it changes, and a file that is not
// there (an older Claude Code, a subagent just starting) means "nothing known": the bar falls back
// to what the hooks told it.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const cache = new Map(); // file -> { stamp, meta }

// The meta file of subagent `id` of the session whose transcript is `transcript`, or null.
export function metaFile(transcript, id) {
  if (typeof transcript !== "string" || !transcript.endsWith(".jsonl") || !AGENT_ID.test(String(id))) return null;
  const dir = path.join(path.dirname(transcript), path.basename(transcript, ".jsonl"), "subagents");
  return path.join(dir, `agent-${id}.meta.json`);
}

// { description, finished } of subagent `id`, or null when Claude Code has no file for it.
export function subagentMeta(transcript, id) {
  const file = metaFile(transcript, id);
  if (!file) return null;
  let stamp;
  try { const s = statSync(file); stamp = `${s.size}@${s.mtimeMs}`; } catch { cache.delete(file); return null; }
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.meta;
  let meta = null;
  try {
    const m = JSON.parse(readFileSync(file, "utf8"));
    meta = {
      description: typeof m.description === "string" && m.description.trim() ? m.description.trim() : null,
      finished: m.finished === true,
    };
  } catch { /* half written: next render */ }
  cache.set(file, { stamp, meta });
  return meta;
}
