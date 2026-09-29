/**
 * The mission appraiser: reads one QA mission brief and picks a tier for it, once, before the
 * browser/tool loop starts.
 *
 * This is an independent implementation for Lisa's domain, not a port of jev-auto's
 * `src/appraisers/heuristic.mjs`. jev-auto scores *coding turns* (stack traces, file
 * references, conversation size) one per message, mid-session, and can re-route the very next
 * turn. Lisa's shape is different in the way that matters for a scorer: a QA mission is
 * appraised exactly once, before any tool call, and the chosen tier then drives the entire
 * browser session — there is no next turn to re-score. So this scores the mission brief itself
 * (enumerated steps, destructive/edge-case/cross-cutting language, credential surface, turn
 * budget) rather than a rolling conversation. See `src/routing/README.md`.
 *
 * Every score this module produces is a bucketed count or a 0..1 number — never a substring of
 * the mission text. That is what "content-free" means downstream: a routing-decision record is
 * safe to log, diff, and ship in a benchmark artifact because it cannot leak what the mission
 * was actually testing.
 */

import { TIER_ORDER, type Tier } from "./ladder.js";

export interface MissionShapeFeatures {
  /** Bucketed mission-brief length, not the character count of anything sensitive. */
  lengthBucket: "short" | "medium" | "long";
  /** Enumerated/step-like lines or clauses the brief seems to ask for. */
  stepCount: number;
  /** Hits against the "this needs careful reasoning" vocabulary (edge cases, concurrency, money, auth). */
  hardSignalHits: number;
  /** Hits against "explore broadly / be thorough" vocabulary. */
  breadthSignalHits: number;
  /** Credential roles the mission's project config exposes. */
  credentialRoleCount: number;
  /** The turn budget this run is configured with. */
  maxTurns: number;
}

export interface Appraisal {
  tier: Tier;
  /** How far the winning score sits from the nearest tier boundary, 0..1. */
  confidence: number;
  /** 0..1 sub-scores that composed the decision — bucketed, never raw text. */
  scores: { complexity: number; reasoning: number; toolBreadth: number; contextSize: number };
  features: MissionShapeFeatures;
  /** Short, closed-vocabulary reason code — never a quote from the mission. */
  reason: string;
}

/**
 * Closed vocabulary, matched case-insensitively as whole words. These are *signal categories*
 * for scoring, not something we ever echo back — only the resulting counts leave this module.
 */
const HARD_SIGNAL_WORDS = [
  "concurrent", "concurrency", "race condition", "idempotent", "idempotency", "webhook",
  "payment", "checkout", "refund", "auth", "authentication", "authorization", "permission",
  "role", "migration", "multi-tab", "multi-step", "edge case", "boundary", "negative test",
  "regression", "cross-browser", "accessibility", "a11y", "i18n", "localization", "locale",
  "load test", "performance", "large dataset", "pagination", "rate limit", "retry", "timeout",
  "session expiry", "token refresh", "conflict", "rollback", "consistency", "reconcile",
  "subscription", "downgrade", "upgrade", "prorated", "proration", "billing period", "invoice",
  "credit", "isolation", "isolated", "simultaneous", "duplicate", "double-apply", "stale",
  "cached", "consistent", "reconciliation", "bulk", "cascade", "expire", "expiry", "revoke",
  "rotate", "two-factor", "2fa", "destructive", "danger zone", "irreversible",
];

const BREADTH_SIGNAL_WORDS = [
  "explore", "exploratory", "thorough", "comprehensive", "entire app", "every page",
  "all flows", "full coverage", "end to end", "end-to-end", "whole site", "audit",
];

/**
 * A mission brief enumerates actions two ways in practice: an explicit numbered/bulleted list,
 * or — just as common, and the shape most of this appraiser's own test fixtures and the bench
 * corpus use — a single sentence stringing clauses together with commas and "and" the way a
 * person actually writes a QA mission ("log in, create a project, rename it, and confirm the
 * change"). Splitting only on semicolons and numbered lines (an earlier version of this
 * tokenizer) misses that second, more common shape entirely and silently treats every such
 * mission as a single step. Commas and sentence boundaries are included here for that reason.
 */
const STEP_SPLIT = /(?:\n\s*[-*•]\s+|\n\s*\d+[.)]\s+|[;,]\s+|\.\s+(?=[A-Z])|\bthen\b|\band then\b)/gi;

function countWordHits(text: string, words: string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const w of words) {
    // Simple substring count for multi-word phrases; word-boundary regex for single words to
    // avoid matching inside unrelated words ("role" inside "controller").
    if (w.includes(" ")) {
      let idx = 0;
      while ((idx = lower.indexOf(w, idx)) !== -1) {
        hits++;
        idx += w.length;
      }
    } else {
      const re = new RegExp(`\\b${w}\\b`, "g");
      hits += (lower.match(re) ?? []).length;
    }
  }
  return hits;
}

function lengthBucket(text: string): MissionShapeFeatures["lengthBucket"] {
  const len = text.trim().length;
  if (len < 120) return "short";
  if (len < 400) return "medium";
  return "long";
}

export function extractFeatures(mission: string, opts: { credentialRoleCount: number; maxTurns: number }): MissionShapeFeatures {
  const stepMatches = mission.split(STEP_SPLIT).map((s) => s.trim()).filter((s) => s.length > 3);
  return {
    lengthBucket: lengthBucket(mission),
    stepCount: Math.max(0, stepMatches.length - 1),
    hardSignalHits: countWordHits(mission, HARD_SIGNAL_WORDS),
    breadthSignalHits: countWordHits(mission, BREADTH_SIGNAL_WORDS),
    credentialRoleCount: opts.credentialRoleCount,
    maxTurns: opts.maxTurns,
  };
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Boundaries between tiers, on a single 0..1 difficulty score. Three cut points split the
 * ladder's four tiers. `long` sits above `strongCut` but is only reachable when the caller
 * opted in (see `resolveModel.ts`) — the appraiser still reports it honestly here; clamping is
 * the resolver's job, not the scorer's, so a benchmark can see what the appraiser *would* have
 * picked with no opt-in restriction.
 *
 * Calibrated against `bench/corpus/missions.json`'s calibration split (9 missions, ground
 * truth spanning all four tiers) — this is what that split is *for*. The scorer's own weights
 * above are fixed; these three numbers are the only thing tuned, against calibration-split
 * scores only, never against the holdout split the benchmark reports headline numbers on. See
 * `bench/README.md` for the calibration procedure and the holdout numbers this produced.
 */
const THRESHOLDS = { fastCut: 0.12, balancedCut: 0.30, strongCut: 0.55 };

/**
 * Score one mission brief and return the tier it maps to, with the sub-scores that produced
 * that call. Pure function — same input always produces the same output, which is what lets
 * the benchmark call this thousands of times over a frozen corpus and get identical numbers
 * on every run.
 */
export function appraiseMission(mission: string, opts: { credentialRoleCount: number; maxTurns: number }): Appraisal {
  const features = extractFeatures(mission, opts);

  const complexity = clamp01(
    0.15 * (features.lengthBucket === "long" ? 1 : features.lengthBucket === "medium" ? 0.5 : 0) +
      0.55 * clamp01(features.stepCount / 8) +
      0.30 * clamp01(features.credentialRoleCount / 3),
  );
  const reasoning = clamp01(0.7 * clamp01(features.hardSignalHits / 5) + 0.3 * clamp01(features.breadthSignalHits / 3));
  const toolBreadth = clamp01(0.6 * clamp01(features.stepCount / 10) + 0.4 * clamp01(features.breadthSignalHits / 3));
  // A tight turn budget on an otherwise-hard mission raises difficulty: there is less room to
  // recover from a wrong branch, so a more capable tier is worth its extra cost.
  const contextSize = clamp01(features.maxTurns > 0 ? 1 - clamp01((features.maxTurns - 15) / 60) : 0.5);

  const score = clamp01(0.35 * complexity + 0.4 * reasoning + 0.15 * toolBreadth + 0.10 * contextSize);

  let tier: Tier;
  let reason: string;
  let boundaryDistance: number;
  if (score < THRESHOLDS.fastCut) {
    tier = "fast";
    reason = "below-fast-cut";
    boundaryDistance = THRESHOLDS.fastCut - score;
  } else if (score < THRESHOLDS.balancedCut) {
    tier = "balanced";
    reason = "below-balanced-cut";
    boundaryDistance = Math.min(score - THRESHOLDS.fastCut, THRESHOLDS.balancedCut - score);
  } else if (score < THRESHOLDS.strongCut) {
    tier = "strong";
    reason = "below-strong-cut";
    boundaryDistance = Math.min(score - THRESHOLDS.balancedCut, THRESHOLDS.strongCut - score);
  } else {
    tier = "long";
    reason = "above-strong-cut";
    boundaryDistance = score - THRESHOLDS.strongCut;
  }
  // Normalize boundary distance against the widest band so confidence stays in [0,1] and isn't
  // dominated by whichever band happens to be narrowest.
  const widestBand = Math.max(
    THRESHOLDS.fastCut,
    THRESHOLDS.balancedCut - THRESHOLDS.fastCut,
    THRESHOLDS.strongCut - THRESHOLDS.balancedCut,
    1 - THRESHOLDS.strongCut,
  );
  const confidence = clamp01(boundaryDistance / widestBand);

  return { tier, confidence, scores: { complexity, reasoning, toolBreadth, contextSize }, features, reason };
}

/** Every tier this appraiser can name, cheapest first — re-exported for callers that don't want a second import. */
export const APPRAISER_TIER_ORDER = TIER_ORDER;
