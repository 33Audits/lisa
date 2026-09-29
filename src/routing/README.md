# `src/routing` — Lisa's mission appraiser

Opt-in per-mission model routing for standalone Lisa runs. Off by default; `runAgent` keeps
using the fixed `LISA_MODEL` unless `LISA_ROUTING=1` is set.

## Isolation note (read this before assuming a shared codebase)

The public `33Audits/jev-auto` repository, checked out alongside this one at
`/root/work/jev-bench-run/repo`, ships **only** a `README.md`, `LICENSE`, `package.json`, and
one `.claude/skills` entry. There is no `src/` directory — no `src/ladder.mjs`,
`src/appraisers/`, `src/verdict.mjs`, nothing the README's own "How the code is laid out"
table names is actually present in that checkout. This module does not import, vendor, copy,
or transliterate anything from it, because there is nothing there to do that with.

What follows *is* independently written for Lisa, informed only by what jev-auto's README
documents about its own design (tier ladder, fail-open contract, content-free ledger, one
decision per turn pinned for the rest of that turn's tool loop). Where this module's shape
matches that description, it is because the description is the right idea for this problem
too, not because code was moved. Differences that follow from Lisa's shape rather than a
design choice:

| | jev-auto | Lisa's `src/routing` |
|---|---|---|
| Decision granularity | per conversational turn, can re-route the next turn | once per mission, pinned for the entire browser/tool loop |
| What gets scored | a rolling multi-turn conversation (stack traces, file refs, context size) | one mission brief, known in full before the first tool call |
| Backends | local heuristic, delegate-to-Haiku, TypeSafe's hosted `jev` | local heuristic only — no network call, no hosted service |
| Learning loop | ledger of graded turns, calibrates tier boundaries over time (`src/calibrate.mjs`) | none — thresholds are fixed constants in `appraiser.ts`; see Limitations |
| Long-tier gate | `JEV_ALLOW_FABLE=1` | `LISA_ROUTING_ALLOW_LONG=1` (same idea, Lisa's own env var) |

## Limitations

- **No calibration loop.** jev-auto's boundaries move from a ledger of what actually happened
  next in a session. This appraiser's thresholds (`THRESHOLDS` in `appraiser.ts`) are fixed
  constants tuned against the benchmark corpus in `bench/`, not against live Lisa runs. A
  production deployment that wants jev-auto's self-correcting behavior would need to build
  that loop separately — nothing here does it.
- **English-only, keyword-based.** Like jev-auto's own local scorer, this degrades toward the
  middle of the ladder on mission text it can't read confidently. It is not a semantic
  understanding of the mission, just a shape-based proxy.
- **No hosted/LLM-delegate backend.** jev-auto can delegate a scoring call to Haiku or to its
  own hosted service. This appraiser is local-only by design — no extra network call, no extra
  credential, so it stays available in the same environments the fixed-model path already
  works in.

## Files

| | |
|---|---|
| `ladder.ts` | the four tiers, their model ids, capability rank, and display-only cost estimates |
| `appraiser.ts` | `appraiseMission()` — pure function, mission brief in, tier + ephemeral feature scores out |
| `resolveModel.ts` | `resolveRunModel()` — the `LISA_ROUTING` gate, the fail-open wrapper, the long-tier opt-in clamp |
| `index.ts` | barrel export |
