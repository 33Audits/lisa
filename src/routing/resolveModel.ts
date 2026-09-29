/**
 * Where a run's model gets decided: fixed by default, or appraised-and-pinned once per
 * mission when routing is opted into.
 *
 * The default path is byte-identical to what `core.ts` did before this module existed: read
 * `LISA_MODEL`, fall back to `claude-sonnet-5`. Nothing about that path changes unless the
 * caller sets `LISA_ROUTING=1`. Every failure mode inside the routed path — a throwing
 * appraiser, an unrecognised tier, a disallowed opt-in tier chosen anyway — falls back to that
 * same fixed model rather than blocking or guessing, matching jev-auto's own fail-open
 * contract: "a router that times out, throws, returns nonsense, or is not configured at all
 * keeps the current model and never blocks a prompt."
 */

import { appraiseMission } from "./appraiser.js";
import { TIER_SPECS, modelForTier, type Tier } from "./ladder.js";

export type RoutingDecidedBy = "fixed" | "appraiser" | "fail-open-fallback";

/**
 * Deliberately minimal persisted metadata. Detailed feature counts and scores stay in memory
 * inside the appraiser: even without verbatim text, persisting them could fingerprint a
 * sensitive mission. Reports retain only the operational routing decision and a closed reason
 * code.
 */
export interface RoutingMeta {
  enabled: boolean;
  tier: Tier | null;
  model: string;
  decidedBy: RoutingDecidedBy;
  reason?: string;
  /** Set only when `decidedBy === "fail-open-fallback"` — a closed code, never exception text. */
  error?: string;
}

export interface ResolveModelOptions {
  mission: string;
  credentialRoleCount: number;
  maxTurns: number;
  /** Defaults to `process.env`; overridable so callers (tests, the benchmark) don't have to mutate globals. */
  env?: Record<string, string | undefined>;
}

export interface ResolveModelResult {
  model: string;
  routing: RoutingMeta;
}

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

const FIXED_MODEL_ENV_VAR = "LISA_MODEL";
const FIXED_MODEL_DEFAULT = "claude-sonnet-5";

/** The model a non-routed run uses — exported so `core.ts`'s `MODEL` constant and this module can never drift apart. */
export function fixedModel(env: Record<string, string | undefined> = process.env): string {
  return env[FIXED_MODEL_ENV_VAR] ?? FIXED_MODEL_DEFAULT;
}

/**
 * Appraise once, pin for the whole mission. Called exactly once per `runAgent` invocation,
 * before the tool loop starts — never mid-loop, so the model can't flip under a session the
 * way jev-auto pins a tool-loop continuation to whatever tier its first turn chose.
 */
export function resolveRunModel(opts: ResolveModelOptions): ResolveModelResult {
  const env = opts.env ?? process.env;
  const fixed = fixedModel(env);

  if (!truthy(env.LISA_ROUTING)) {
    return { model: fixed, routing: { enabled: false, tier: null, model: fixed, decidedBy: "fixed" } };
  }

  try {
    const appraisal = appraiseMission(opts.mission, { credentialRoleCount: opts.credentialRoleCount, maxTurns: opts.maxTurns });
    let tier = appraisal.tier;
    let reason = appraisal.reason;

    const spec = TIER_SPECS[tier];
    if (!spec) throw new Error(`appraiser returned an unrecognised tier`);

    // The `long` tier bills extra usage credits (matches jev-auto's `JEV_ALLOW_FABLE` gate on
    // its Fable tier) — never chosen unless explicitly opted into, even if the appraiser
    // thought the mission warranted it.
    if (spec.requiresOptIn && !truthy(env.LISA_ROUTING_ALLOW_LONG)) {
      tier = "strong";
      reason = "long-tier-not-opted-in-clamped-to-strong";
    }

    const model = modelForTier(tier);
    return {
      model,
      routing: {
        enabled: true,
        tier,
        model,
        decidedBy: "appraiser",
        reason,
      },
    };
  } catch (e: any) {
    return {
      model: fixed,
      routing: {
        enabled: true,
        tier: null,
        model: fixed,
        decidedBy: "fail-open-fallback",
        error: "appraiser-error",
      },
    };
  }
}
