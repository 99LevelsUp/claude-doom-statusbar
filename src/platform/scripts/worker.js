// The script worker: runs skin scripts for the render daemon, one batch at a time.
//
// The daemon's render pass posts a batch and blocks on the shared buffer until this worker marks
// the batch done (see host.js for the layout). Each script file is a classic script loaded once
// into its own vm context, without timers, `require`, `eval` or wasm, and every call runs through
// `runInContext` with the script's timeout, so a synchronous loop and a queued microtask loop are
// both stopped. Before each call the worker writes the batch, the call's index and its start time
// into the shared buffer, so a hang the timeout cannot reach is pinned on the right script.
import { workerData } from "node:worker_threads";
import { statSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { SLOT, startTimes } from "./layout.js";

const { buffer, port, simulateNativeHang } = workerData;
const i32 = new Int32Array(buffer);
const start = startTimes(buffer);

// The call itself, run inside the script's context under the timeout: the script's function,
// the promise check and the serialisation all run there, so a looping getter or `toJSON` is
// stopped too. It never throws for a promise, so a microtask loop still drains, and times out.
const CALL = new vm.Script(`
__gamebarThenable = false;
__gamebarOut = undefined;
{
  const out = globalThis[__gamebarFn](JSON.parse(__gamebarIn));
  if (out !== null && (typeof out === "object" || typeof out === "function") && typeof out.then === "function") {
    __gamebarThenable = true;
  } else {
    __gamebarOut = JSON.stringify(out === undefined ? null : out);
  }
}`, { filename: "gamebar-script-call" });

// path -> { size, mtimeMs, ctx }
const loaded = new Map();

function describe(e) {
  try {
    if (e && typeof e === "object" && typeof e.message === "string") return `${e.name || "Error"}: ${e.message}`;
    return `threw ${String(e)}`;
  } catch {
    return "threw a value that cannot be described";
  }
}

function load(file, timeout) {
  const st = statSync(file);
  const hit = loaded.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.ctx;
  loaded.delete(file);
  let script;
  try {
    script = new vm.Script(readFileSync(file, "utf8"), { filename: file });
  } catch (e) {
    const hint = /\b(import|export)\b/.test(String(e && e.message)) ? " (a script is a classic script: import and export are not supported)" : "";
    throw new Error(`cannot load: ${describe(e)}${hint}`);
  }
  const ctx = vm.createContext({}, {
    name: file,
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  script.runInContext(ctx, { timeout });
  loaded.set(file, { size: st.size, mtimeMs: st.mtimeMs, ctx });
  return ctx;
}

function runCall({ script, fn, input }, timeout) {
  try {
    const ctx = load(script, timeout);
    if (typeof ctx[fn] !== "function") throw new Error(`the script defines no function ${fn}()`);
    ctx.__gamebarFn = fn;
    ctx.__gamebarIn = input;
    CALL.runInContext(ctx, { timeout });
    if (ctx.__gamebarThenable) throw new Error(`${fn}() returned a promise; a script must return its result directly`);
    return { status: "ok", output: ctx.__gamebarOut };
  } catch (e) {
    // A failed script's context may be left half-run; a later load starts it fresh.
    loaded.delete(script);
    if (e && e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return { status: "timeout", message: `ran past its ${timeout} ms budget` };
    return { status: "error", message: describe(e) };
  }
}

port.on("message", ({ seq, budgetMs, calls }) => {
  const results = [];
  const failed = new Set();
  for (let i = 0; i < calls.length; i++) {
    // The host gave up on this batch: skip what is left of it.
    if (Atomics.load(i32, SLOT.CANCEL) >= seq) break;
    const c = calls[i];
    if (failed.has(c.script)) { results.push({ status: "disabled" }); continue; }
    Atomics.store(start, 0, process.hrtime.bigint());
    Atomics.store(i32, SLOT.RUN_SEQ, seq);
    Atomics.store(i32, SLOT.RUN_INDEX, i);
    // A test hook standing in for a hang in native code: it blocks outside the vm timeout.
    if (simulateNativeHang && c.script === simulateNativeHang) Atomics.wait(i32, SLOT.HANG, 0);
    const r = runCall(c, budgetMs);
    if (r.status !== "ok") failed.add(c.script);
    results.push(r);
  }
  Atomics.store(i32, SLOT.RUN_INDEX, -1);
  port.postMessage({ seq, results });
  Atomics.store(i32, SLOT.DONE, seq);
  Atomics.notify(i32, SLOT.DONE);
});

Atomics.store(i32, SLOT.RUN_INDEX, -1);
Atomics.store(i32, SLOT.READY, 1);
Atomics.notify(i32, SLOT.READY);
