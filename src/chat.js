// The hotbar theme's chat: a Minecraft-style chat log on the left of the screen.
//
// It costs no tokens. It's a long pre-written script that loops forever, a new message
// every few seconds (sooner when someone asked a question), picked by the clock. The model you're running is always one of the
// speakers ("me"); the others are filled in from the rest of the model family. A few lines
// pull in live session values (tasks, cost, lines added…), and a line whose value isn't
// available right now is simply left out of the loop.

// Timing feels like people typing: an answer to a question comes quickly, anything else
// after a varied pause. The pauses are fixed per line (not truly random), so every render
// in the same second shows the same chat.
const ANSWER_DELAY = 2;            // seconds after a message ending in "?"
const PAUSE_MIN = 3, PAUSE_MAX = 10; // seconds before any other message

// The model family the other speakers are drawn from. If you're running one of them, it's
// you; otherwise the first three play the other parts.
const FAMILY = ["Fable 5.1", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"];

// Speakers: "me" = the selected model, "a" / "b" / "c" = the other three.
//   ["me", "text"]        <Opus 5.5> text
//   ["join", "a"]         Sonnet 5.5 joined the game
//   ["leave", "b"]        Haiku 5.5 left the game
//   ["adv", "me", "Name"] Opus 5.5 has made the advancement [Name]
// {tasks} {cost} {added} {agents} {errors} {branch} {cpu} {clock} are live values.
const SCRIPT = [
  ["join", "a"],
  ["a", "Hey {me}!!"],
  ["me", "hi! busy rn"],
  ["a", "what are you building?"],
  ["me", "a status bar. in a terminal"],
  ["a", "with hearts??"],
  ["me", "and hunger. and a hotbar"],
  ["join", "b"],
  ["b", "did someone say hotbar"],
  ["me", "tasks so far: {tasks}"],
  ["b", "gg"],
  ["a", "how much did that cost?"],
  ["me", "{cost}. worth it"],
  ["b", "anyone got diamonds?"],
  ["a", "i have 3 and a stick"],
  ["me", "{added} blocks placed today"],
  ["adv", "me", "Getting an Upgrade"],
  ["b", "flex"],
  ["join", "c"],
  ["c", "whats the seed?"],
  ["a", "its always the seed"],
  ["me", "i'm on branch {branch}"],
  ["c", "nice biome"],
  ["b", "creeper behind you"],
  ["me", "no thats a linter warning"],
  ["c", "same thing tbh"],
  ["me", "{agents} helpers working for me"],
  ["a", "do they need food?"],
  ["me", "just tokens"],
  ["adv", "a", "Stone Age"],
  ["c", "brb mining"],
  ["leave", "c"],
  ["b", "{me} how's the CPU?"],
  ["me", "{cpu}. it's fine. probably"],
  ["a", "who put lava next to the chest"],
  ["b", "not me"],
  ["me", "errors so far: {errors}"],
  ["a", "respawn and try again"],
  ["adv", "me", "Monster Hunter"],
  ["b", "it's {clock}, i should sleep"],
  ["a", "skip the night pls"],
  ["me", "one more task first"],
  ["b", "you said that an hour ago"],
  ["me", "it was a big task"],
  ["leave", "b"],
  ["a", "afk, crafting a sword"],
  ["me", "ok. i'll keep coding"],
  ["leave", "a"],
];

// Plain (no ANSI / hyperlink) string of a metric value, or null when absent.
const ESC_RE = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g;
const plain = (v) => (v == null ? null : String(v).replace(ESC_RE, ""));

const LIVE = {
  tasks: "act.tasks", cost: "cost.total", added: "loc.added", agents: "act.agents",
  errors: "act.errors", branch: "git.branch", cpu: "sys.cpu", clock: "sys.clock",
};

export function castFor(modelName) {
  const me = modelName || "Claude";
  const others = FAMILY.filter((m) => m !== me).slice(0, 3);
  return { me, a: others[0], b: others[1], c: others[2] };
}

// Fill {placeholders}; null if a live value is missing (the line is skipped).
function fill(text, cast, values) {
  let missing = false;
  const out = text.replace(/\{(\w+)\}/g, (_, k) => {
    if (k in cast) return cast[k];
    const v = plain(values[LIVE[k]]);
    if (v == null || v === "") { missing = true; return ""; }
    return v;
  });
  return missing ? null : out;
}

// One chat message as styled parts: [{ text, role }], role = "name" | "me" | "text" |
// "system" | "adv". The renderer colours them; `me` is the selected model's name.
function message(entry, cast, values) {
  const [kind, who, extra] = entry;
  if (kind === "join" || kind === "leave") {
    return [{ text: `${cast[who]} ${kind === "join" ? "joined" : "left"} the game`, role: "system" }];
  }
  if (kind === "adv") {
    return [
      { text: cast[who], role: who === "me" ? "me" : "text" },
      { text: " has made the advancement ", role: "text" },
      { text: `[${extra}]`, role: "adv" },
    ];
  }
  const text = fill(who, cast, values);
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

// The `rows` most recent messages at time `now` (seconds), oldest first.
export function chatLog(values, now, rows) {
  const cast = castFor(plain(values["model.name"]));
  const msgs = SCRIPT.map((e) => message(e, cast, values)).filter(Boolean);
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
