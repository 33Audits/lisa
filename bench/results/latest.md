# Lisa mission-routing benchmark

Generated: 2026-09-29T01:52:14.556Z
Corpus: `2026-09-29.1` (fingerprint `788c54bdf7b81495`) — 30 missions (9 calibration / 21 holdout)

> Costs, turns, and success/failure for every (mission, tier) pair below come from bench/lib/simulate.ts — a deterministic, seeded function of mission ground truth and tier capability, NOT a live model call and NOT fabricated report content. Route regret, under-route rate, over-route rate, and cost-per-verified-success are computed over the frozen holdout split only (calibration numbers are shown separately, as a diagnostic). 90% confidence intervals are bootstrap resamples of the holdout mission set, seeded deterministically per metric so re-running this script reproduces the exact same interval. See bench/README.md for the full methodology, the corpus construction rationale, and the jev-auto isolation note.

## Determinism self-check

✅ PASSED — recomputing every strategy/metric/CI a second time produced byte-identical JSON

## Headline results (holdout split, deterministic-harness evidence)

| Strategy | n | Success rate | Under-route | Over-route | Mean route regret (90% CI) | Cost / verified success (90% CI) | Total cost |
|---|---:|---:|---:|---:|---|---|---:|
| fixed-strong | 21 | 85.7% | 14.3% | 57.1% | $0.5354 [$0.2849, $0.8348] | $0.8562 [$0.5268, $1.3794] | $15.4117 |
| fixed-balanced | 21 | 61.9% | 42.9% | 23.8% | $0.1214 [$0.0630, $0.1867] | $0.2755 [$0.1579, $0.4828] | $3.5820 |
| routed-pinned | 21 | 81.0% | 19.0% | 14.3% | $0.3899 [$0.1260, $0.6971] | $0.6938 [$0.3241, $1.2431] | $11.7942 |
| oracle-cheapest-successful | 21 | 100.0% | 9.5% | 0.0% | $0.0000 [$0.0000, $0.0000] | $0.4423 [$0.2495, $0.6528] | $9.2873 |

`oracle-cheapest-successful` is a cheating upper bound (it searches every tier's simulated outcome per mission with perfect hindsight) — no real strategy can beat it; it exists to show how much headroom is left. Route regret uses the oracle as its baseline; cost-per-verified-success is each strategy's own total attempted spend divided by its verified successes.

**Read cost-per-verified-success together with success rate, not alone.** The numerator includes every attempted run, including failed attempts, so under-routing is charged rather than discarded. Even so, a low-success strategy can still have a deceptively low ratio if its failed attempts are very cheap; the success-rate launch gate remains mandatory.

## Calibration split (diagnostic only — not the headline numbers)

| Strategy | n | Success rate | Under-route | Over-route | Mean route regret | Cost / verified success |
|---|---:|---:|---:|---:|---:|---:|
| fixed-strong | 9 | 88.9% | 11.1% | 66.7% | $0.5319 | $0.7536 |
| fixed-balanced | 9 | 77.8% | 33.3% | 33.3% | $0.0960 | $0.1996 |
| routed-pinned | 9 | 88.9% | 11.1% | 0.0% | $0.3660 | $0.5669 |
| oracle-cheapest-successful | 9 | 100.0% | 11.1% | 0.0% | $0.0000 | $0.3600 |

## Routing confusion (holdout): ground-truth tier vs chosen tier

### fixed-strong

| ground truth \ chosen | fast | balanced | strong | long |
|---|---:|---:|---:|---:|
| **fast** | 0 | 0 | 5 | 0 |
| **balanced** | 0 | 0 | 7 | 0 |
| **strong** | 0 | 0 | 6 | 0 |
| **long** | 0 | 0 | 3 | 0 |

### fixed-balanced

| ground truth \ chosen | fast | balanced | strong | long |
|---|---:|---:|---:|---:|
| **fast** | 0 | 5 | 0 | 0 |
| **balanced** | 0 | 7 | 0 | 0 |
| **strong** | 0 | 6 | 0 | 0 |
| **long** | 0 | 3 | 0 | 0 |

### routed-pinned

| ground truth \ chosen | fast | balanced | strong | long |
|---|---:|---:|---:|---:|
| **fast** | 3 | 2 | 0 | 0 |
| **balanced** | 0 | 6 | 1 | 0 |
| **strong** | 0 | 1 | 5 | 0 |
| **long** | 0 | 0 | 3 | 0 |

### oracle-cheapest-successful

| ground truth \ chosen | fast | balanced | strong | long |
|---|---:|---:|---:|---:|
| **fast** | 5 | 0 | 0 | 0 |
| **balanced** | 1 | 6 | 0 | 0 |
| **strong** | 0 | 1 | 5 | 0 |
| **long** | 0 | 0 | 0 | 3 |

## Real-browser smoke check (deterministic-harness, no LLM)

Method: `real-playwright-browser-no-llm`. Ran at 2026-09-29T01:51:35.233Z.

The pass/fail `checks` below are deterministic across runs. The raw `detail` log lines in the JSON artifact embed the fixture server's OS-assigned localhost port, which is different every run by design (an ephemeral port, not a routing or simulation input) — expect those lines, and only those lines, to differ between two runs of `npm run bench`.

✅ PASSED — Lisa's real Playwright primitives detected both seeded defects in the fixture app.

```json
{
  "navigateOk": true,
  "clickOk": true,
  "consoleErrorDetected": true,
  "failedRequestDetected": true
}
```

## Live-model lane

Executed against the local fixture app with real Anthropic credentials. Sample size: 2.

| Mission | Passed | Tier | Model |
|---|---|---|---|
| m-002 | ✅ | fast | claude-haiku-4-5-20251001 |
| m-003 | ✅ | fast | claude-haiku-4-5-20251001 |

## Launch decision

❌ **NOT ELIGIBLE FOR PRODUCTION ROUTING YET.** The deterministic lane validates the appraiser, accounting, pinning, and browser harness, but it does not establish model-quality non-inferiority. Promotion requires repeated live runs of fixed-strong, fixed-balanced, and routed-pinned on the untouched holdout corpus with identical app resets and objective acceptance checks.

## Limitations

- The deterministic-harness lane models mission *outcomes* from ground-truth capability tiers with a seeded success-probability curve — it does not run a real model and does not fabricate report content (bug titles, repro steps). See `bench/lib/simulate.ts`.
- `routed-pinned` in this benchmark runs with `LISA_ROUTING=1` and no long-tier opt-in (the cautious default) — missions whose ground truth is `long` under-route by construction under this strategy. That's a real, disclosed property of the recommended default config, not a bug in the benchmark.
- The corpus is 30 hand-authored missions. Confidence intervals reflect that sample size (bootstrap over ~15-21 holdout missions per stratum split) — treat point estimates as more informative than tight interval bounds.
- Display pricing in `src/routing/ladder.ts` mirrors jev-auto's own disclaimer: illustrative, not a billing source of truth.
