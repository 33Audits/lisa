/**
 * `bench/lib` — the corpus loader, the deterministic simulator, the four strategies, the
 * metrics/bootstrap math, and the acceptance grader.
 *
 * These are unit tests over the *library*, not a full run of `bench/run-benchmark.ts` (that's
 * exercised for real by `npm run bench`, which writes the actual result artifacts). What's
 * tested here is the arithmetic and the determinism guarantee everything else depends on: same
 * corpus in, byte-identical numbers out, every time.
 *
 *   npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadCorpus, bySplit, byTier, corpusFingerprint, DEFAULT_CORPUS_PATH } from "../bench/lib/corpus.js";
import { simulateMissionOnTier, simulateAllTiers, seededUnit } from "../bench/lib/simulate.js";
import { chooseTier, STRATEGIES } from "../bench/lib/strategies.js";
import {
  isUnderRoute,
  isOverRoute,
  routeRegret,
  successRate,
  underRouteRate,
  overRouteRate,
  meanRouteRegret,
  costPerVerifiedSuccess,
  bootstrapCI,
  type MissionRun,
} from "../bench/lib/metrics.js";
import { gradeReport } from "../bench/lib/grade.js";
import { TIER_ORDER, type Tier } from "../src/routing/ladder.js";
import type { Report } from "../src/core.js";

const corpus = loadCorpus();

describe("bench: corpus", () => {
  it("loads, validates, and has both splits and all four ground-truth tiers represented", () => {
    assert.ok(corpus.missions.length >= 20, "corpus should be a real fixture, not a stub");
    const calib = bySplit(corpus.missions, "calibration");
    const holdout = bySplit(corpus.missions, "holdout");
    assert.ok(calib.length > 0 && holdout.length > 0);
    assert.equal(calib.length + holdout.length, corpus.missions.length);

    const grouped = byTier(corpus.missions);
    for (const t of TIER_ORDER) assert.ok(grouped[t].length > 0, `no missions with groundTruthTier=${t}`);
  });

  it("every mission id is unique and every mission has non-empty text", () => {
    const ids = new Set(corpus.missions.map((m) => m.id));
    assert.equal(ids.size, corpus.missions.length);
    for (const m of corpus.missions) assert.ok(m.mission.trim().length > 0, `${m.id} has empty mission text`);
  });

  it("corpusFingerprint is deterministic across repeated loads from the frozen file", () => {
    const a = corpusFingerprint(loadCorpus(DEFAULT_CORPUS_PATH));
    const b = corpusFingerprint(loadCorpus(DEFAULT_CORPUS_PATH));
    assert.equal(a, b);
  });

  it("corpusFingerprint changes if the mission set changes", () => {
    const mutated = { ...corpus, missions: corpus.missions.slice(0, -1) };
    assert.notEqual(corpusFingerprint(corpus), corpusFingerprint(mutated));
  });

  it("corpusFingerprint covers every field that affects simulation or live grading", () => {
    const first = corpus.missions[0];
    const withDifferentCostShape = {
      ...corpus,
      missions: [{ ...first, expectedSteps: first.expectedSteps + 1 }, ...corpus.missions.slice(1)],
    };
    const withDifferentAcceptance = {
      ...corpus,
      missions: [
        {
          ...first,
          acceptance: { ...first.acceptance, requiredCoverageContains: [...first.acceptance.requiredCoverageContains, "new-token"] },
        },
        ...corpus.missions.slice(1),
      ],
    };
    assert.notEqual(corpusFingerprint(corpus), corpusFingerprint(withDifferentCostShape));
    assert.notEqual(corpusFingerprint(corpus), corpusFingerprint(withDifferentAcceptance));
  });
});

describe("bench: simulate", () => {
  const mission = corpus.missions.find((m) => m.groundTruthTier === "balanced")!;

  it("a tier at or above ground truth always succeeds", () => {
    const atOrAbove: Tier[] = TIER_ORDER.filter((t) => TIER_ORDER.indexOf(t) >= TIER_ORDER.indexOf(mission.groundTruthTier));
    for (const t of atOrAbove) {
      const r = simulateMissionOnTier(mission, t);
      assert.equal(r.success, true, `${t} should always succeed on a ${mission.groundTruthTier}-rated mission`);
      assert.ok(r.capabilityGap >= 0);
    }
  });

  it("is a pure function of (missionId, tier) — repeated calls are identical", () => {
    const a = simulateMissionOnTier(mission, "fast");
    const b = simulateMissionOnTier(mission, "fast");
    assert.deepEqual(a, b);
  });

  it("never exceeds the mission's own maxTurns", () => {
    for (const t of TIER_ORDER) {
      const r = simulateMissionOnTier(mission, t);
      assert.ok(r.turnsUsed <= mission.maxTurns, `${t} used ${r.turnsUsed} > maxTurns ${mission.maxTurns}`);
    }
  });

  it("costs strictly more on a more expensive tier for the same turns/tokens shape (strong > fast, same mission)", () => {
    const fast = simulateMissionOnTier(mission, "fast");
    const strong = simulateMissionOnTier(mission, "strong");
    assert.ok(strong.costUsd > fast.costUsd);
  });

  it("simulateAllTiers covers exactly the requested tiers", () => {
    const all = simulateAllTiers(mission, TIER_ORDER);
    assert.deepEqual(Object.keys(all).sort(), [...TIER_ORDER].sort());
  });

  it("seededUnit is deterministic and spread across [0, 1)", () => {
    const a = seededUnit("k1");
    const b = seededUnit("k1");
    const c = seededUnit("k2");
    assert.equal(a, b);
    assert.ok(a >= 0 && a < 1);
    assert.notEqual(a, c);
  });
});

describe("bench: strategies", () => {
  it("fixed-strong and fixed-balanced ignore the mission entirely", () => {
    for (const m of corpus.missions) {
      assert.equal(chooseTier("fixed-strong", m, TIER_ORDER).tier, "strong");
      assert.equal(chooseTier("fixed-balanced", m, TIER_ORDER).tier, "balanced");
    }
  });

  it("routed-pinned never picks the long tier (no opt-in is set for this strategy)", () => {
    for (const m of corpus.missions) {
      const choice = chooseTier("routed-pinned", m, TIER_ORDER);
      assert.notEqual(choice.tier, "long");
      assert.ok(choice.routing, "routed-pinned should carry a routing record");
    }
  });

  it("oracle-cheapest-successful always finds a tier that actually simulated as successful", () => {
    for (const m of corpus.missions) {
      const choice = chooseTier("oracle-cheapest-successful", m, TIER_ORDER);
      assert.ok(choice.oracleSearch);
      assert.equal(choice.oracleSearch![choice.tier].success, true);
    }
  });

  it("oracle-cheapest-successful never costs more than just running the mission's own ground-truth tier", () => {
    for (const m of corpus.missions) {
      const choice = chooseTier("oracle-cheapest-successful", m, TIER_ORDER);
      const groundTruthCost = choice.oracleSearch![m.groundTruthTier].costUsd;
      const oracleCost = choice.oracleSearch![choice.tier].costUsd;
      assert.ok(oracleCost <= groundTruthCost + 1e-12, `${m.id}: oracle picked a pricier tier than its own ground truth`);
    }
  });

  it("STRATEGIES lists exactly the four required strategies", () => {
    assert.deepEqual([...STRATEGIES].sort(), ["fixed-balanced", "fixed-strong", "oracle-cheapest-successful", "routed-pinned"].sort());
  });
});

describe("bench: metrics arithmetic", () => {
  function run(overrides: Partial<MissionRun>): MissionRun {
    const cheap = simulateMissionOnTier(corpus.missions[0], "fast");
    return {
      strategy: "fixed-strong",
      missionId: "x",
      split: "holdout",
      chosenTier: "strong",
      groundTruthTier: "balanced",
      outcome: { ...cheap, tier: "strong", success: true, costUsd: 1.0 },
      oracleOutcome: { ...cheap, tier: "balanced", success: true, costUsd: 0.4 },
      ...overrides,
    };
  }

  it("isUnderRoute / isOverRoute read tier rank, not cost", () => {
    assert.equal(isUnderRoute(run({ chosenTier: "fast", groundTruthTier: "strong" })), true);
    assert.equal(isOverRoute(run({ chosenTier: "fast", groundTruthTier: "strong" })), false);
    assert.equal(isOverRoute(run({ chosenTier: "strong", groundTruthTier: "fast" })), true);
    assert.equal(isUnderRoute(run({ chosenTier: "balanced", groundTruthTier: "balanced" })), false);
    assert.equal(isOverRoute(run({ chosenTier: "balanced", groundTruthTier: "balanced" })), false);
  });

  it("routeRegret is cost(actual) - cost(oracle) on success, and the full cost on failure", () => {
    const succeeded = run({ outcome: { ...run({}).outcome, success: true, costUsd: 1.0 }, oracleOutcome: { ...run({}).oracleOutcome, costUsd: 0.4 } });
    assert.ok(Math.abs(routeRegret(succeeded) - 0.6) < 1e-9);

    const failed = run({ outcome: { ...run({}).outcome, success: false, costUsd: 1.0 }, oracleOutcome: { ...run({}).oracleOutcome, costUsd: 0.4 } });
    assert.ok(Math.abs(routeRegret(failed) - 1.0) < 1e-9);
  });

  it("routeRegret is never negative on a successful run, across the whole corpus for every strategy", () => {
    for (const strategy of STRATEGIES) {
      for (const m of corpus.missions) {
        const choice = chooseTier(strategy, m, TIER_ORDER);
        const oracle = chooseTier("oracle-cheapest-successful", m, TIER_ORDER);
        const outcome = simulateMissionOnTier(m, choice.tier);
        const oracleOutcome = simulateMissionOnTier(m, oracle.tier);
        const rec: MissionRun = { strategy, missionId: m.id, split: m.split, chosenTier: choice.tier, groundTruthTier: m.groundTruthTier, outcome, oracleOutcome };
        if (outcome.success) assert.ok(routeRegret(rec) >= -1e-9, `${strategy}/${m.id}: negative regret on a successful run`);
      }
    }
  });

  it("successRate / underRouteRate / overRouteRate / meanRouteRegret / costPerVerifiedSuccess match hand computation on 3 records", () => {
    const records: MissionRun[] = [
      run({ outcome: { ...run({}).outcome, success: true, costUsd: 1.0 }, oracleOutcome: { ...run({}).oracleOutcome, costUsd: 0.5 }, chosenTier: "strong", groundTruthTier: "balanced" }),
      run({ outcome: { ...run({}).outcome, success: false, costUsd: 0.1 }, oracleOutcome: { ...run({}).oracleOutcome, costUsd: 0.5 }, chosenTier: "fast", groundTruthTier: "strong" }),
      run({ outcome: { ...run({}).outcome, success: true, costUsd: 0.5 }, oracleOutcome: { ...run({}).oracleOutcome, costUsd: 0.5 }, chosenTier: "balanced", groundTruthTier: "balanced" }),
    ];
    assert.ok(Math.abs(successRate(records) - 2 / 3) < 1e-9);
    assert.ok(Math.abs(underRouteRate(records) - 1 / 3) < 1e-9); // record 2: fast chosen, strong needed
    assert.ok(Math.abs(overRouteRate(records) - 1 / 3) < 1e-9); // record 1: strong chosen, balanced needed
    // regret: rec1 = 1.0-0.5=0.5; rec2 (failed) = 0.1-0=0.1; rec3 = 0.5-0.5=0
    assert.ok(Math.abs(meanRouteRegret(records) - (0.5 + 0.1 + 0) / 3) < 1e-9);
    // cost-per-verified-success includes the failed attempt's cost: (1.0+0.1+0.5)/2
    assert.ok(Math.abs((costPerVerifiedSuccess(records) ?? NaN) - 0.8) < 1e-9);
  });

  it("costPerVerifiedSuccess is null, not NaN or 0, when nothing succeeded", () => {
    const records = [run({ outcome: { ...run({}).outcome, success: false } })];
    assert.equal(costPerVerifiedSuccess(records), null);
  });
});

describe("bench: bootstrap CI", () => {
  const holdout = bySplit(corpus.missions, "holdout");
  const records: MissionRun[] = holdout.map((m) => {
    const choice = chooseTier("routed-pinned", m, TIER_ORDER);
    const oracle = chooseTier("oracle-cheapest-successful", m, TIER_ORDER);
    return {
      strategy: "routed-pinned",
      missionId: m.id,
      split: m.split,
      chosenTier: choice.tier,
      groundTruthTier: m.groundTruthTier,
      outcome: simulateMissionOnTier(m, choice.tier),
      oracleOutcome: simulateMissionOnTier(m, oracle.tier),
    };
  });

  it("is byte-identical across repeated calls with the same seedKey (deterministic resampling)", () => {
    const a = bootstrapCI(records, meanRouteRegret, { seedKey: "test-seed" });
    const b = bootstrapCI(records, meanRouteRegret, { seedKey: "test-seed" });
    assert.deepEqual(a, b);
  });

  it("the point estimate equals the plain statistic, independent of the resampling seed", () => {
    const a = bootstrapCI(records, meanRouteRegret, { seedKey: "seed-a" });
    const b = bootstrapCI(records, meanRouteRegret, { seedKey: "seed-b" });
    assert.equal(a!.point, meanRouteRegret(records));
    assert.equal(a!.point, b!.point);
  });

  it("lo <= point <= hi", () => {
    const ci = bootstrapCI(records, meanRouteRegret, { seedKey: "bounds" });
    assert.ok(ci!.lo <= ci!.point + 1e-9);
    assert.ok(ci!.point <= ci!.hi + 1e-9);
  });

  it("refuses to produce a CI below the minimum sample size", () => {
    const ci = bootstrapCI(records.slice(0, 2), meanRouteRegret, { seedKey: "too-small" });
    assert.equal(ci, null);
  });
});

describe("bench: grade", () => {
  const mission = corpus.missions[0];

  it("passes a report that satisfies every acceptance criterion", () => {
    const report: Report = { summary: "Covered it.", coverage: [mission.acceptance.requiredCoverageContains[0] ?? "homepage"], bugs: [] };
    const g = gradeReport(mission, report);
    assert.equal(g.passed, true);
    assert.deepEqual(g.reasons, []);
  });

  it("fails and names the reason for an empty summary", () => {
    const report: Report = { summary: "", coverage: [mission.acceptance.requiredCoverageContains[0] ?? "homepage"], bugs: [] };
    const g = gradeReport(mission, report);
    assert.equal(g.passed, false);
    assert.equal(g.checks.hasSummary, false);
    assert.ok(g.reasons.some((r) => r.includes("summary")));
  });

  it("fails on a bug count outside the mission's expected range", () => {
    const tooMany = Array.from({ length: mission.acceptance.maxBugs + 5 }, (_, i) => ({
      title: `bug ${i}`, severity: "minor" as const, page: "/x", repro_steps: ["a"], expected: "e", actual: "a",
    }));
    const report: Report = { summary: "ok", coverage: [mission.acceptance.requiredCoverageContains[0] ?? "homepage"], bugs: tooMany };
    const g = gradeReport(mission, report);
    assert.equal(g.passed, false);
    assert.equal(g.checks.bugCountInRange, false);
  });

  it("fails when required coverage tokens are missing", () => {
    const report: Report = { summary: "ok", coverage: ["something-unrelated"], bugs: [] };
    const g = gradeReport(mission, report);
    assert.equal(g.passed, false);
    assert.equal(g.checks.coverageMentionsRequired, false);
  });

  it("fails on an invalid severity value", () => {
    const report = {
      summary: "ok",
      coverage: [mission.acceptance.requiredCoverageContains[0] ?? "homepage"],
      bugs: [{ title: "b", severity: "catastrophic" as any, page: "/x", repro_steps: ["a"], expected: "e", actual: "a" }],
    } as Report;
    const g = gradeReport(mission, report);
    assert.equal(g.passed, false);
    assert.equal(g.checks.severitiesValid, false);
  });
});
