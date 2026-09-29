/**
 * `src/routing` — the opt-in mission appraiser and its fail-open gate.
 *
 * Three properties matter most here, because they're exactly the ones a routing regression
 * would violate silently: (1) the default path is byte-identical to the pre-routing fixed
 * model, (2) nothing the appraiser emits can be traced back to the mission's actual text, and
 * (3) any internal failure falls back to the fixed model rather than blocking a run.
 *
 *   npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { appraiseMission, extractFeatures } from "../src/routing/appraiser.js";
import { resolveRunModel, fixedModel } from "../src/routing/resolveModel.js";
import { TIER_SPECS, TIER_ORDER, isAtLeast, costUsd, modelForTier } from "../src/routing/ladder.js";
import { briefingFor } from "../src/core.js";
import type { ProjectConfig } from "../src/config.js";

const EASY_MISSION = "Click the login button and verify the page loads.";

const HARD_MISSION = [
  "Verify the concurrent checkout flow under race conditions.",
  "1. Log in as two different roles and start a payment session for each.",
  "2. Trigger a webhook-driven refund mid-checkout and confirm idempotency.",
  "3. Check token refresh behavior across session expiry boundaries.",
  "4. Test cross-browser rendering, accessibility (a11y), and pagination edge cases.",
  "5. Confirm rollback and reconciliation after a conflict, then run a load test.",
  "Explore the entire app thoroughly and give full coverage, end-to-end.",
].join("\n");

function baseProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "acme",
    base_url: "https://staging.acme.test",
    allowed_host: "staging.acme.test",
    credentials_env: {},
    mission: EASY_MISSION,
    ...overrides,
  };
}

describe("routing: default path (no opt-in)", () => {
  it("returns the fixed model unchanged when LISA_ROUTING is unset", () => {
    const { model, routing } = resolveRunModel({ mission: HARD_MISSION, credentialRoleCount: 0, maxTurns: 60, env: {} });
    assert.equal(model, fixedModel({}));
    assert.equal(routing.enabled, false);
    assert.equal(routing.tier, null);
    assert.equal(routing.decidedBy, "fixed");
  });

  it("is insensitive to mission content when disabled — same output for wildly different missions", () => {
    const a = resolveRunModel({ mission: EASY_MISSION, credentialRoleCount: 0, maxTurns: 60, env: {} });
    const b = resolveRunModel({ mission: HARD_MISSION, credentialRoleCount: 5, maxTurns: 5, env: {} });
    assert.deepEqual(a, b);
  });

  it("respects LISA_MODEL exactly as core.ts did before routing existed", () => {
    const { model } = resolveRunModel({ mission: EASY_MISSION, credentialRoleCount: 0, maxTurns: 60, env: { LISA_MODEL: "claude-opus-4-8" } });
    assert.equal(model, "claude-opus-4-8");
  });

  it("every falsy/garbage spelling of LISA_ROUTING is treated as off", () => {
    for (const v of ["0", "false", "no", "off", "", "nonsense"]) {
      const { routing } = resolveRunModel({ mission: EASY_MISSION, credentialRoleCount: 0, maxTurns: 60, env: { LISA_ROUTING: v } });
      assert.equal(routing.enabled, false, `LISA_ROUTING=${JSON.stringify(v)} should not enable routing`);
    }
  });
});

describe("routing: opted in", () => {
  it("accepts every truthy spelling of LISA_ROUTING", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      const { routing } = resolveRunModel({ mission: EASY_MISSION, credentialRoleCount: 0, maxTurns: 60, env: { LISA_ROUTING: v } });
      assert.equal(routing.enabled, true, `LISA_ROUTING=${JSON.stringify(v)} should enable routing`);
    }
  });

  it("picks a real, callable model id for whatever tier it lands on", () => {
    for (const mission of [EASY_MISSION, HARD_MISSION]) {
      const { model, routing } = resolveRunModel({ mission, credentialRoleCount: 1, maxTurns: 60, env: { LISA_ROUTING: "1" } });
      assert.equal(routing.decidedBy, "appraiser");
      assert.ok(routing.tier, "a tier was chosen");
      assert.equal(model, modelForTier(routing.tier!));
      assert.equal(model, TIER_SPECS[routing.tier!].model);
    }
  });

  it("routes a materially harder mission to at least as capable a tier as an easy one", () => {
    const easy = resolveRunModel({ mission: EASY_MISSION, credentialRoleCount: 0, maxTurns: 60, env: { LISA_ROUTING: "1" } });
    const hard = resolveRunModel({ mission: HARD_MISSION, credentialRoleCount: 3, maxTurns: 60, env: { LISA_ROUTING: "1", LISA_ROUTING_ALLOW_LONG: "1" } });
    assert.ok(isAtLeast(hard.routing.tier!, easy.routing.tier!), `expected ${hard.routing.tier} >= ${easy.routing.tier}`);
    assert.notEqual(hard.routing.tier, easy.routing.tier, "the hard mission should not land on the same tier as the trivial one");
  });

  it("pins one tier for the whole mission — appraising the same brief twice is deterministic", () => {
    const a = resolveRunModel({ mission: HARD_MISSION, credentialRoleCount: 2, maxTurns: 40, env: { LISA_ROUTING: "1" } });
    const b = resolveRunModel({ mission: HARD_MISSION, credentialRoleCount: 2, maxTurns: 40, env: { LISA_ROUTING: "1" } });
    assert.deepEqual(a, b);
  });
});

describe("routing: long tier opt-in gate", () => {
  it("clamps an appraised long tier down to strong without LISA_ROUTING_ALLOW_LONG", () => {
    const { model, routing } = resolveRunModel({
      mission: HARD_MISSION,
      credentialRoleCount: 3,
      maxTurns: 5, // tight budget pushes contextSize score up too
      env: { LISA_ROUTING: "1" },
    });
    if (routing.reason === "long-tier-not-opted-in-clamped-to-strong") {
      assert.equal(routing.tier, "strong");
      assert.equal(model, TIER_SPECS.strong.model);
    } else {
      // The appraiser didn't reach the long boundary on this input at all — still a valid
      // outcome, just not the one this test is targeting. Assert the invariant it implies.
      assert.notEqual(routing.tier, "long");
    }
  });

  it("allows long only with the explicit opt-in, and never otherwise", () => {
    const withOptIn = resolveRunModel({
      mission: HARD_MISSION,
      credentialRoleCount: 3,
      maxTurns: 5,
      env: { LISA_ROUTING: "1", LISA_ROUTING_ALLOW_LONG: "1" },
    });
    const withoutOptIn = resolveRunModel({
      mission: HARD_MISSION,
      credentialRoleCount: 3,
      maxTurns: 5,
      env: { LISA_ROUTING: "1" },
    });
    assert.notEqual(withoutOptIn.routing.tier, "long");
    // Whatever the without-opt-in run picked, the with-opt-in run is never *less* capable for
    // the identical mission — the opt-in only ever raises the ceiling.
    assert.ok(isAtLeast(withOptIn.routing.tier!, withoutOptIn.routing.tier!));
  });
});

describe("routing: fail-open", () => {
  it("falls back to the fixed model when the appraiser throws", () => {
    const { model, routing } = resolveRunModel({
      mission: undefined as unknown as string,
      credentialRoleCount: 0,
      maxTurns: 60,
      env: { LISA_ROUTING: "1" },
    });
    assert.equal(model, fixedModel({}));
    assert.equal(routing.enabled, true);
    assert.equal(routing.tier, null);
    assert.equal(routing.decidedBy, "fail-open-fallback");
    assert.ok(routing.error && routing.error.length > 0);
  });

  it("never blocks — resolveRunModel always returns synchronously with a usable model id", () => {
    for (const bad of [undefined, null, 42, {}] as unknown[]) {
      const { model } = resolveRunModel({ mission: bad as string, credentialRoleCount: 0, maxTurns: 60, env: { LISA_ROUTING: "1" } });
      assert.equal(typeof model, "string");
      assert.ok(model.length > 0);
    }
  });
});

describe("routing: minimal privacy-preserving metadata", () => {
  it("the routing record never contains the mission's own secret marker text", () => {
    const marker = "XQ7-UNIQUE-MARKER-not-a-real-word-9f3a";
    const mission = `${HARD_MISSION}\nAlso check the ${marker} banner renders.`;
    const { routing } = resolveRunModel({ mission, credentialRoleCount: 2, maxTurns: 60, env: { LISA_ROUTING: "1" } });
    const serialized = JSON.stringify(routing);
    assert.ok(!serialized.includes(marker), "the mission's unique text leaked into routing metadata");
    assert.ok(!serialized.toLowerCase().includes("banner"), "an ordinary mission word leaked into routing metadata");
  });

  it("features are bucketed counts/enums, never raw strings from the mission", () => {
    const features = extractFeatures(HARD_MISSION, { credentialRoleCount: 2, maxTurns: 40 });
    for (const [key, value] of Object.entries(features)) {
      assert.ok(typeof value === "number" || typeof value === "string", `${key} should be a number or an enum string`);
      if (typeof value === "string") {
        assert.ok(["short", "medium", "long"].includes(value), `${key} should be a closed-vocabulary bucket, got ${value}`);
      }
    }
  });

  it("a real Report's routing field round-trips through JSON without leaking the mission", () => {
    const marker = "ZZ-SECRET-MISSION-FRAGMENT-42";
    const { routing } = resolveRunModel({ mission: `Test the ${marker} widget`, credentialRoleCount: 0, maxTurns: 60, env: { LISA_ROUTING: "1" } });
    const report = { summary: "ok", coverage: [], bugs: [], routing };
    const onDisk = JSON.stringify(report, null, 2);
    assert.ok(!onDisk.includes(marker));
  });
});

describe("routing: appraiser scoring internals", () => {
  it("every sub-score and confidence stays within [0, 1]", () => {
    for (const mission of [EASY_MISSION, HARD_MISSION, "", "a", HARD_MISSION.repeat(5)]) {
      const a = appraiseMission(mission, { credentialRoleCount: 3, maxTurns: 10 });
      assert.ok(a.confidence >= 0 && a.confidence <= 1, `confidence out of range for ${JSON.stringify(mission.slice(0, 10))}`);
      for (const [k, v] of Object.entries(a.scores)) {
        assert.ok(v >= 0 && v <= 1, `score ${k} out of range`);
      }
    }
  });

  it("more credential roles never decreases the chosen tier's rank, all else equal", () => {
    const low = appraiseMission(HARD_MISSION, { credentialRoleCount: 0, maxTurns: 60 });
    const high = appraiseMission(HARD_MISSION, { credentialRoleCount: 5, maxTurns: 60 });
    assert.ok(isAtLeast(high.tier, low.tier));
  });

  it("a tighter turn budget never decreases the chosen tier's rank, all else equal", () => {
    const roomy = appraiseMission(HARD_MISSION, { credentialRoleCount: 2, maxTurns: 80 });
    const tight = appraiseMission(HARD_MISSION, { credentialRoleCount: 2, maxTurns: 5 });
    assert.ok(isAtLeast(tight.tier, roomy.tier));
  });
});

describe("routing: ladder", () => {
  it("TIER_ORDER is ascending by rank and covers every tier exactly once", () => {
    const ranks = TIER_ORDER.map((t) => TIER_SPECS[t].rank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    assert.deepEqual(new Set(TIER_ORDER).size, 4);
  });

  it("isAtLeast is reflexive and respects rank order", () => {
    for (const t of TIER_ORDER) assert.ok(isAtLeast(t, t));
    assert.ok(isAtLeast("strong", "fast"));
    assert.ok(!isAtLeast("fast", "strong"));
  });

  it("costUsd scales linearly with tokens and is zero at zero tokens", () => {
    assert.equal(costUsd("balanced", 0, 0), 0);
    const one = costUsd("strong", 1_000_000, 0);
    const two = costUsd("strong", 2_000_000, 0);
    assert.ok(Math.abs(two - one * 2) < 1e-9);
  });

  it("only the long tier requires opt-in", () => {
    for (const t of TIER_ORDER) {
      if (t === "long") assert.equal(TIER_SPECS[t].requiresOptIn, true);
      else assert.ok(!TIER_SPECS[t].requiresOptIn);
    }
  });
});

describe("routing: wired the way runAgent actually calls it", () => {
  it("uses briefingFor's role count and the project's mission, same as core.ts's runAgent", () => {
    const savedUser = process.env.ACME_QA_USER;
    const savedPass = process.env.ACME_QA_PASS;
    process.env.ACME_QA_USER = "test-user";
    process.env.ACME_QA_PASS = "test-pass";
    try {
      const project = baseProject({ mission: HARD_MISSION, credentials_env: { username: "ACME_QA_USER", password: "ACME_QA_PASS" } });
      const { mission, roles } = briefingFor(project);
      assert.equal(roles.length, 2, "both configured credential env vars are set in this test");
      const { routing } = resolveRunModel({ mission, credentialRoleCount: roles.length, maxTurns: 60, env: { LISA_ROUTING: "1" } });
      assert.equal(routing.decidedBy, "appraiser");
      // The persisted routing record intentionally excludes both raw role names and detailed
      // feature counts, which could otherwise fingerprint a sensitive mission.
      assert.ok(!JSON.stringify(routing).includes("ACME_QA_USER"));
      assert.equal("features" in routing, false);
      assert.equal("scores" in routing, false);
    } finally {
      if (savedUser === undefined) delete process.env.ACME_QA_USER; else process.env.ACME_QA_USER = savedUser;
      if (savedPass === undefined) delete process.env.ACME_QA_PASS; else process.env.ACME_QA_PASS = savedPass;
    }
  });
});
