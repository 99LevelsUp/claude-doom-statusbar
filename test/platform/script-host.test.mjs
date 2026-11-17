#!/usr/bin/env node
// The script host: skin scripts run in one persistent worker thread, called synchronously from
// the render pass. A call past its budget is stopped, a hang the vm timeout cannot reach is
// pinned on the script that was running. A script that fails stays disabled until its file
// changes; one that runs past its budget only for a cooldown that doubles while it keeps doing
// so. Prints the measured spawn, round-trip and per-call times.

import { TEMP_SANDBOX } from "../_temp-sandbox.mjs";
import { writeFileSync, utimesSync } from "node:fs";
import path from "node:path";
import { createScriptHost } from "../../src/platform/scripts/host.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fmt = (n) => n.toFixed(2);

let n = 0;
function script(source, name = `s${++n}.js`) {
  const p = path.join(TEMP_SANDBOX, name);
  writeFileSync(p, source);
  return p;
}
const call = (s, input = {}) => ({ script: s, input });

const FRAME = script(`function render(input) { return { frame: "STFST01" }; }`);
const ECHO = script(`function render(input) { return { width: input.width }; }`);
const LOOP = script(`function render() { for (;;) {} }`);
const THROWS = script(`function render() { throw new Error("broken on purpose"); }`);
const TIMER = script(`function render() { setTimeout(() => {}, 0); return {}; }`);
const EVAL = script(`function render() { return eval("1 + 1"); }`);
const REQUIRE = script(`function render() { return require("node:fs").readdirSync("."); }`);
const ASYNC = script(`async function render() { for (;;) await 0; }`);
const ESM = script(`export default function render() { return {}; }`, "module-style.js");
const SLOW = script(`function render(input) { const t = Date.now(); while (Date.now() - t < input.ms) {} return { slow: true }; }`);
const HANG = script(`function render() { return { never: "reached" }; }`, "hangs.js");
const PROMISE = script(`async function render() { return { frame: "late" }; }`);
const SKINNED = script(`function render() { throw new Error("fails in every skin"); }`);
const HOG = script(`var keep = []; function render() { for (;;) keep.push(new Array(1e5).fill(0.5)); }`);

// The product's budget and grace, for the checks that time a batch against them.
const BUDGET = 20;
const GRACE = 40;
// Every other check must not depend on how fast the machine is. On a loaded machine a call that
// loads its file (read, compile, new context) can take seconds and a worker seconds to start;
// one such call past its budget turns its script off for the 30 s cooldown and the checks after
// it fail with it. So the scripts that return run on a host whose budget and grace no machine
// runs a trivial call past.
const LONG = 10000;
const STARTUP = 30000;
// A loop or a hang costs its host's budget (plus the grace for a hang) every time it runs, so
// those run on hosts with a short budget, a grace that lets the vm timeout, not the backstop,
// stop a loop that fires late, and a long batch deadline wherever a script has to load or a
// loop has to be stopped: the deadline is what the backstop is measured from, and loading a
// file is outside the vm timeout.
const SHORT = 250;
const SHORT_GRACE = 1000;
const SLACK = { deadlineMs: 30000 };

console.log(`measurements on node ${process.version}, ${process.platform}:`);
const tSpawn = process.hrtime.bigint();
const host = createScriptHost({ callBudgetMs: LONG, graceMs: LONG, startupMs: STARTUP });
host.runBatch([call(FRAME)]);
console.log(`  spawn and first call: ${fmt(ms(tSpawn))} ms`);
{
  const rounds = [];
  for (let i = 0; i < 20; i++) { const t = process.hrtime.bigint(); host.runBatch([call(FRAME)]); rounds.push(ms(t)); }
  rounds.sort((a, b) => a - b);
  console.log(`  one-call round trip: median ${fmt(rounds[10])} ms, max ${fmt(rounds[19])} ms`);
}

console.log("a script within budget:");
{
  const [r] = host.runBatch([call(FRAME)]);
  ok(r.status === "ok" && r.output && r.output.frame === "STFST01", `returns its output (${JSON.stringify(r)})`);
  const [e] = host.runBatch([call(ECHO, { width: 42 })]);
  ok(e.status === "ok" && e.output.width === 42, "receives its input");
}

// A host for the scripts that must be stopped, with the ones that return already loaded.
function stopHost(options = {}) {
  const h = createScriptHost({ callBudgetMs: SHORT, graceMs: SHORT_GRACE, startupMs: STARTUP, ...options });
  const warm = h.runBatch([call(FRAME), call(ECHO, { width: 1 })], SLACK);
  ok(warm.every((r) => r.status === "ok"), "the worker starts");
  return h;
}

console.log("a script that never returns:");
const stops = stopHost();
{
  const spawns = stops.spawns;
  const r = stops.runBatch([call(FRAME), call(LOOP), call(ECHO, { width: 7 })], SLACK);
  ok(r[1].status === "timeout", `the looping call returns a timeout result (${r[1].status})`);
  ok(stops.isDisabled(LOOP), "the looping script is disabled");
  ok(r[0].status === "ok" && r[2].status === "ok" && r[2].output.width === 7, "the other calls in the batch return normally");
  ok(stops.spawns === spawns, "the worker was not replaced");
  const [again] = stops.runBatch([call(LOOP)]);
  ok(again.status === "disabled", "the next call does not run it");
}
{
  // Timed at the product's budget, on its own host warmed up first, so the worker's start and
  // the first compile are not in the measurement.
  const tight = createScriptHost({ callBudgetMs: BUDGET, graceMs: GRACE, startupMs: STARTUP });
  tight.runBatch([call(FRAME), call(ECHO, { width: 1 })], SLACK);
  const t = process.hrtime.bigint();
  tight.runBatch([call(FRAME), call(LOOP), call(ECHO, { width: 7 })]);
  const took = ms(t);
  console.log(`  batch with a ${BUDGET} ms loop took ${fmt(took)} ms (the vm timeout fires ${fmt(took - BUDGET)} ms late at most)`);
  // What the render pass relies on is the host's own promise, not the vm timer's precision: a
  // batch waits for its deadline (the call budget per call) plus the grace, and a call already
  // past its budget then gets at most its budget plus the grace more.
  const deadline = BUDGET * 3;
  ok(took < deadline + GRACE + BUDGET + GRACE, `the batch returns within its ${deadline} ms deadline, the ${GRACE} ms grace and one overdue call's budget plus grace (${fmt(took)} ms)`);
  tight.close();
}

console.log("a hang the vm timeout cannot reach:");
{
  const hung = stopHost({ simulateNativeHang: HANG });
  const spawns = hung.spawns;
  const t = process.hrtime.bigint();
  const r = hung.runBatch([call(FRAME), call(HANG), call(ECHO, { width: 3 })]);
  console.log(`  backstop fired after ${fmt(ms(t))} ms`);
  ok(r[1].status === "timeout", `the hanging call returns a timeout result (${r[1].status})`);
  ok(hung.isDisabled(HANG), "the script whose index was in the buffer is disabled");
  ok(r[1].retryMs === 30000 && /stopped/.test(r[1].message), `for 30 s, as for any timeout (${r[1].retryMs}: ${r[1].message})`);
  ok(!hung.isDisabled(FRAME) && !hung.isDisabled(ECHO), "no other script is disabled");
  ok(r[0].status === "skipped" && r[2].status === "skipped", "the other calls draw their defaults this pass");
  ok(hung.spawns === spawns + 1, "the worker was replaced");
  const t2 = process.hrtime.bigint();
  const [next] = hung.runBatch([call(FRAME)], SLACK);
  console.log(`  first call on the respawned worker: ${fmt(ms(t2))} ms (includes waiting for its start)`);
  ok(next.status === "ok" && next.output.frame === "STFST01", "the first call on the respawned worker succeeds");

  // A batch deadline that ends before the hang has run its budget plus the grace: the host waits
  // out the rest of that time and still pins the hang in this pass.
  writeFileSync(HANG, `function render() { return { never: "reached", again: true }; }`);
  const later = new Date(Date.now() + 5000);
  utimesSync(HANG, later, later);
  const t3 = process.hrtime.bigint();
  const [short] = hung.runBatch([call(HANG)], { deadlineMs: 0 });
  console.log(`  a hang under a short deadline was pinned after ${fmt(ms(t3))} ms`);
  ok(short.status === "timeout" && hung.isDisabled(HANG) && hung.spawns === spawns + 2, `a hang under a short deadline is pinned in the same pass (${short.status})`);
  hung.close();
}

console.log("a script that throws:");
{
  const r = host.runBatch([call(THROWS), call(FRAME)]);
  ok(r[0].status === "error" && r[0].message.includes(path.basename(THROWS)), `an error result names the script (${r[0].message})`);
  ok(r[0].message.includes("broken on purpose"), "and carries the error");
  ok(host.isDisabled(THROWS), "the script is disabled");
  ok(r[1].status === "ok", "another script in the batch still returns");
}

console.log("a disabled script whose file changes:");
{
  const [before] = host.runBatch([call(THROWS)]);
  ok(before.status === "disabled", "stays disabled while the file is unchanged");
  writeFileSync(THROWS, `function render() { return { fixed: true }; }`);
  const later = new Date(Date.now() + 5000);
  utimesSync(THROWS, later, later);
  const [after] = host.runBatch([call(THROWS)]);
  ok(after.status === "ok" && after.output.fixed === true, `runs again after the file is rewritten (${JSON.stringify(after)})`);
  ok(!host.isDisabled(THROWS), "and is no longer disabled");
}

console.log("setTimeout, eval and require are not available:");
{
  const spawns = host.spawns;
  const r = host.runBatch([call(TIMER), call(EVAL), call(REQUIRE), call(FRAME)]);
  for (const [i, s] of [[0, TIMER], [1, EVAL], [2, REQUIRE]]) {
    ok(r[i].status === "error" && r[i].message.includes(path.basename(s)), `${path.basename(s)}: error result (${r[i].message})`);
  }
  ok(r[3].status === "ok", "the rest of the batch returns");
  ok(host.spawns === spawns, "nothing escaped the batch: the worker is the same");
}

console.log("an async script that loops on microtasks:");
{
  const spawns = stops.spawns;
  const r = stops.runBatch([call(ASYNC), call(FRAME)], SLACK);
  ok(r[0].status === "timeout", `returns a timeout result (${r[0].status}: ${r[0].message})`);
  ok(stops.isDisabled(ASYNC), "it is the script disabled");
  ok(!stops.isDisabled(FRAME), "the other script is not");
  const [next] = stops.runBatch([call(FRAME)], SLACK);
  ok(next.status === "ok" && stops.spawns === spawns, "the next batch on the same worker succeeds");
  stops.close();
}

console.log("a script returning a promise:");
{
  const [r] = host.runBatch([call(PROMISE)]);
  ok(r.status === "error" && r.message.includes("promise"), `is an error result (${r.message})`);
  ok(host.isDisabled(PROMISE), "and is disabled");
}

console.log("a failed script is disabled per skin:");
{
  const [a] = host.runBatch([{ script: SKINNED, skin: "doom-full", input: {} }]);
  ok(a.status === "error" && host.isDisabled(SKINNED, "doom-full"), "fails and is disabled for its skin");
  const [again] = host.runBatch([{ script: SKINNED, skin: "doom-full", input: {} }]);
  ok(again.status === "disabled", "stays disabled for that skin");
  const [b] = host.runBatch([{ script: SKINNED, skin: "my-skin", input: {} }]);
  ok(b.status === "error", `runs again when the skin changes (${b.status})`);
}

console.log("a script that runs past its budget is off for a while, then retried:");
{
  // The host's clock is the test's, so a cooldown passes without waiting for it. These checks
  // need the plain call to return and the loop to time out, not to be timed: a budget a loaded
  // machine does not run a trivial call past, and a grace that lets the vm timeout, not the
  // backstop, stop the loop.
  let clock = 1000;
  const cool = createScriptHost({ callBudgetMs: 250, graceMs: 5000, startupMs: 10000, now: () => clock });
  const FLAKY = script(`function render(input) { if (input.loop) for (;;) {} return { ran: true }; }`);
  const loops = call(FLAKY, { loop: true });
  const returns = call(FLAKY, {});
  const SECOND = 1000, MINUTE = 60 * SECOND;

  const [first] = cool.runBatch([loops]);
  ok(first.status === "timeout" && first.retryMs === 30 * SECOND, `a timeout turns it off for 30 s (${first.status}, ${first.retryMs})`);
  ok(/stopped/.test(first.message), `the result says it was stopped (${first.message})`);
  ok(cool.isDisabled(FLAKY), "it is off");
  clock += 30 * SECOND - 1;
  const [cooling] = cool.runBatch([returns]);
  ok(cooling.status === "disabled" && !cooling.output, `while it cools down it is not called, even with an input it would return for (${cooling.status})`);
  clock += 1;
  ok(!cool.isDisabled(FLAKY), "after 30 s it is no longer off");
  const [back] = cool.runBatch([returns]);
  ok(back.status === "ok" && back.output.ran === true, `and it runs again (${JSON.stringify(back)})`);

  // It keeps timing out: each time the cooldown doubles, up to 10 minutes.
  const want = [30 * SECOND, MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE, 10 * MINUTE, 10 * MINUTE];
  const got = [];
  let heldOff = true;
  for (const _ of want) {
    const [r] = cool.runBatch([loops]);
    got.push(r.retryMs);
    clock += r.retryMs - 1;
    if (cool.runBatch([returns])[0].status !== "disabled") heldOff = false;
    clock += 1;
  }
  ok(same(got, want), `the cooldown doubles and stops at 10 min (${got.map((x) => x / SECOND).join(", ")} s)`);
  ok(heldOff, "and the script is not called before each cooldown ends");

  // A call that completes resets the backoff.
  const [fine] = cool.runBatch([returns]);
  const [again] = cool.runBatch([loops]);
  ok(fine.status === "ok" && again.status === "timeout" && again.retryMs === 30 * SECOND,
    `a call that completes starts the cooldown at 30 s again (${again.retryMs})`);

  // A file change ends the cooldown at once.
  writeFileSync(FLAKY, `function render(input) { return { ran: "rewritten" }; }`);
  const later = new Date(Date.now() + 5000);
  utimesSync(FLAKY, later, later);
  const [rewritten] = cool.runBatch([returns]);
  ok(rewritten.status === "ok" && rewritten.output.ran === "rewritten", `a file change ends the cooldown at once (${rewritten.status})`);

  // An error is not a timeout: it stays off until the file changes, however long it waits.
  const BREAKS = script(`function render() { throw new Error("broken for good"); }`);
  const [broken] = cool.runBatch([call(BREAKS)]);
  clock += 60 * MINUTE;
  const [still] = cool.runBatch([call(BREAKS)]);
  ok(broken.status === "error" && still.status === "disabled" && cool.isDisabled(BREAKS),
    `a script that throws stays off after an hour (${broken.status}, ${still.status})`);
  writeFileSync(BREAKS, `function render() { return { fixed: true }; }`);
  utimesSync(BREAKS, later, later);
  const [fixed] = cool.runBatch([call(BREAKS)]);
  ok(fixed.status === "ok" && fixed.output.fixed === true, `and runs once its file changes (${fixed.status})`);
  cool.close();
}

console.log("a script that allocates without bound:");
{
  // A small heap and a long budget, so the heap limit, not the vm timeout, stops it.
  const small = createScriptHost({ callBudgetMs: 300, graceMs: GRACE, startupMs: STARTUP, maxHeapMb: 32 });
  const [warm] = small.runBatch([call(FRAME)], SLACK);
  ok(warm.status === "ok", "the small-heap worker starts");
  const spawns = small.spawns;
  const t = process.hrtime.bigint();
  const [r] = small.runBatch([call(HOG)]);
  console.log(`  stopped after ${fmt(ms(t))} ms`);
  ok(r.status === "timeout" && small.isDisabled(HOG), `is stopped and disabled (${r.status}: ${r.message})`);
  ok(small.spawns === spawns + 1, "the worker hit its heap limit and was replaced; the host process lives on");
  const [next] = small.runBatch([call(FRAME)], SLACK);
  ok(next.status === "ok", "the next call succeeds");
  small.close();
}

console.log("a script using export:");
{
  const [r] = host.runBatch([call(ESM)]);
  ok(r.status === "error" && r.message.includes("module-style.js"), `loading returns an error naming the file (${r.message})`);
}

console.log("a batch cut short by the pass, not by the script:");
{
  // A 1.5 s script well inside its budget, under a 500 ms deadline: long enough for a loaded
  // worker to have picked the batch up (a worker that has not started any call of it by the
  // deadline counts as stuck and is replaced), too short for the script to have finished.
  const roomy = createScriptHost({ callBudgetMs: LONG, graceMs: GRACE, startupMs: STARTUP });
  const [warm] = roomy.runBatch([call(FRAME)], SLACK);
  ok(warm.status === "ok", "the worker starts");
  const spawns = roomy.spawns;
  const r = roomy.runBatch([call(SLOW, { ms: 1500 })], { deadlineMs: 500, graceMs: 0 });
  ok(r[0].status === "skipped", `the element draws its default this pass (${r[0].status})`);
  ok(!roomy.isDisabled(SLOW), "the script is not disabled");
  ok(roomy.spawns === spawns, "the worker is not replaced");
  const [next] = roomy.runBatch([call(SLOW, { ms: 1 })]);
  ok(next.status === "ok" && next.output.slow === true, `the next full batch runs it (${next.status})`);
  roomy.close();
}

console.log("a script returning a value that is not JSON:");
{
  // JSON.stringify turns a function, a Symbol, or an object whose toJSON returns nothing into no
  // text at all: the script failed, as if it had thrown, and the rest of the batch is unharmed.
  const kinds = [
    ["a function", script(`function render() { return function () {}; }`, "returns-function.js")],
    ["a Symbol", script(`function render() { return Symbol("x"); }`, "returns-symbol.js")],
    ["an object whose toJSON returns nothing", script(`function render() { return { toJSON: function () {} }; }`, "returns-nothing.js")],
  ];
  for (const [what, s] of kinds) {
    let r = null, threw = null;
    try { r = host.runBatch([call(s), call(FRAME)]); } catch (e) { threw = e; }
    ok(!threw, `${what}: the batch does not throw${threw ? ` (${threw.message})` : ""}`);
    ok(r && r[0].status === "error" && r[0].message.includes(path.basename(s)) && /not JSON/.test(r[0].message),
      `${what}: an error result naming the script and saying it is not JSON (${r && JSON.stringify(r[0])})`);
    ok(host.isDisabled(s), `${what}: the script is disabled until its file changes`);
    ok(r && r[1].status === "ok" && r[1].output.frame === "STFST01", `${what}: the other call in the batch returns`);
  }
}

console.log("a batch of 20 trivial calls:");
{
  host.runBatch(Array.from({ length: 20 }, () => call(ECHO, { width: 1 })));
  const t = process.hrtime.bigint();
  const r = host.runBatch(Array.from({ length: 20 }, (_, i) => call(ECHO, { width: i })));
  const took = ms(t);
  console.log(`  20 calls: ${fmt(took)} ms, ${fmt(took / 20)} ms per call`);
  ok(r.every((x, i) => x.status === "ok" && x.output.width === i), "every call returns its own output");
  ok(took < 200, "below the 200 ms pass budget");
}

host.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
