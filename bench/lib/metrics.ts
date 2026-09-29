/**
 * The metrics the benchmark reports, and the bootstrap confidence intervals around them.
 *
 * One record type (`MissionRun`) carries everything a metric needs for one (strategy, mission)
 * pair. Metrics are plain functions over arrays of these — no hidden state, so a unit test can
 * hand-build three records and check the arithmetic directly (see `test/benchmark.test.ts`).
 */

import { TIER_SPECS, type Tier } from "../../src/routing/ladder.js";
import type { SimResult } from "./simulate.js";
import type { StrategyName } from "./strategies.js";

export interface MissionRun {
  strategy: StrategyName;
  missionId: string;
  split: "calibration" | "holdout";
  chosenTier: Tier;
  groundTruthTier: Tier;
  /** The chosen tier's own simulated outcome — what the strategy actually got. */
  outcome: SimResult;
  /** The oracle's cheapest-successful outcome for the same mission — the regret baseline. */
  oracleOutcome: SimResult;
}

export function isUnderRoute(r: MissionRun): boolean {
  return TIER_SPECS[r.chosenTier].rank < TIER_SPECS[r.groundTruthTier].rank;
}

export function isOverRoute(r: MissionRun): boolean {
  return TIER_SPECS[r.chosenTier].rank > TIER_SPECS[r.groundTruthTier].rank;
}

/**
 * cost(chosen) if it succeeded but wasn't the cheapest successful tier, or the full cost of a
 * chosen tier that didn't succeed at all — the oracle's own cost never sits in the second term
 * unless the strategy also succeeded, so a successful run's regret is always >= 0 (the oracle
 * is by definition the cheapest tier that succeeded on that mission, including in the
 * strategy's own simulated trial).
 */
export function routeRegret(r: MissionRun): number {
  return r.outcome.costUsd - (r.outcome.success ? r.oracleOutcome.costUsd : 0);
}

export function successRate(records: MissionRun[]): number {
  return mean(records.map((r) => (r.outcome.success ? 1 : 0)));
}

export function underRouteRate(records: MissionRun[]): number {
  return mean(records.map((r) => (isUnderRoute(r) ? 1 : 0)));
}

export function overRouteRate(records: MissionRun[]): number {
  return mean(records.map((r) => (isOverRoute(r) ? 1 : 0)));
}

export function meanRouteRegret(records: MissionRun[]): number {
  return mean(records.map(routeRegret));
}

export function totalCostUsd(records: MissionRun[]): number {
  return records.reduce((s, r) => s + r.outcome.costUsd, 0);
}

/**
 * Total attempted-run cost divided by verified successes. Failed attempts still consumed money,
 * so excluding them would make an unreliable strategy look artificially cheap. Returns null
 * when nothing succeeded — a division by zero should be visible, not silently 0 or NaN.
 */
export function costPerVerifiedSuccess(records: MissionRun[]): number | null {
  const successCount = records.filter((r) => r.outcome.success).length;
  if (!successCount) return null;
  return totalCostUsd(records) / successCount;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

// ---------- deterministic bootstrap ----------

/** mulberry32 — a small, fast, deterministic PRNG. Same seed, same stream, forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface BootstrapResult {
  point: number;
  lo: number;
  hi: number;
  n: number;
  resamples: number;
  confidenceLevel: number;
}

/**
 * Bootstrap a confidence interval for `statistic(records)` by resampling `records` with
 * replacement, `resamples` times, from a PRNG seeded by `seedKey` — so re-running the
 * benchmark against the same corpus reproduces the exact same interval, not just a similar
 * one. Meaningless (and refused) below `MIN_N` records: a CI on 2 data points is theater.
 */
const MIN_N_FOR_CI = 5;

export function bootstrapCI(
  records: MissionRun[],
  statistic: (records: MissionRun[]) => number,
  opts: { seedKey: string; resamples?: number; confidenceLevel?: number },
): BootstrapResult | null {
  const n = records.length;
  if (n < MIN_N_FOR_CI) return null;
  const resamples = opts.resamples ?? 2000;
  const confidenceLevel = opts.confidenceLevel ?? 0.9;
  const alpha = 1 - confidenceLevel;
  const rng = mulberry32(seedFromString(opts.seedKey));

  const point = statistic(records);
  const draws: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sample: MissionRun[] = new Array(n);
    for (let i = 0; i < n; i++) sample[i] = records[Math.floor(rng() * n)];
    const v = statistic(sample);
    if (Number.isFinite(v)) draws.push(v);
  }
  draws.sort((a, b) => a - b);
  if (!draws.length) return { point, lo: NaN, hi: NaN, n, resamples, confidenceLevel };
  const loIdx = Math.max(0, Math.floor((alpha / 2) * draws.length));
  const hiIdx = Math.min(draws.length - 1, Math.ceil((1 - alpha / 2) * draws.length) - 1);
  return { point, lo: draws[loIdx], hi: draws[hiIdx], n, resamples, confidenceLevel };
}

/** `costPerVerifiedSuccess` returns `null` on zero successes, which plain `bootstrapCI` can't carry through `statistic: () => number`. */
export function bootstrapCostPerVerifiedSuccess(
  records: MissionRun[],
  opts: { seedKey: string; resamples?: number; confidenceLevel?: number },
): BootstrapResult | null {
  const withFallback = (rs: MissionRun[]) => costPerVerifiedSuccess(rs) ?? NaN;
  return bootstrapCI(records, withFallback, opts);
}
