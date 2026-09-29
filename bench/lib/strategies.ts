/**
 * The four strategies the benchmark compares. Each maps one `MissionSpec` to the tier that
 * strategy would run the mission on — the actual routing decision, made through the same
 * production code path `runAgent` uses (`resolveRunModel`) for the routed strategy, so this
 * benchmark exercises the real appraiser, not a re-implementation of it.
 */

import { resolveRunModel, type RoutingMeta, type Tier } from "../../src/routing/index.js";
import { simulateAllTiers, type SimResult } from "./simulate.js";
import type { MissionSpec } from "./corpus.js";

export const STRATEGIES = ["fixed-strong", "fixed-balanced", "routed-pinned", "oracle-cheapest-successful"] as const;
export type StrategyName = (typeof STRATEGIES)[number];

export interface StrategyChoice {
  strategy: StrategyName;
  tier: Tier;
  /** Present only for `routed-pinned` — the real, content-free routing record `runAgent` would have produced. */
  routing?: RoutingMeta;
  /** Present only for `oracle-cheapest-successful` — every tier's simulated outcome it searched to pick the cheapest one that succeeded. */
  oracleSearch?: Record<Tier, SimResult>;
}

/**
 * `routed-pinned` runs with `LISA_ROUTING=1` and *no* long-tier opt-in — the configuration a
 * cautious operator would actually turn on first, since the long tier "bills extra usage
 * credits" (mirroring jev-auto's own `JEV_ALLOW_FABLE` gate). That choice is a benchmark
 * subject, not a limitation to hide: missions whose ground truth is `long` will under-route
 * under this strategy by construction, and the report says so rather than quietly opting the
 * benchmark into a config real deployments wouldn't default to.
 */
const ROUTED_ENV = { LISA_ROUTING: "1" };

export function chooseTier(strategy: StrategyName, mission: MissionSpec, allTiers: Tier[]): StrategyChoice {
  switch (strategy) {
    case "fixed-strong":
      return { strategy, tier: "strong" };
    case "fixed-balanced":
      return { strategy, tier: "balanced" };
    case "routed-pinned": {
      const { routing } = resolveRunModel({
        mission: mission.mission,
        credentialRoleCount: mission.credentialRoleCount,
        maxTurns: mission.maxTurns,
        env: ROUTED_ENV,
      });
      // routing.tier is only ever null on fail-open, which resolves to the fixed model
      // (claude-sonnet-5, the `balanced` tier's model) — attribute it to that tier so cost
      // accounting stays tier-shaped even on the fallback path.
      return { strategy, tier: routing.tier ?? "balanced", routing };
    }
    case "oracle-cheapest-successful": {
      const search = simulateAllTiers(mission, allTiers);
      const successful = allTiers.filter((t) => search[t].success);
      const pool = successful.length ? successful : allTiers;
      const cheapest = pool.reduce((best, t) => (search[t].costUsd < search[best].costUsd ? t : best), pool[0]);
      return { strategy, tier: cheapest, oracleSearch: search };
    }
  }
}
