// The script host: runs batches of skin script calls synchronously from the render pass.
//
// Scripts run in one persistent worker thread (worker.js). `runBatch` posts a batch and blocks on
// a shared buffer with `Atomics.wait`, so the render pass stays synchronous while the work runs on
// a thread that can be stopped. Every call has a time budget the worker enforces with the vm
// timeout. A hang the vm timeout cannot reach (native code, a crashed worker) hits the batch
// backstop: the host reads which call was running and since when, disables that script when it
// has run past its budget, and replaces the worker without waiting for the old one to stop.
//
// A script that throws or runs past its budget is disabled until its file changes (size or
// mtime) or it is called for another skin. Scripts are trusted like any code the user installs;
// the vm context keeps timers, `require` and `eval` out of reach, but it is not a security
// boundary.
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { statSync } from "node:fs";
import { SLOT, BUFFER_BYTES, startTimes } from "./layout.js";

const WORKER_FILE = new URL("./worker.js", import.meta.url);

const stamp = (file) => {
  try { const st = statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return "missing"; }
};

// options:
//   callBudgetMs  each call's time budget, enforced by the vm timeout (default 20)
//   graceMs       how far past a batch's deadline the backstop waits, so the vm timeout, which
//                 fires late on a coarse system timer, stops ordinary loops first (default 40)
//   startupMs     how long a batch waits for a new worker to signal it is ready (default 500)
//   maxHeapMb     the worker's old-generation heap limit (default 64)
//   simulateNativeHang  test hook: a script path whose calls block outside the vm timeout
export function createScriptHost({ callBudgetMs = 20, graceMs = 40, startupMs = 500, maxHeapMb = 64, simulateNativeHang } = {}) {
  let w = null; // { worker, port, i32, start, dead }
  let seq = 0;
  let abandoned = 0; // the last batch the host gave up on while its worker was still running it
  let spawns = 0;
  const pending = new Map(); // batch seq -> the calls sent in it, for the current worker
  const disabled = new Map(); // skin + script -> the file stamp it failed with

  const keyOf = (script, skin) => `${skin ?? ""}\n${script}`;

  function spawn() {
    const buffer = new SharedArrayBuffer(BUFFER_BYTES);
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(WORKER_FILE, {
      workerData: { buffer, port: port2, simulateNativeHang },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
    });
    const entry = { worker, port: port1, i32: new Int32Array(buffer), start: startTimes(buffer), dead: false };
    // An unhandled worker error would take the daemon down; mark the worker dead instead and
    // let the next batch replace it.
    worker.on("error", () => { entry.dead = true; });
    worker.on("exit", () => { entry.dead = true; });
    worker.unref();
    port1.unref();
    w = entry;
    spawns++;
    pending.clear();
    abandoned = 0;
  }

  function replace() {
    const old = w;
    old.dead = true;
    old.worker.terminate().catch(() => {});
    old.port.close();
    spawn();
  }

  function ready() {
    if (!w || w.dead) spawn();
    if (Atomics.load(w.i32, SLOT.READY) !== 1) Atomics.wait(w.i32, SLOT.READY, 0, startupMs);
    return Atomics.load(w.i32, SLOT.READY) === 1;
  }

  // Blocks until the worker has finished batch `target` or `ms` have passed.
  function waitDone(target, ms) {
    const until = performance.now() + ms;
    for (;;) {
      const done = Atomics.load(w.i32, SLOT.DONE);
      if (done >= target) return true;
      const left = until - performance.now();
      if (left <= 0) return false;
      Atomics.wait(w.i32, SLOT.DONE, done, left);
    }
  }

  function disable(call) {
    disabled.set(keyOf(call.script, call.skin), stamp(call.script));
  }

  // Reads the worker's replies; disables the scripts that failed in them and returns the reply
  // to batch `want`, if it is there.
  function receive(want) {
    let found = null;
    for (let m; (m = receiveMessageOnPort(w.port));) {
      const { seq: s, results } = m.message;
      const calls = pending.get(s);
      pending.delete(s);
      if (!calls) continue;
      results.forEach((r, i) => { if (r.status === "error" || r.status === "timeout") disable(calls[i]); });
      if (s === want) found = { calls, results };
    }
    return found;
  }

  // The call the worker is running: { seq, index, elapsed }, or null between calls.
  function running() {
    const index = Atomics.load(w.i32, SLOT.RUN_INDEX);
    if (index < 0) return null;
    const seq = Atomics.load(w.i32, SLOT.RUN_SEQ);
    return { seq, index, elapsed: Number(process.hrtime.bigint() - Atomics.load(w.start, 0)) / 1e6 };
  }

  // The call the worker is stuck in, if it has run past its budget plus the grace: that script
  // is disabled and the worker replaced. Returns { seq, index, elapsed, script }, or null.
  function pinHang(grace) {
    const r = running();
    const calls = r && pending.get(r.seq);
    if (!calls || r.elapsed <= callBudgetMs + grace) return null;
    disable(calls[r.index]);
    replace();
    return { ...r, script: calls[r.index].script };
  }

  // Before a new batch: let a batch the host gave up on finish its current call, for at most one
  // call's budget plus the grace. A worker that does not is stuck, and is replaced.
  function settle(grace) {
    if (!abandoned) return true;
    if (waitDone(abandoned, callBudgetMs + grace)) { receive(0); abandoned = 0; return true; }
    receive(0);
    if (!pinHang(grace)) replace();
    return ready();
  }

  function runBatch(calls, { deadlineMs, graceMs: grace = graceMs } = {}) {
    const out = new Array(calls.length);
    if (w && !w.dead) receive(0);
    const send = [];
    calls.forEach((c, i) => {
      const key = keyOf(c.script, c.skin);
      if (disabled.has(key)) {
        if (disabled.get(key) === stamp(c.script)) {
          out[i] = { status: "disabled", message: `${c.script}: disabled after an earlier failure` };
          return;
        }
        disabled.delete(key);
      }
      send.push(i);
    });
    const rest = () => { for (const i of send) if (!out[i]) out[i] = { status: "skipped" }; return out; };
    if (!send.length) return out;
    if (!ready() || !settle(grace)) return rest();

    const s = ++seq;
    const sent = send.map((i) => calls[i]);
    pending.set(s, sent);
    w.port.postMessage({
      seq: s,
      budgetMs: callBudgetMs,
      calls: sent.map((c) => ({ script: c.script, fn: c.fn || "render", input: JSON.stringify(c.input ?? null) })),
    });

    let done = waitDone(s, (deadlineMs ?? callBudgetMs * sent.length) + grace);
    if (!done) {
      // A call already past its own budget gets until its budget plus the grace: by then the vm
      // timeout has stopped it, or it is a hang to pin on that script in this pass.
      const r = running();
      if (r && r.seq === s && r.elapsed > callBudgetMs) done = waitDone(s, callBudgetMs + grace - r.elapsed + 1);
    }
    if (done) {
      const reply = receive(s);
      if (reply) {
        reply.results.forEach((r, j) => {
          const c = sent[j];
          out[send[j]] = r.status === "ok"
            ? { status: "ok", output: JSON.parse(r.output) }
            : r.status === "disabled"
              ? { status: "disabled", message: `${c.script}: disabled after an earlier failure` }
              : { status: r.status, message: `${c.script}: ${r.message}` };
        });
      }
      return rest();
    }

    // The backstop: the batch is past its deadline.
    const hang = pinHang(grace);
    if (hang) {
      if (hang.seq === s) {
        out[send[hang.index]] = {
          status: "timeout",
          message: `${hang.script}: did not return within ${Math.round(hang.elapsed)} ms; the script worker was restarted`,
        };
      }
    } else if (Atomics.load(w.i32, SLOT.RUN_INDEX) < 0 && Atomics.load(w.i32, SLOT.DONE) < s) {
      // Not running any call and not done: the worker is gone or stuck outside a call.
      replace();
    } else {
      // Cut short by the deadline, not by the script: nothing is disabled, and the worker drops
      // the rest of the batch after its current call.
      Atomics.store(w.i32, SLOT.CANCEL, s);
      abandoned = s;
    }
    return rest();
  }

  return {
    runBatch,
    isDisabled: (script, skin) => {
      const key = keyOf(script, skin);
      return disabled.has(key) && disabled.get(key) === stamp(script);
    },
    get spawns() { return spawns; },
    close() {
      if (!w) return;
      w.dead = true;
      w.worker.terminate().catch(() => {});
      w.port.close();
      w = null;
    },
  };
}
