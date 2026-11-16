#!/usr/bin/env node
// The script host: skin scripts run in one persistent worker thread, called synchronously from
// the render pass. A call past its budget is stopped, a hang the vm timeout cannot reach is
// pinned on the script that was running, and a failed script stays disabled until its file
// changes. Prints the measured spawn, round-trip and per-call times.

import { TEMP_SANDBOX } from "../_temp-sandbox.mjs";
import { writeFileSync, utimesSync } from "node:fs";
import path from "node:path";
import { createScriptHost } from "../../src/platform/scripts/host.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
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
const SLOW = script(`function render() { const t = Date.now(); while (Date.now() - t < 100) {} return { slow: true }; }`);
const HANG = script(`function render() { return { never: "reached" }; }`, "hangs.js");
const PROMISE = script(`async function render() { return { frame: "late" }; }`);
const SKINNED = script(`function render() { throw new Error("fails in every skin"); }`);
const HOG = script(`var keep = []; function render() { for (;;) keep.push(new Array(1e5).fill(0.5)); }`);

const BUDGET = 20;
const GRACE = 40;

console.log(`measurements on node ${process.version}, ${process.platform}:`);
const tSpawn = process.hrtime.bigint();
const host = createScriptHost({ callBudgetMs: BUDGET, graceMs: GRACE, simulateNativeHang: HANG });
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

console.log("a script that never returns:");
{
  const spawns = host.spawns;
  const t = process.hrtime.bigint();
  const r = host.runBatch([call(FRAME), call(LOOP), call(ECHO, { width: 7 })]);
  const took = ms(t);
  console.log(`  batch with a ${BUDGET} ms loop took ${fmt(took)} ms (the vm timeout fires ${fmt(took - BUDGET)} ms late at most)`);
  ok(r[1].status === "timeout", `the looping call returns a timeout result (${r[1].status})`);
  ok(took < BUDGET + GRACE, `within its budget plus the ${GRACE} ms grace`);
  ok(host.isDisabled(LOOP), "the looping script is disabled");
  ok(r[0].status === "ok" && r[2].status === "ok" && r[2].output.width === 7, "the other calls in the batch return normally");
  ok(host.spawns === spawns, "the worker was not replaced");
  const [again] = host.runBatch([call(LOOP)]);
  ok(again.status === "disabled", "the next call does not run it");
}

console.log("a hang the vm timeout cannot reach:");
{
  const spawns = host.spawns;
  const t = process.hrtime.bigint();
  const r = host.runBatch([call(FRAME), call(HANG), call(ECHO, { width: 3 })]);
  console.log(`  backstop fired after ${fmt(ms(t))} ms`);
  ok(r[1].status === "timeout", `the hanging call returns a timeout result (${r[1].status})`);
  ok(host.isDisabled(HANG), "the script whose index was in the buffer is disabled");
  ok(!host.isDisabled(FRAME) && !host.isDisabled(ECHO), "no other script is disabled");
  ok(r[0].status === "skipped" && r[2].status === "skipped", "the other calls draw their defaults this pass");
  ok(host.spawns === spawns + 1, "the worker was replaced");
  const t2 = process.hrtime.bigint();
  const [next] = host.runBatch([call(FRAME)]);
  console.log(`  first call on the respawned worker: ${fmt(ms(t2))} ms (includes waiting for its start)`);
  ok(next.status === "ok" && next.output.frame === "STFST01", "the first call on the respawned worker succeeds");

  // A batch deadline that ends before the hang has run its budget plus the grace: the host waits
  // out the rest of that time and still pins the hang in this pass.
  writeFileSync(HANG, `function render() { return { never: "reached", again: true }; }`);
  const later = new Date(Date.now() + 5000);
  utimesSync(HANG, later, later);
  const t3 = process.hrtime.bigint();
  const [short] = host.runBatch([call(HANG)], { deadlineMs: 0 });
  console.log(`  a hang under a short deadline was pinned after ${fmt(ms(t3))} ms`);
  ok(short.status === "timeout" && host.isDisabled(HANG) && host.spawns === spawns + 2, `a hang under a short deadline is pinned in the same pass (${short.status})`);
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
  const spawns = host.spawns;
  const r = host.runBatch([call(ASYNC), call(FRAME)]);
  ok(r[0].status === "timeout", `returns a timeout result (${r[0].status}: ${r[0].message})`);
  ok(host.isDisabled(ASYNC), "it is the script disabled");
  ok(!host.isDisabled(FRAME), "the other script is not");
  const [next] = host.runBatch([call(FRAME)]);
  ok(next.status === "ok" && host.spawns === spawns, "the next batch on the same worker succeeds");
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

console.log("a script that allocates without bound:");
{
  // A small heap and a long budget, so the heap limit, not the vm timeout, stops it.
  const small = createScriptHost({ callBudgetMs: 300, graceMs: GRACE, maxHeapMb: 32 });
  const [warm] = small.runBatch([call(FRAME)]);
  ok(warm.status === "ok", "the small-heap worker starts");
  const spawns = small.spawns;
  const t = process.hrtime.bigint();
  const [r] = small.runBatch([call(HOG)]);
  console.log(`  stopped after ${fmt(ms(t))} ms`);
  ok(r.status === "timeout" && small.isDisabled(HOG), `is stopped and disabled (${r.status}: ${r.message})`);
  ok(small.spawns === spawns + 1, "the worker hit its heap limit and was replaced; the host process lives on");
  const [next] = small.runBatch([call(FRAME)]);
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
  // A 100 ms script well inside a 300 ms budget, so a coarse system timer cannot let it finish
  // before a 2 ms deadline gives up on it.
  const roomy = createScriptHost({ callBudgetMs: 300, graceMs: GRACE });
  const [warm] = roomy.runBatch([call(FRAME)]);
  ok(warm.status === "ok", "the worker starts");
  const spawns = roomy.spawns;
  const r = roomy.runBatch([call(SLOW)], { deadlineMs: 2, graceMs: 0 });
  ok(r[0].status === "skipped", `the element draws its default this pass (${r[0].status})`);
  ok(!roomy.isDisabled(SLOW), "the script is not disabled");
  ok(roomy.spawns === spawns, "the worker is not replaced");
  const [next] = roomy.runBatch([call(SLOW)]);
  ok(next.status === "ok" && next.output.slow === true, `the next full batch runs it (${next.status})`);
  roomy.close();
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
