// The script host: runs batches of skin script calls synchronously from the render pass.
//
// Scripts run in one persistent worker thread (worker.js). `runBatch` posts a batch and blocks on
// a shared buffer with `Atomics.wait`, so the render pass stays synchronous while the work runs on
// a thread that can be stopped. Every call has a time budget the worker enforces with the vm
// timeout. A hang the vm timeout cannot reach (native code, a crashed worker) hits the batch
// backstop: the host reads which call was running and since when, disables that script when it
// has run past its budget, and replaces the worker without waiting for the old one to stop.
//
// A script that throws, fails to load, or returns a promise or a value that is not JSON (a
// function, a Symbol) is disabled until its file changes (size or mtime) or it is called for
// another skin. A script that runs past its budget (stopped by
// the vm timeout or pinned by the backstop) is disabled only for a cooldown, since one spike of
// load on the machine is enough to make it late: 30 s, doubling each time it runs past its budget
// again (1, 2, 4 ... min) up to 10 min. A call that returns resets the cooldown to 30 s; a change
// of its file or skin ends it at once. While it cools down it is not called at all, so it costs
// nothing per frame. Scripts are trusted like any code the user installs;
// the vm context keeps timers, `require` and `eval` out of reach, but it is not a security
// boundary.
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { statSync } from "node:fs";
import { SLOT, BUFFER_BYTES, startTimes } from "./layout.js";

const WORKER_FILE = new URL("./worker.js", import.meta.url);

const disabledResult = (script) => ({ status: "disabled", message: `${script}: disabled after an earlier failure` });

export const stamp = (file) => {
  try { const st = statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return "missing"; }
};

// options:
//   callBudgetMs  each call's time budget, enforced by the vm timeout (default 20)
//   graceMs       how far past a batch's deadline the backstop waits, so the vm timeout, which
//                 fires late on a coarse system timer, stops ordinary loops first (default 40)
//   startupMs     how long a batch waits for a new worker to signal it is ready (default 500)
//   maxHeapMb     the worker's old-generation heap limit (default 64)
//   now           the clock cooldowns are measured on, in ms (default: the monotonic
//                 performance.now(), so a change of the wall clock cannot stretch one)
//   simulateNativeHang  test hook: a script path whose calls block outside the vm timeout
export const CALL_BUDGET_MS = 20;
const COOLDOWN_MS = 30_000;
const COOLDOWN_MAX_MS = 600_000;

export function createScriptHost({ callBudgetMs = CALL_BUDGET_MS, graceMs = 40, startupMs = 500, maxHeapMb = 64, now = () => performance.now(), simulateNativeHang } = {}) {
  let w = null;
  let seq = 0;
  let abandoned = 0;
  let spawns = 0;
  const pending = new Map();
  // skin + script -> { stamp, kind, streak, until }: the file stamp it failed with; "error" (off
  // until the stamp changes) or "timeout" (off until `until`, `streak` timeouts in a row)
  const disabled = new Map();

  const keyOf = (script, skin) => `${skin ?? ""}\n${script}`;

  // The entry that keeps a script off right now, or null. An entry whose file changed is dropped;
  // a timeout whose cooldown is over stays, so the next timeout knows its streak.
  function offEntry(script, skin) {
    const key = keyOf(script, skin);
    const e = disabled.get(key);
    if (!e) return null;
    if (e.stamp !== stamp(script)) { disabled.delete(key); return null; }
    return e.kind === "error" || now() < e.until ? e : null;
  }

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

  // Turns a failed script off: for good after an error, for a cooldown after a timeout. Returns
  // the cooldown in ms (Infinity after an error).
  function disable(call, kind) {
    const key = keyOf(call.script, call.skin);
    const st = stamp(call.script);
    if (kind !== "timeout") {
      disabled.set(key, { stamp: st, kind: "error", streak: 0, until: Infinity });
      return Infinity;
    }
    const prev = disabled.get(key);
    const streak = prev && prev.kind === "timeout" && prev.stamp === st ? prev.streak + 1 : 1;
    const ms = Math.min(COOLDOWN_MS * 2 ** (streak - 1), COOLDOWN_MAX_MS);
    disabled.set(key, { stamp: st, kind: "timeout", streak, until: now() + ms });
    return ms;
  }

  // Reads the worker's replies; disables the scripts that failed in them, clears the cooldown of
  // those that returned, and returns the reply to batch `want`, if it is there. An output that is
  // not JSON text is an error, so no reply can throw out of a batch.
  function receive(want) {
    let found = null;
    for (let m; (m = receiveMessageOnPort(w.port));) {
      const { seq: s, results } = m.message;
      const calls = pending.get(s);
      pending.delete(s);
      if (!calls) continue;
      results.forEach((r, i) => {
        if (r.status === "ok") {
          try {
            if (typeof r.output !== "string") throw new Error("no output");
            r.value = JSON.parse(r.output);
          } catch {
            r.status = "error";
            r.message = "returned a value that is not JSON";
          }
        }
        if (r.status === "error" || r.status === "timeout") {
          const ms = disable(calls[i], r.status);
          if (r.status === "timeout") r.retryMs = ms;
        } else if (r.status === "ok") {
          const key = keyOf(calls[i].script, calls[i].skin);
          if (disabled.get(key)?.kind === "timeout") disabled.delete(key);
        }
      });
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
  // is disabled for a cooldown and the worker replaced. Returns { seq, index, elapsed, script,
  // retryMs }, or null.
  function pinHang(grace) {
    const r = running();
    const calls = r && pending.get(r.seq);
    if (!calls || r.elapsed <= callBudgetMs + grace) return null;
    const retryMs = disable(calls[r.index], "timeout");
    replace();
    return { ...r, script: calls[r.index].script, retryMs };
  }

  // What a call to a script that is off returns.
  function offResult(script, e) {
    if (e.kind === "error") return disabledResult(script);
    const s = Math.max(1, Math.ceil((e.until - now()) / 1000));
    return { status: "disabled", message: `${script}: stopped after running past its budget; retried in ${s} s` };
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
      const off = offEntry(c.script, c.skin);
      if (off) out[i] = offResult(c.script, off);
      else send.push(i);
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
            ? { status: "ok", output: r.value }
            : r.status === "disabled"
              ? disabledResult(c.script)
              : r.status === "timeout"
                ? { status: "timeout", message: `${c.script}: ${r.message}`, retryMs: r.retryMs }
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
          message: `${hang.script}: did not return within ${Math.round(hang.elapsed)} ms and was stopped; the script worker was restarted`,
          retryMs: hang.retryMs,
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
    isDisabled: (script, skin) => offEntry(script, skin) !== null,
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
