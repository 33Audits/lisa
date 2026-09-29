/**
 * The deterministic-harness execution lane.
 *
 * This does NOT call the Anthropic API, and it does NOT fabricate a QA report's content (no
 * invented bug titles, no invented repro steps) — that would be exactly the kind of faked
 * evidence the benchmark is required to avoid. What it *does* model, honestly and as a named
 * simplification: given a mission's ground-truth required capability tier and the tier a
 * strategy actually chose, would that tier plausibly complete the mission, and roughly what
 * would it cost?
 *
 * The model: a tier at or above the mission's ground-truth tier always succeeds. A tier below
 * it succeeds only some of the time — cheap models occasionally get lucky on an easy slice of
 * a hard mission — with probability falling off sharply per rank of shortfall. All of this is
 * seeded from a SHA-256 hash of `(missionId, tier)`, so it's a fixed function, not a random
 * number generator: the same corpus always produces the same simulated outcome for the same
 * (mission, tier) pair, on this machine or any other. That is what makes the bulk of this
 * benchmark reproducible without touching the network — see `bench/README.md` for the
 * "deterministic-harness" vs "live-model" evidence distinction this lane is one half of.
 */

import crypto from "node:crypto";
import { TIER_SPECS, costUsd, type Tier } from "../../src/routing/ladder.js";
import type { MissionSpec } from "./corpus.js";

export type EvidenceKind = "deterministic-harness" | "live-model";

export interface SimResult {
  missionId: string;
  tier: Tier;
  success: boolean;
  /** Capability rank(tier) - rank(groundTruthTier). 0 = exact match, negative = under-capable. */
  capabilityGap: number;
  turnsUsed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  evidence: EvidenceKind;
}

/** A fixed function of `key`, not a random draw — see module docstring. Range [0, 1). */
export function seededUnit(key: string): number {
  const digest = crypto.createHash("sha256").update(key).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Success probability for a tier `gap` ranks below what the mission needs. Falls off sharply:
 * one rank short still occasionally lands (a "balanced"-shaped mission a "fast" tier happens to
 * nail), three-plus ranks short is treated as a near-zero floor rather than a hard zero, so the
 * oracle strategy (which searches every tier) is never mathematically guaranteed to skip the
 * cheapest tier — it has to actually check, same as a real cheapest-successful search would.
 */
function underCapableSuccessProbability(gap: number): number {
  if (gap >= 0) return 1;
  if (gap === -1) return 0.25;
  if (gap === -2) return 0.08;
  return 0.02;
}

const TURN_EFFICIENCY: Record<Tier, number> = { fast: 1.35, balanced: 1.1, strong: 1.0, long: 0.95 };

export function simulateMissionOnTier(mission: MissionSpec, tier: Tier): SimResult {
  const capabilityGap = TIER_SPECS[tier].rank - TIER_SPECS[mission.groundTruthTier].rank;
  const p = underCapableSuccessProbability(capabilityGap);
  const success = capabilityGap >= 0 ? true : seededUnit(`success|${mission.id}|${tier}`) < p;

  // Under-capable runs thrash more: retries, re-reads, backtracking on a misread page.
  const strain = capabilityGap < 0 ? 1.25 : 1.0;
  const baseTurns = 2 + mission.expectedSteps; // a navigate/read_page pair per step, roughly
  const turnsUsed = Math.max(1, Math.min(mission.maxTurns, Math.round(baseTurns * TURN_EFFICIENCY[tier] * strain)));

  const avgInputTokensPerTurn = 1200 + 350 * mission.expectedSteps + 150 * mission.expectedPages;
  const avgOutputTokensPerTurn = 220 + 40 * mission.expectedSteps;
  const inputTokens = Math.round(avgInputTokensPerTurn * turnsUsed);
  const outputTokens = Math.round(avgOutputTokensPerTurn * turnsUsed);

  return {
    missionId: mission.id,
    tier,
    success,
    capabilityGap,
    turnsUsed,
    inputTokens,
    outputTokens,
    costUsd: costUsd(tier, inputTokens, outputTokens),
    evidence: "deterministic-harness",
  };
}

/** Simulate every tier for one mission — the oracle strategy's raw material. */
export function simulateAllTiers(mission: MissionSpec, tiers: Tier[]): Record<Tier, SimResult> {
  const out = {} as Record<Tier, SimResult>;
  for (const t of tiers) out[t] = simulateMissionOnTier(mission, t);
  return out;
}
