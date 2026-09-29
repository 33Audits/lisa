# Lisa mission-routing benchmark

Compares four strategies for picking a model tier per QA mission, over a frozen, stratified
corpus of 30 hand-authored missions. Run it with:

```bash
npm run bench            # deterministic lane only — no API key needed, no network calls
npm run bench -- --live  # also attempt a small live-model sample (needs Anthropic API or bearer auth)
```

If `--live` is requested without usable credentials, the command exits non-zero rather than
silently presenting a deterministic-only report as live evidence.

Output: `bench/results/latest.json` (machine-readable) and `bench/results/latest.md`
(human-readable), overwritten each run. The deterministic lane reproduces bit-for-bit — the
script recomputes every number a second time in-process and aborts if the two runs disagree
(see "Determinism self-check" in the report).

## What's being compared

| Strategy | What it does |
|---|---|
| `fixed-strong` | Always the `strong` tier (Opus). The safe, expensive default. |
| `fixed-balanced` | Always the `balanced` tier (Sonnet) — Lisa's actual current fixed default (`LISA_MODEL`). |
| `routed-pinned` | Lisa's real, opt-in appraiser (`src/routing`), called exactly as `runAgent` calls it, with `LISA_ROUTING=1` and no long-tier opt-in — the cautious config a real operator would turn on first. |
| `oracle-cheapest-successful` | A cheating upper bound: searches every tier's simulated outcome for each mission with perfect hindsight and picks the cheapest one that succeeded. No real strategy can beat it; it measures the headroom left on the table. |

## Two evidence lanes — never mixed, always tagged

- **`deterministic-harness`** (the default, and the bulk of every report): two independent
  things, both real code, neither an LLM call.
  1. `bench/lib/simulate.ts` — a deterministic, seeded function from `(mission ground-truth
     tier, chosen tier)` to `{success, turns, tokens, cost}`. A tier at or above what a mission
     needs always "succeeds"; a tier below it succeeds only sometimes, with probability
     falling off sharply per rank of shortfall, seeded from `sha256(missionId, tier)` so it's
     the same number every time, on every machine, forever. This does **not** fabricate a QA
     report's content — no invented bug titles, no invented repro steps. It models an outcome,
     not a transcript.
  2. `bench/lib/browser-smoke.ts` — a real Playwright/Chromium session (Lisa's actual
     `BrowserSession` class) driven against a tiny local fixture app
     (`bench/fixture-app/index.html`) with two seeded, deterministic defects. No LLM is
     involved; this proves Lisa's own browser primitives work, independent of anything
     routing- or model-related.
- **`live-model`**: real `runAgent` calls against the same fixture app, with a real Anthropic
  API key. Only runs with `--live` **and** `ANTHROPIC_API_KEY` set. Every record from this lane
  carries `evidence: "live-model"`. Without a key, the report says so explicitly — it never
  silently omits the section or substitutes simulated numbers for it.

This split exists because the task requires the benchmark to execute without production
credentials, and to be honest about which numbers came from where. Nothing in the
`deterministic-harness` lane is presented as if it were live-model evidence, and vice versa.

## The corpus (`bench/corpus/missions.json`)

30 missions against a fictional "Acme" SaaS staging app, stratified across the four tiers by
`groundTruthTier` — a human QA-lead judgment call about the minimum tier that could do the
mission justice, made independently of the appraiser's own scoring vocabulary. The point of the
benchmark is to see how well an independently-scored mission brief lines up with that judgment;
writing missions *to* the appraiser's keyword list would make that comparison meaningless.

| Tier | Missions | Example |
|---|---:|---|
| `fast` | 8 | "Check that the marketing homepage loads and the primary Sign up button is visible." |
| `balanced` | 10 | "Add an item to the cart, adjust the quantity, remove a different item, and confirm the running total updates correctly at each step." |
| `strong` | 8 | "Open two tabs as the same logged-in user, edit the same project's settings in both... confirm the app surfaces a conflict rather than silently overwriting tab A's change." |
| `long` | 4 | "Do a full exploratory pass across the entire application... give comprehensive, full coverage rather than spot-checking." |

Split **calibration / holdout** (9 / 21, stratified so every tier appears in both): the
calibration split's ground truth was used to tune the appraiser's three tier-boundary constants
in `src/routing/appraiser.ts` (`THRESHOLDS`) — that tuning is the calibration split's entire
job. The benchmark's headline numbers (the "Headline results" table) are computed on the
**holdout split only**, which the thresholds were never fit against. The "Calibration split"
table in the report is shown separately, labeled as a diagnostic, specifically so the tuned-on
numbers can never be mistaken for the generalization numbers.

Corpus changes are append-only: bump `corpus_version` and add missions rather than editing
existing ones in place, so a past benchmark run stays reproducible against the corpus it
actually ran on (`corpusFingerprint()` in `bench/lib/corpus.ts` is a content hash for exactly
this check).

## Metrics

- **Route regret** — `cost(chosen tier) - cost(oracle tier)` when the chosen tier succeeded, or
  the full `cost(chosen tier)` when it didn't (a failed run bought nothing, so its whole cost is
  regret). Always `>= 0` on a successful run by construction, since the oracle is defined as the
  cheapest tier that succeeded on that same simulated mission.
- **Under-route rate** — fraction of missions where the chosen tier's capability rank is below
  the mission's ground-truth tier's rank. Compares tiers directly (not simulated success), so
  it's not entangled with the simulator's own noise.
- **Over-route rate** — the mirror: chosen tier's rank above ground truth.
- **Cost-per-verified-success** — total cost of every attempted mission, including failed attempts,
  divided by the count of successes. Failed runs consumed money and therefore stay in the
  numerator. **Read this together with success rate, not alone**: a strategy can still post a
  deceptively low ratio when its failed attempts are very cheap, so matching the fixed-strong
  quality floor remains a separate launch gate.
- **90% confidence intervals** — bootstrap (2000 resamples, deterministically seeded per metric
  from the corpus fingerprint) over the holdout mission set. Refused (reported as "n/a") below 5
  missions in a group — a CI on a handful of points is theater, not evidence.

## The Lisa-side appraiser/adapter and its isolation from jev-auto

`src/routing/` (`ladder.ts`, `appraiser.ts`, `resolveModel.ts`) is the thing under test. It is
an **independent implementation for Lisa's domain**, not a port, fork, or import of
`33Audits/jev-auto`. That's not a style choice — the public jev-auto checkout available
alongside this repo (`/root/work/jev-bench-run/repo`) ships only `README.md`, `LICENSE`,
`package.json`, and one `.claude/skills` entry. There is no `src/` directory in it at all, so
there is nothing to import from. `src/routing/README.md` has the full isolation note, including
a table of exactly where this module's design matches jev-auto's documented behavior (because
the underlying problem is genuinely similar) versus where it necessarily differs (Lisa scores
one mission brief once, before any tool call, and pins that tier for an entire browser session;
jev-auto scores a rolling multi-turn conversation and can re-route the next turn).

Wiring: `runAgent` in `src/core.ts` calls `resolveRunModel()` exactly once per mission, before
the tool loop starts, and pins whatever model it returns for every turn of that mission. Off by
default (`LISA_ROUTING` unset) — byte-identical to Lisa's pre-routing behavior. Every internal
appraiser failure falls back to the fixed model rather than blocking a run (see
`test/routing.test.ts`'s fail-open suite). The `routing` field this produces, on both `Report`
and the `routing` `AgentEvent`, is deliberately minimal: tier, model id, decision source, and
closed reason/error codes. Detailed feature counts and scores remain in memory and are not
persisted because even derived values can fingerprint a sensitive mission (see
`test/routing.test.ts`'s privacy suite).

## Files

| | |
|---|---|
| `corpus/missions.json` | the frozen, stratified mission corpus |
| `lib/corpus.ts` | loader + validation + content-fingerprint |
| `lib/simulate.ts` | the deterministic, seeded outcome/cost model |
| `lib/strategies.ts` | the four strategies, `routed-pinned` calling the real `resolveRunModel()` |
| `lib/metrics.ts` | route regret, under/over-route, cost-per-verified-success, bootstrap CI |
| `lib/grade.ts` | deterministic acceptance checks for a real `Report` (used by the live lane) |
| `lib/fixture-server.ts` / `fixture-app/index.html` | the tiny local staging app with two seeded defects |
| `lib/browser-smoke.ts` | real-Playwright, no-LLM deterministic-harness evidence |
| `lib/live-lane.ts` | the gated live-model lane |
| `run-benchmark.ts` | orchestrator: builds records, computes metrics, self-checks determinism, writes `results/latest.{json,md}` |

## Limitations (also stated in every generated report)

- The deterministic-harness lane models mission *outcomes*, not transcripts — it does not
  generate fake bug reports.
- `routed-pinned` runs with the long tier opted out (the cautious default), so it under-routes
  the four `long`-ground-truth missions by construction. That's a disclosed property of the
  recommended default config, not an oversight.
- 30 missions is a small corpus; treat point estimates as more informative than tight interval
  bounds, especially on the calibration split (9 missions).
- Display pricing in `src/routing/ladder.ts` mirrors jev-auto's own disclaimer: illustrative,
  not a billing source of truth.
- No calibration *loop* — the appraiser's thresholds are fixed constants tuned once against the
  calibration split, not a live, self-adjusting ledger the way jev-auto's `calibrate.mjs` is.
