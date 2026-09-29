/**
 * The tier ladder: abstract capability tiers, and what each maps to for a standalone Lisa
 * run.
 *
 * This is Lisa-native, not an import of jev-auto. The public `33Audits/jev-auto` repo
 * available alongside this one ships only a README and package metadata — no `src/`, no
 * `src/ladder.mjs` — so there is nothing to import. This file plays the same *role* jev-auto's
 * `src/ladder.mjs` plays for Claude Code (tiers, capability order, display pricing), sized and
 * named for Lisa's own domain: a QA mission running a fixed browser/tool loop, not a per-turn
 * coding CLI. See `src/routing/README.md` for the full isolation note.
 *
 * Model ids match this environment's current Claude model family so a routed run picks a real,
 * callable model id — the same family `LISA_MODEL`'s default (`claude-sonnet-5`) already names.
 */

export const TIERS = ["fast", "balanced", "strong", "long"] as const;
export type Tier = (typeof TIERS)[number];

export interface TierSpec {
  tier: Tier;
  /** Anthropic model id this tier resolves to. */
  model: string;
  /** Capability ordering — higher can do everything a lower rank can, never the reverse. */
  rank: number;
  /** Rough context ceiling, used only to keep the appraiser's reasoning legible. */
  contextWindowTokens: number;
  /**
   * Display-only cost estimate, USD per million tokens. Mirrors jev-auto's own disclaimer
   * about its `src/tiers.mjs`: "a display default for the savings estimate, not a billing
   * source of truth." Used here purely to make the benchmark's cost/regret numbers legible;
   * actual billing depends on the account and changes over time.
   */
  pricePerMTokIn: number;
  pricePerMTokOut: number;
  /**
   * Tiers a caller must explicitly opt into beyond the base `LISA_ROUTING=1` gate — mirrors
   * jev-auto's `JEV_ALLOW_FABLE`, which gates its "long" tier because it bills extra usage
   * credits. The appraiser clamps down to `strong` when this tier would be chosen but the
   * opt-in wasn't given.
   */
  requiresOptIn?: boolean;
}

export const TIER_SPECS: Record<Tier, TierSpec> = {
  fast: {
    tier: "fast",
    model: "claude-haiku-4-5-20251001",
    rank: 0,
    contextWindowTokens: 200_000,
    pricePerMTokIn: 1,
    pricePerMTokOut: 5,
  },
  balanced: {
    tier: "balanced",
    model: "claude-sonnet-5",
    rank: 1,
    contextWindowTokens: 200_000,
    pricePerMTokIn: 3,
    pricePerMTokOut: 15,
  },
  strong: {
    tier: "strong",
    model: "claude-opus-4-8",
    rank: 2,
    contextWindowTokens: 200_000,
    pricePerMTokIn: 15,
    pricePerMTokOut: 75,
  },
  long: {
    tier: "long",
    model: "claude-fable-5",
    rank: 3,
    contextWindowTokens: 500_000,
    pricePerMTokIn: 15,
    pricePerMTokOut: 75,
    requiresOptIn: true,
  },
};

/** Ascending by capability rank — `TIER_SPECS[TIER_ORDER[0]]` is always the cheapest. */
export const TIER_ORDER: Tier[] = [...TIERS].sort((a, b) => TIER_SPECS[a].rank - TIER_SPECS[b].rank);

export function tierSpec(tier: Tier): TierSpec {
  return TIER_SPECS[tier];
}

export function modelForTier(tier: Tier): string {
  return TIER_SPECS[tier].model;
}

/** True when `rank(a) >= rank(b)` — "a is at least as capable as b". */
export function isAtLeast(a: Tier, b: Tier): boolean {
  return TIER_SPECS[a].rank >= TIER_SPECS[b].rank;
}

export function costUsd(tier: Tier, inputTokens: number, outputTokens: number): number {
  const spec = tierSpec(tier);
  return (inputTokens / 1_000_000) * spec.pricePerMTokIn + (outputTokens / 1_000_000) * spec.pricePerMTokOut;
}
