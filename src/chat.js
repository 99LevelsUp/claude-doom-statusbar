// The hotbar theme's chat: a Minecraft-style chat log on the left of the screen.
//
// It costs no tokens. It's a long pre-written script that loops forever, a new message
// every few seconds (sooner when someone asked a question), picked by the clock. The model
// you're running is always one of the speakers ("me"); the others are filled in from the
// rest of the model family.
//
// The chat is also where EVERYTHING the status bar knows about the session gets said, since
// the hotbar only has nine (configurable) slots: model, effort, thinking / fast mode,
// permissions, context, both usage limits and their resets, cost, the project, session,
// branch, changes, PR, agents, tasks, errors, savings and the machine. facts() collects them
// all; a line whose fact isn't known right now (or whose `when` doesn't hold) is left out.

// Timing feels like people typing: an answer to a question comes quickly, anything else
// after a varied pause. The pauses are fixed per line (not truly random), so every render
// in the same second shows the same chat.
const ANSWER_DELAY = 2;              // seconds after a message ending in "?"
const PAUSE_MIN = 3, PAUSE_MAX = 10; // seconds before any other message

// The model family the other speakers are drawn from. If you're running one of them, it's
// you; otherwise the first three play the other parts.
const FAMILY = ["Fable 5.1", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"];

// Plain (no ANSI / hyperlink) string of a metric value, or null when absent.
const ESC_RE = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g;
const plain = (v) => (v == null || v === "" ? null : String(v).replace(ESC_RE, "").trim() || null);
const num = (v) => { const m = /-?\d+(\.\d+)?/.exec(plain(v) || ""); return m ? Number(m[0]) : null; };

// Every fact the status bar knows, as plain strings / numbers (null = unknown).
export function facts(v) {
  const F = {};
  F.model = plain(v["model.name"]);
  F.effort = plain(v["model.effort_level"]);
  F.window = plain(v["model.window"]);
  const mode = plain(v["model.mode"]) || "";
  F.thinking = (/💭 (on|off)/.exec(mode) || [])[1] || null;
  F.fast = (/🚀 (on|off)/.exec(mode) || [])[1] || null;
  F.permission = (plain(v["model.permission"]) || "").split(/\s+/).pop() || null; // plan / auto / bypass
  F.style = plain(v["model.style"]);
  F.advisor = plain(v["advisor.model"]);

  F.ctx = num(v["context.hp"]);                           // context used %
  F.ctxLeft = F.ctx == null ? null : 100 - F.ctx;
  F.p5 = num(v["ratelimit.5h"]);
  F.p5Left = F.p5 == null ? null : 100 - F.p5;
  F.reset5h = plain(v["usage.reset5h"]);
  F.p7 = num(v["ratelimit.7d"]);
  F.reset7d = plain(v["usage.reset7d"]);
  F.cost = plain(v["cost.total"]);

  F.session = plain(v["session.title"]);
  F.project = plain(v["loc.cwd"]);
  F.branch = plain(v["git.branch"]);
  F.changed = num(v["git.status"]);
  F.behind = num(v["git.behind"]);
  F.ahead = num(v["git.ahead"]);
  F.added = num(v["loc.added"]);
  const churn = plain(v["loc.churn"]) || "";
  F.removed = /-(\d+)/.test(churn) ? Number(/-(\d+)/.exec(churn)[1]) : null;
  F.pr = plain(v["pr.state"]);

  const geiger = v["act.geiger"];
  F.busy = Array.isArray(geiger) && geiger.length
    ? Math.round((geiger.reduce((a, x) => a + x, 0) / geiger.length) * 100) : null;
  F.agents = num(v["act.agents"]);
  const squad = Array.isArray(v["act.subagents"]) ? v["act.subagents"] : [];
  F.agent = squad.length ? plain(squad[0][0]) : null;
  F.agentTime = squad.length ? plain(squad[0][1]) : null;
  F.tasks = plain(v["act.tasks"]);
  const list = Array.isArray(v["act.tasklist"]) ? v["act.tasklist"] : [];
  F.task = plain((list.find((t) => t.mark === "⏩") || {}).text);
  F.nextTask = plain((list.find((t) => t.mark === "🎯") || {}).text);
  F.doneTask = plain((list.filter((t) => t.mark === "✅").pop() || {}).text);
  F.errors = num(v["act.errors"]);

  F.saved = plain(v["save.leanctx"]);
  F.lingua = plain(v["save.lingua"]);

  F.cpu = plain(v["sys.cpu"]);
  const cores = v["sys.cores"];
  F.cores = Array.isArray(cores) ? cores.length : null;
  F.hotCore = Array.isArray(cores) && cores.length ? Math.round(Math.max(...cores) * 100) : null;
  F.ram = num(v["sys.ram"]);
  F.disk = num(v["sys.disk"]);
  F.zombies = num(v["sys.zombies"]);
  F.uptime = plain(v["sys.session"]);
  F.clock = plain(v["sys.clock"]);
  F.hour = F.clock ? Number(F.clock.split(":")[0]) : null;
  return F;
}

// The script. Speakers: "me" = the selected model, "a" / "b" / "c" = the other three.
//   ["me", "text"]              <Opus 5.5> text
//   ["me", ["text", "backup"]]  the first option whose {facts} are all known
//   ["me", "text", (F) => …]    only while the condition holds
//   ["join", "a"] / ["leave", "b"]   Sonnet 5.5 joined / left the game
//   ["adv", "me", "Name"]            Opus 5.5 has made the advancement [Name]
// {name} is any key of facts() above; {me} {a} {b} {c} are the speakers.
const SCRIPT = [
  ["join", "a"],
  ["a", "Hey {me}!!"],
  ["me", ["hi! working on {session}", "hi! busy rn"]],
  ["a", "what are you building?"],
  ["me", ["{project}. it's going well", "a status bar. in a terminal"]],
  ["a", "which branch?", (F) => F.branch],
  ["me", "{branch}"],
  ["a", "nice biome", (F) => F.branch],
  ["me", "{changed} files changed so far", (F) => F.changed > 0],
  ["me", "no changes yet. just looking around", (F) => F.changed === 0],
  ["join", "b"],
  ["b", "did someone say hotbar"],
  ["b", "{me} what's your effort level?", (F) => F.effort],
  ["me", ["{effort}. thinking is {thinking}", "{effort}"]],
  ["b", "fast mode?", (F) => F.fast],
  ["me", "fast mode {fast}"],
  ["a", "zoom zoom", (F) => F.fast === "on"],
  ["me", "plan mode. just looking, not touching", (F) => F.permission === "plan"],
  ["me", "auto mode. no questions asked", (F) => F.permission === "auto"],
  ["me", "bypass mode. living dangerously", (F) => F.permission === "bypass"],
  ["b", "what output style?", (F) => F.style && F.style !== "default"],
  ["me", "{style}", (F) => F.style && F.style !== "default"],
  ["me", "my advisor is {advisor}"],
  ["a", "wise choice", (F) => F.advisor],
  ["b", "how full is your head?", (F) => F.ctx != null],
  ["me", ["context {ctx}% full, out of {window}", "context {ctx}% full"]],
  ["a", "{me} eat something, you're down to {ctxLeft}% food", (F) => F.ctxLeft != null && F.ctxLeft <= 25],
  ["me", "plenty of food left", (F) => F.ctxLeft != null && F.ctxLeft > 75],
  ["b", "anyone got diamonds?"],
  ["a", "i have 3 and a stick"],
  ["me", ["{added} blocks placed, {removed} mined", "{added} blocks placed"]],
  ["adv", "me", "Getting an Upgrade"],
  ["b", "flex"],
  ["a", "how much did that cost?", (F) => F.cost],
  ["me", "{cost}. worth it"],
  ["join", "c"],
  ["c", "whats the seed?"],
  ["a", "its always the seed"],
  ["c", "{me} how many hearts have you got?", (F) => F.p5 != null],
  ["me", ["5h limit at {p5}%, refills in {reset5h}", "5h limit at {p5}%"]],
  ["c", "drink a potion!!", (F) => F.p5 != null && F.p5 >= 80],
  ["me", ["and the week is at {p7}%. resets in {reset7d}", "and the week is at {p7}%"]],
  ["a", "that's your XP bar right?", (F) => F.p7 != null],
  ["me", "yep. level {p7}"],
  ["b", "creeper behind you"],
  ["me", "no thats a linter warning"],
  ["c", "same thing tbh"],
  ["me", ["{agents} helpers working for me", "working alone today"]],
  ["me", "one is doing: {agent} ({agentTime})"],
  ["a", "do they need food?", (F) => F.agents > 0],
  ["me", "just tokens", (F) => F.agents > 0],
  ["me", ["tasks: {tasks}", "no task list yet"]],
  ["c", "what are you doing now?"],
  ["me", ["{task}", "just thinking"]],
  ["c", "and after that?", (F) => F.nextTask],
  ["me", "{nextTask}"],
  ["adv", "me", "Monster Hunter", (F) => F.doneTask],
  ["me", "just finished: {doneTask}"],
  ["adv", "a", "Stone Age"],
  ["b", "any errors?", (F) => F.errors != null],
  ["me", "{errors}. clean run", (F) => F.errors === 0],
  ["me", "{errors}. creepers got me", (F) => F.errors > 0],
  ["a", "respawn and try again", (F) => F.errors > 0],
  ["c", "did you push yet?", (F) => F.ahead != null],
  ["me", "{ahead} commits to push", (F) => F.ahead > 0],
  ["me", "{behind} new commits to pull first", (F) => F.behind > 0],
  ["me", "all synced", (F) => F.ahead === 0 && F.behind === 0],
  ["me", "pull request {pr} is open"],
  ["b", "ooh a trade", (F) => F.pr],
  ["c", "brb mining"],
  ["leave", "c"],
  ["b", "{me} how's the CPU?", (F) => F.cpu],
  ["me", ["{cpu} on {cores} cores. one is at {hotCore}%", "{cpu}"]],
  ["me", ["RAM {ram}%, disk {disk}%", "RAM {ram}%"]],
  ["b", "your disk is almost full", (F) => F.disk != null && F.disk >= 90],
  ["me", "{zombies} zombies outside", (F) => F.zombies > 0],
  ["a", "close the door!!", (F) => F.zombies >= 5],
  ["me", "i've been busy {busy}% of the last 30s"],
  ["me", "lean-ctx saved me {saved} tokens"],
  ["me", "llmlingua saved {lingua} more"],
  ["a", "who put lava next to the chest"],
  ["b", "not me"],
  ["me", "we've been at it for {uptime}"],
  ["b", "it's {clock}, i should sleep", (F) => F.hour != null && (F.hour >= 21 || F.hour < 6)],
  ["b", "it's {clock}, still daytime", (F) => F.hour != null && F.hour >= 6 && F.hour < 21],
  ["a", "skip the night pls", (F) => F.hour != null && (F.hour >= 21 || F.hour < 6)],
  ["me", "one more task first"],
  ["b", "you said that an hour ago"],
  ["me", "it was a big task"],
  ["leave", "b"],
  ["a", "afk, crafting a sword"],
  ["me", ["ok. back to {project}", "ok. i'll keep coding"]],
  ["leave", "a"],
];

export function castFor(modelName) {
  const me = modelName || "Claude";
  const others = FAMILY.filter((m) => m !== me).slice(0, 3);
  return { me, a: others[0], b: others[1], c: others[2] };
}

// Fill {placeholders}; null if any fact is unknown (so the option is skipped).
function fill(text, cast, F) {
  let missing = false;
  const out = text.replace(/\{(\w+)\}/g, (_, k) => {
    if (k in cast) return cast[k];
    const v = F[k];
    if (v == null || v === "") { missing = true; return ""; }
    return String(v);
  });
  return missing ? null : out;
}

// One chat message as styled parts: [{ text, role }], role = "me" | "text" | "system" |
// "adv". The renderer colours them; `me` is the selected model's name. null = skip.
function message(entry, cast, F) {
  const [kind, arg, extra] = entry;
  const when = entry.find((x) => typeof x === "function");
  if (when && !when(F)) return null;
  if (kind === "join" || kind === "leave") {
    return [{ text: `${cast[arg]} ${kind === "join" ? "joined" : "left"} the game`, role: "system" }];
  }
  if (kind === "adv") {
    return [
      { text: cast[arg], role: arg === "me" ? "me" : "text" },
      { text: " has made the advancement ", role: "text" },
      { text: `[${extra}]`, role: "adv" },
    ];
  }
  // A chat line: `kind` is the speaker, `arg` the text or a list of options.
  const options = Array.isArray(arg) ? arg : [arg];
  const text = options.map((o) => fill(o, cast, F)).find((t) => t != null);
  if (text == null) return null;
  return [
    { text: "<", role: "text" },
    { text: cast[kind], role: kind === "me" ? "me" : "text" },
    { text: "> " + text, role: "text" },
  ];
}

// Deterministic per-line "random" pause in [PAUSE_MIN, PAUSE_MAX].
function pauseFor(i) {
  let x = Math.imul(i + 1, 0x9e3779b1) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca77) >>> 0;
  return PAUSE_MIN + ((x ^ (x >>> 13)) >>> 0) % (PAUSE_MAX - PAUSE_MIN + 1);
}

const textOf = (parts) => parts.map((p) => p.text).join("");

// The chat lines currently in the loop, after dropping unknown facts and false conditions.
export function chatScript(values) {
  const F = facts(values);
  const cast = castFor(F.model);
  return SCRIPT.map((e) => message(e, cast, F)).filter(Boolean);
}

// The `rows` most recent messages at time `now` (seconds), oldest first.
export function chatLog(values, now, rows) {
  const msgs = chatScript(values);
  // When each message appears within one loop of the script.
  const at = [];
  let t = 0;
  msgs.forEach((m, i) => {
    at.push(t);
    t += textOf(m).trim().endsWith("?") ? ANSWER_DELAY : pauseFor(i);
  });
  const loop = t;
  const pos = ((now % loop) + loop) % loop;
  let idx = 0;
  while (idx + 1 < msgs.length && at[idx + 1] <= pos) idx++;
  const out = [];
  for (let i = rows - 1; i >= 0; i--) out.push(msgs[(((idx - i) % msgs.length) + msgs.length) % msgs.length]);
  return out;
}
