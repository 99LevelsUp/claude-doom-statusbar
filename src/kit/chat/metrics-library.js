// The platform's conversation library: questions and answers about the session's metrics. Every
// chat plays it (src/kit/elements/chat.js), in the one-shot status line too; a skin's own libraries
// are scripts that replace, drop or add to its conversations by key.
//
// A conversation library is a function of the session's facts that returns the conversations that
// apply right now, and the cast that speaks them:
//   { cast: { <role>: <name> }, conversations: { <key>: [<line>, ...] } }
// A script library defines `conversations(facts)` with the same result; this one is platform code.
//
// A line is one of:
//   [role, text]               a message, drawn "<name> text"; role "me" is the running model, any
//                              other role is a name from the cast (or the role itself when the
//                              cast does not name it)
//   [role, [text, backup...]]  the first text whose {placeholders} are all known
//   "text"                     a plain line, drawn in the chat's system colour
//   [{ text, role }, ...]      parts in their own colours: role "text", "me", "system" or "accent"
// Text may name any fact below and any cast role in braces ({ctx}, {me}, {a}); a line with a fact
// that is not known is left out.
//
// The keys of this library, which a skin drops or replaces by name. A key ending in .ask is a
// question, .answer its reply; the others are said without being asked:
//   session.ask session.answer   what the session works on      branch.ask branch.answer
//   changes.answer               changed files                  effort.ask effort.answer
//   fast.ask fast.answer         permission.answer              style.ask style.answer
//   advisor.answer               ctx.ask ctx.answer ctx.low     lines.answer
//   cost.ask cost.answer         limit5h.ask limit5h.answer     limit7d.answer
//   headroom.answer              agents.answer agent.answer     tasks.answer
//   task.ask task.answer         next.ask next.answer           done.answer
//   errors.ask errors.answer     push.ask push.ahead push.behind push.synced
//   pr.answer                    cpu.ask cpu.answer             ram.answer disk.full
//   processes.answer             busy.answer                    saved.answer lingua.answer
//   uptime.answer                clock.answer

// Who asks. The running model answers as "me".
const CAST = { a: "Ada", b: "Ben" };

const textOf = (v) => {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) v = v.text;
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const numOf = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pctOf = (v) => (numOf(v) === null ? null : Math.round(v));
const listOf = (v) => (Array.isArray(v) ? v : []);
const flag = (pairs, name) => {
  const hit = listOf(pairs).find((p) => Array.isArray(p) && p[0] === name);
  return hit ? textOf(hit[1]) : null;
};
// Claude Code's permission modes, by the word the chat says.
const PERMISSION = { plan: "plan", auto: "auto", acceptEdits: "auto", bypassPermissions: "bypass" };

// Every fact the chat can say, from the session's raw metric values (src/metrics/catalogue.js):
// strings and numbers, null when unknown. They travel as JSON to a script library.
export function facts(values = {}) {
  const v = values || {};
  const F = {};
  F.model = textOf(v["model.name"]);
  F.effort = textOf(v["model.effort"]);
  F.window = textOf(v["model.window"]);
  F.thinking = flag(v["model.mode"], "thinking");
  F.fast = flag(v["model.mode"], "fast");
  F.permission = PERMISSION[textOf(v["model.permission"])] ?? textOf(v["model.permission"]);
  F.style = textOf(v["model.style"]);
  F.advisor = textOf(v["advisor.model"]);

  F.ctx = pctOf(v["context.hp"]);
  F.ctxLeft = F.ctx === null ? null : 100 - F.ctx;
  F.p5 = pctOf(v["ratelimit.5h"]);
  F.p5Left = F.p5 === null ? null : 100 - F.p5;
  F.reset5h = textOf(v["usage.reset5h"]);
  F.p7 = pctOf(v["ratelimit.7d"]);
  F.reset7d = textOf(v["usage.reset7d"]);
  F.headroom = pctOf(v["health.headroom"]);
  F.cost = textOf(v["cost.total"]);

  F.session = textOf(v["session.title"]);
  F.project = textOf(v["loc.cwd"]);
  F.branch = textOf(v["git.branch"]);
  F.changed = numOf(v["git.status"]);
  F.behind = numOf(v["git.behind"]);
  F.ahead = numOf(v["git.ahead"]);
  F.added = numOf(v["loc.added"]);
  const removed = /-(\d+)/.exec(textOf(v["loc.churn"]) || "");
  F.removed = removed ? Number(removed[1]) : null;
  F.pr = textOf(v["pr.state"]);

  const geiger = listOf(v["act.geiger"]).filter((x) => numOf(x) !== null);
  F.busy = geiger.length ? Math.round((geiger.reduce((a, x) => a + x, 0) / geiger.length) * 100) : null;
  F.agents = numOf(v["act.agents"]);
  const squad = listOf(v["act.subagents"]).filter(Array.isArray);
  F.agent = squad.length ? textOf(squad[0][0]) : null;
  F.agentTime = squad.length ? textOf(squad[0][1]) : null;
  F.tasks = textOf(v["act.tasks"]);
  const tasks = listOf(v["act.tasklist"]).filter((t) => t && typeof t === "object");
  F.task = textOf(tasks.find((t) => t.status === "in_progress")?.text);
  F.nextTask = textOf(tasks.find((t) => t.status === "pending")?.text);
  F.doneTask = textOf(tasks.filter((t) => t.status === "completed").pop()?.text);
  F.errors = numOf(v["act.errors"]);

  F.saved = textOf(v["save.leanctx"]);
  F.lingua = textOf(v["save.lingua"]);

  F.cpu = pctOf(v["sys.cpu"]);
  const cores = listOf(v["sys.cores"]).filter((x) => numOf(x) !== null);
  F.cores = cores.length || null;
  F.hotCore = cores.length ? Math.round(Math.max(...cores) * 100) : null;
  F.ram = pctOf(v["sys.ram"]);
  F.disk = pctOf(v["sys.disk"]);
  F.processes = numOf(v["sys.zombies"]);
  F.uptime = textOf(v["sys.session"]);
  F.clock = textOf(v["sys.clock"]);
  const hour = /^(\d{1,2}):/.exec(F.clock || "");
  F.hour = hour ? Number(hour[1]) : null;
  return F;
}

// The conversations that apply to the facts `F`, in the order they play.
export function conversations(F) {
  const c = {};
  const say = (key, when, ...lines) => { if (when) c[key] = lines; };
  const known = (x) => x !== null && x !== undefined;

  say("session.ask", F.session || F.project, ["a", "hey {me}, what are you working on?"]);
  say("session.answer", F.session || F.project, ["me", ["{session}, in {project}", "{session}", "{project}"]]);
  say("branch.ask", F.branch, ["a", "which branch?"]);
  say("branch.answer", F.branch, ["me", "{branch}"]);
  say("changes.answer", known(F.changed), ["me", F.changed > 0 ? "{changed} files changed so far" : "no changes yet. just looking around"]);

  say("effort.ask", F.effort, ["b", "{me}, what's your effort level?"]);
  say("effort.answer", F.effort, ["me", ["{effort}. thinking is {thinking}", "{effort}"]]);
  say("fast.ask", F.fast, ["b", "fast mode?"]);
  say("fast.answer", F.fast, ["me", "fast mode {fast}"]);
  const permission = { plan: "plan mode. just looking, not touching", auto: "auto mode. no questions asked", bypass: "bypass mode. no permission checks" };
  say("permission.answer", permission[F.permission], ["me", permission[F.permission]]);
  say("style.ask", F.style && F.style !== "default", ["b", "what output style?"]);
  say("style.answer", F.style && F.style !== "default", ["me", "{style}"]);
  say("advisor.answer", F.advisor, ["me", "my advisor is {advisor}"]);

  say("ctx.ask", known(F.ctx), ["b", "how full is your context?"]);
  say("ctx.answer", known(F.ctx), ["me", ["context {ctx}% full, out of {window}", "context {ctx}% full"]]);
  say("ctx.low", known(F.ctxLeft) && F.ctxLeft <= 25, ["a", "{me}, only {ctxLeft}% of your context is left"]);
  say("lines.answer", known(F.added), ["me", ["{added} lines added, {removed} removed", "{added} lines added"]]);
  say("cost.ask", F.cost, ["a", "how much has it cost?"]);
  say("cost.answer", F.cost, ["me", "{cost} so far"]);
  say("limit5h.ask", known(F.p5), ["b", "{me}, how close are you to your limits?"]);
  say("limit5h.answer", known(F.p5), ["me", ["5h limit at {p5}%, resets in {reset5h}", "5h limit at {p5}%"]]);
  say("limit7d.answer", known(F.p7), ["me", ["and the week is at {p7}%, resets in {reset7d}", "and the week is at {p7}%"]]);
  say("headroom.answer", known(F.headroom), ["me", "{headroom}% of my usage headroom left"]);

  say("agents.answer", true, ["me", F.agents > 0 ? "{agents} subagents working for me" : "working alone today"]);
  say("agent.answer", F.agent, ["me", ["one is doing: {agent} ({agentTime})", "one is doing: {agent}"]]);
  say("tasks.answer", true, ["me", ["tasks: {tasks}", "no task list yet"]]);
  say("task.ask", true, ["a", "what are you doing now?"]);
  say("task.answer", true, ["me", ["{task}", "just thinking"]]);
  say("next.ask", F.nextTask, ["a", "and after that?"]);
  say("next.answer", F.nextTask, ["me", "{nextTask}"]);
  say("done.answer", F.doneTask, ["me", "just finished: {doneTask}"]);
  say("errors.ask", known(F.errors), ["b", "any errors?"]);
  say("errors.answer", known(F.errors), ["me", F.errors > 0 ? "{errors} failed tool calls so far" : "no failed tool calls"]);

  say("push.ask", known(F.ahead), ["a", "did you push yet?"]);
  say("push.ahead", F.ahead > 0, ["me", "{ahead} commits to push"]);
  say("push.behind", F.behind > 0, ["me", "{behind} new commits to pull first"]);
  say("push.synced", known(F.ahead) && F.ahead === 0 && !(F.behind > 0), ["me", "all synced"]);
  say("pr.answer", F.pr, ["me", "pull request {pr} is open"]);

  say("cpu.ask", known(F.cpu), ["b", "{me}, how's the CPU?"]);
  say("cpu.answer", known(F.cpu), ["me", ["{cpu}% on {cores} cores. one is at {hotCore}%", "{cpu}%"]]);
  say("ram.answer", known(F.ram), ["me", ["RAM {ram}%, disk {disk}%", "RAM {ram}%"]]);
  say("disk.full", known(F.disk) && F.disk >= 90, ["b", "your disk is almost full"]);
  say("processes.answer", F.processes > 0, ["me", "{processes} bash processes still running"]);
  say("busy.answer", known(F.busy), ["me", "i've been busy {busy}% of the last 30s"]);
  say("saved.answer", F.saved, ["me", "lean-ctx saved me {saved} tokens"]);
  say("lingua.answer", F.lingua, ["me", "llmlingua saved {lingua} more"]);
  say("uptime.answer", F.uptime, ["me", "we've been at it for {uptime}"]);
  say("clock.answer", F.clock, ["b", "it's {clock}"]);
  return { cast: { ...CAST }, conversations: c };
}
