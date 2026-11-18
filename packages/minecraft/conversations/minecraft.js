// The Minecraft chat's conversation library: the platform's questions and answers about the session
// in a Minecraft server's words (hearts, food, blocks, creepers), with the banter of the other
// players around them, who join and leave the game as the chat goes on.
//
// A conversation library for the chat element: the bar calls conversations(facts) and plays what it
// returns after the platform's metrics library. A conversation here with a key of the metrics library
// plays in its place, in its position; the keys are listed at the top of the platform's library
// (src/kit/chat/metrics-library.js), and so are the facts and the line forms. A key of its own plays
// after all of them.
//
// The other players are three of the model family, the platform's `family` fact; the running model
// is never one of them. FAMILY stands in for a bar too old to give that fact.

var FAMILY = ["Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"];

function familyOf(F) {
  var list = Array.isArray(F.family) ? F.family.filter(function (m) { return typeof m === "string" && m !== ""; }) : [];
  return list.length ? list : FAMILY;
}

function known(x) { return x !== null && x !== undefined; }

// A line that names an advancement: "<who> has made the advancement [<name>]".
function advancement(who, name) {
  return [
    { text: "{" + who + "}", role: who === "me" ? "me" : "text" },
    { text: " has made the advancement ", role: "text" },
    { text: "[" + name + "]", role: "accent" },
  ];
}

function conversations(F) {
  var others = familyOf(F).filter(function (m) { return m !== F.model; }).slice(0, 3);
  var c = {};
  // A conversation under `key` when `when` holds: its lines, those given as null left out.
  function say(key, when) {
    if (!when) return;
    c[key] = Array.prototype.slice.call(arguments, 2).filter(function (l) { return l !== null; });
  }
  var night = known(F.hour) && (F.hour >= 21 || F.hour < 6);

  say("session.ask", F.session || F.project, "{a} joined the game", ["a", "Hey {me}!!"]);
  say("session.answer", F.session || F.project,
    ["me", ["hi! working on {session}", "hi! busy rn"]],
    ["a", "what are you building?"],
    ["me", ["{project}. it's going well", "a status bar. in a terminal"]]);
  say("branch.answer", F.branch, ["me", "{branch}"], ["a", "nice biome"]);

  say("effort.ask", F.effort, "{b} joined the game", ["b", "did someone say hotbar"], ["b", "{me} what's your effort level?"]);
  say("fast.answer", F.fast, ["me", "fast mode {fast}"], F.fast === "on" ? ["a", "zoom zoom"] : null);
  var permission = { plan: "plan mode. just looking, not touching", auto: "auto mode. no questions asked", bypass: "bypass mode. living dangerously" };
  say("permission.answer", permission[F.permission], ["me", permission[F.permission]]);
  say("advisor.answer", F.advisor, ["me", "my advisor is {advisor}"], ["a", "wise choice"]);

  say("ctx.ask", known(F.ctx), ["b", "how full is your head?"]);
  say("ctx.answer", known(F.ctx),
    ["me", ["context {ctx}% full, out of {window}", "context {ctx}% full"]],
    F.ctxLeft > 75 ? ["me", "plenty of food left"] : null);
  say("ctx.low", known(F.ctxLeft) && F.ctxLeft <= 25, ["a", "{me} eat something, you're down to {ctxLeft}% food"]);
  say("lines.answer", known(F.added),
    ["b", "anyone got diamonds?"],
    ["a", "i have 3 and a stick"],
    ["me", ["{added} blocks placed, {removed} mined", "{added} blocks placed"]],
    advancement("me", "Getting an Upgrade"),
    ["b", "flex"]);
  say("cost.ask", F.cost, ["a", "how much did that cost?"]);
  say("cost.answer", F.cost, ["me", "{cost}. worth it"]);
  say("limit5h.ask", known(F.p5),
    "{c} joined the game",
    ["c", "whats the seed?"],
    ["a", "its always the seed"],
    ["c", "{me} how many hearts have you got?"]);
  say("limit5h.answer", known(F.p5),
    ["me", ["5h limit at {p5}%, refills in {reset5h}", "5h limit at {p5}%"]],
    F.p5 >= 80 ? ["c", "drink a potion!!"] : null);
  say("limit7d.answer", known(F.p7),
    ["me", ["and the week is at {p7}%. resets in {reset7d}", "and the week is at {p7}%"]],
    ["a", "that's your XP bar right?"],
    ["me", "yep. level {p7}"],
    ["b", "creeper behind you"],
    ["me", "no thats a linter warning"],
    ["c", "same thing tbh"]);

  say("agents.answer", true, ["me", F.agents > 0 ? "{agents} helpers working for me" : "working alone today"]);
  say("agent.answer", F.agent,
    ["me", ["one is doing: {agent} ({agentTime})", "one is doing: {agent}"]],
    F.agents > 0 ? ["a", "do they need food?"] : null,
    F.agents > 0 ? ["me", "just tokens"] : null);
  say("task.ask", true, ["c", "what are you doing now?"]);
  say("next.ask", F.nextTask, ["c", "and after that?"]);
  say("done.answer", F.doneTask, advancement("me", "Monster Hunter"), ["me", "just finished: {doneTask}"]);
  say("errors.ask", known(F.errors), advancement("a", "Stone Age"), ["b", "any errors?"]);
  say("errors.answer", known(F.errors),
    ["me", F.errors > 0 ? "{errors}. creepers got me" : "{errors}. clean run"],
    F.errors > 0 ? ["a", "respawn and try again"] : null);

  say("push.ask", known(F.ahead), ["c", "did you push yet?"]);
  say("pr.answer", F.pr, ["me", "pull request {pr} is open"], ["b", "ooh a trade"]);
  say("cpu.ask", known(F.cpu), ["c", "brb mining"], "{c} left the game", ["b", "{me} how's the CPU?"]);
  say("processes.answer", F.processes > 0,
    ["me", "{processes} zombies outside"],
    F.processes >= 5 ? ["a", "close the door!!"] : null);
  say("uptime.answer", F.uptime, ["a", "who put lava next to the chest"], ["b", "not me"], ["me", "we've been at it for {uptime}"]);
  say("clock.answer", F.clock,
    ["b", night ? "it's {clock}, i should sleep" : known(F.hour) ? "it's {clock}, still daytime" : "it's {clock}"],
    night ? ["a", "skip the night pls"] : null);
  say("goodbye", true,
    ["me", "one more task first"],
    ["b", "you said that an hour ago"],
    ["me", "it was a big task"],
    "{b} left the game",
    ["a", "afk, crafting a sword"],
    ["me", ["ok. back to {project}", "ok. i'll keep coding"]],
    "{a} left the game");

  return { cast: { a: others[0], b: others[1], c: others[2] }, conversations: c };
}
