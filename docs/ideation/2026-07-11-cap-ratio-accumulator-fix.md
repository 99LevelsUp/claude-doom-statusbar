# Cap-ratio accumulator fix — mugshot health bloodied at low usage

**Date:** 2026-07-11
**Trigger:** Mugshot rendered fully bloodied while 5h rate-limit usage was only 24%.

## Symptom

Live global accumulator (`%TEMP%/mugshot_ratehealth_global.json`):

```json
{"p5":24, "p7":34, "sum5":489, "sum7":1469}
```

Health computation (`rateHeadroom`, `src/statusline.js`):

- `rem5 = 100 − 24 = 76`
- `rem7 = 100 − 34 = 66`
- `k = sum5 / sum7 = 489 / 1469 = 0.33`
- `headroom = min(rem7·k, rem5) = min(66·0.33, 76) = min(22, 76) = 22`

`22` falls under three of the `[20, 40, 60, 80]` HP thresholds → near-bloodied face,
despite the 5h window having 76% headroom.

## Root cause — the estimator is structurally broken, not merely noisy

`k` is meant to be `cap7d / cap5h`, estimated as
`sum(positive Δp5) / sum(positive Δp7)` accumulated over the file's whole lifetime.

The physics: `sum5 ≈ 100·U/cap5h`, `sum7 ≈ 100·U/cap7d`, so the expected ratio is
`cap7d / cap5h ≥ 1` (the weekly allowance must exceed a single 5h session's, else the
7d cap would never bind). That means we expect `sum5 ≥ sum7`.

We observe `489 < 1469` — **inverted**. A noisy-but-correct estimator cannot flip the
inequality; this is breakage.

Two mechanisms:

1. **Reset-loss asymmetry (dominant).** The 5h window resets ~33× more often than the
   7d window (168h / 5h). Whenever a reset lands between two samples, the new window's
   initial climb becomes a *negative* delta (`p5: 24 → 5` gives `d = −19`), which
   `if (d > 0)` silently drops. Weighted ~33:1 against `sum5`, this systematically
   deflates `sum5` and drives `k` below 1 — exactly the direction observed.
   *Verified against the code path:* `const d = cur.p5 - prev.p5; if (d > 0) sum5 += d;`
   discards the post-reset climb of the new window.

2. **Concurrent read-modify-write on the shared global file.** Hundreds of concurrent
   sessions do unlocked read-modify-write, so updates are lost or double-counted.
   Explains general unreliability; less directional than (1).

(The earlier "float-vs-int jitter" hypothesis was rejected: 1469 pp of movement cannot
come from sub-integer jitter — `p7` is stored as an integer; the `1469.0000000000002`
is ordinary FP summation error.)

## Immediate guard (mechanism-independent)

`k < 1` is physically impossible. Treat it as untrusted:

- Raise the `K_LO` clamp from `0.2` to `1.0` (permanent physical floor), **and**
- Only trust `k` for `min(rem7·k, rem5)` when `k ≥ 1`; otherwise fall back to `rem5`.

For today's data this yields `headroom = min(66·1, 76) = 66` → healthy face. This is the
one-change fix and captures ~95% of the value.

## Redesign — replace the estimator, don't tune it

| # | Proposal | Solves | Cost |
|---|----------|--------|------|
| A | **Paired instantaneous deltas** — record `Δp5/Δp7` only when *both* `Δp5>0 AND Δp7>0` (no reset since last sample); aggregate via EWMA or median | reset-loss #1 (reset samples excluded naturally); recent data dominates → plan changes self-heal | medium |
| B | **Decay / TTL** on the accumulator | lifetime gross-sum never forgets poisoned old data | low |
| C | **Fix the race** — atomic write, or freeze `k` once converged (it is a plan constant, not per-render state) | #2 + write contention | low–medium |
| D | **Permanent `k ≥ 1` clamp** | physical safety net behind any estimator | trivial |

**Recommended layering:** D (ship now) → A (paired deltas + EWMA/median as the core
estimator) → B + C (longevity + concurrency).

## Strategic framing

With a correct `k` (probably ≫ 1), the **5h wall binds almost always**; the 7d window
only matters when the weekly budget is genuinely near exhaustion. So conservative
estimation (`k ≥ 1`, fall back to `rem5`) costs almost nothing, and the estimator's real
job is narrow: **detect when 7d is the actual threat.** That is why guard D delivers most
of the value and A/B/C are refinements of the remaining tail.
