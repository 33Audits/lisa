#!/usr/bin/env node
/**
 * The benchmark. Compares four strategies for choosing a model tier per QA mission —
 * `fixed-strong`, `fixed-balanced`, `routed-pinned` (Lisa's real opt-in appraiser), and
 * `oracle-cheapest-successful` (a cheating upper bound: the cheapest tier that a full
 * per-tier search shows would have succeeded) — over the frozen corpus in
 * `bench/corpus/missions.json`.
 *
 * Two evidence lanes, always clearly tagged and never mixed:
 *
 *   - "deterministic-harness" — the bulk of this report. Pure math (`bench/lib/simulate.ts`)
 *     plus one real-Playwright, real-Chromium, no-LLM smoke check (`bench/lib/browser-smoke.ts`).
 *     Runs anywhere, with no API key, and reproduces bit-for-bit — the script self-checks this
 *     below before writing anything.
 *   - "live-model" — real `runAgent` calls against a local fixture app with a real Anthropic
 *     API key. Only runs when `ANTHROPIC_API_KEY` is set; otherwise the report says so plainly
 *     instead of omitting the section.
 *
 * Usage:
 *   npm run bench                  deterministic lane only (default; no API key needed)
 *   npm run bench -- --live        also attempt the live-model lane (needs ANTHROPIC_API_KEY)
 *
 * Writes bench/results/latest.json and bench/results/latest.md.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCorpus, bySplit, corpusFingerprint, type MissionSpec, type Split } from "./lib/corpus.js";
import { simulateMissionOnTier, type SimResult } from "./lib/simulate.js";
import { chooseTier, STRATEGIES, type StrategyChoice, type StrategyName } from "./lib/strategies.js";
import {
  successRate,
  underRouteRate,
  overRouteRate,
  meanRouteRegret,
  costPerVerifiedSuccess,
  totalCostUsd,
  bootstrapCI,
  bootstrapCostPerVerifiedSuccess,
  type MissionRun,
  type BootstrapResult,
} from "./lib/metrics.js";
import { runBrowserSmoke, type BrowserSmokeResult } from "./lib/browser-smoke.js";
import { runLiveLane, type LiveLaneResult } from "./lib/live-lane.js";
import { TIER_ORDER, type Tier } from "../src/routing/ladder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "results");

// ---------- build the per-strategy, per-mission run records ----------

function buildRecordsForStrategy(strategy: StrategyName, missions: MissionSpec[]): MissionRun[] {
  return missions.map((m) => {
    const choice = chooseTier(strategy, m, TIER_ORDER);
    const oracle = choice.oracleSearch ? choice : chooseTier("oracle-cheapest-successful", m, TIER_ORDER);
    const outcome = simulateMissionOnTier(m, choice.tier);
    const oracleOutcome = oracle.oracleSearch![oracle.tier];
    return {
      strategy,
      missionId: m.id,
      split: m.split,
      chosenTier: choice.tier,
      groundTruthTier: m.groundTruthTier,
      outcome,
      oracleOutcome,
    };
  });
}

function buildAllRecords(missions: MissionSpec[]): Record<StrategyName, MissionRun[]> {
  const out = {} as Record<StrategyName, MissionRun[]>;
  for (const s of STRATEGIES) out[s] = buildRecordsForStrategy(s, missions);
  return out;
}

// ---------- metrics per strategy, split by calibration/holdout ----------

interface StrategyMetrics {
  n: number;
  successRate: number;
  underRouteRate: number;
  overRouteRate: number;
  meanRouteRegret: number;
  costPerVerifiedSuccessUsd: number | null;
  totalCostUsd: number;
}

interface StrategyMetricsWithCI extends StrategyMetrics {
  ci90: {
    successRate: BootstrapResult | null;
    underRouteRate: BootstrapResult | null;
    overRouteRate: BootstrapResult | null;
    meanRouteRegret: BootstrapResult | null;
    costPerVerifiedSuccessUsd: BootstrapResult | null;
  };
}

function computeMetrics(records: MissionRun[]): StrategyMetrics {
  return {
    n: records.length,
    successRate: successRate(records),
    underRouteRate: underRouteRate(records),
    overRouteRate: overRouteRate(records),
    meanRouteRegret: meanRouteRegret(records),
    costPerVerifiedSuccessUsd: costPerVerifiedSuccess(records),
    totalCostUsd: totalCostUsd(records),
  };
}

function computeMetricsWithCI(records: MissionRun[], seedPrefix: string): StrategyMetricsWithCI {
  const base = computeMetrics(records);
  const seedKey = (name: string) => `${seedPrefix}|${name}`;
  return {
    ...base,
    ci90: {
      successRate: bootstrapCI(records, successRate, { seedKey: seedKey("successRate") }),
      underRouteRate: bootstrapCI(records, underRouteRate, { seedKey: seedKey("underRouteRate") }),
      overRouteRate: bootstrapCI(records, overRouteRate, { seedKey: seedKey("overRouteRate") }),
      meanRouteRegret: bootstrapCI(records, meanRouteRegret, { seedKey: seedKey("meanRouteRegret") }),
      costPerVerifiedSuccessUsd: bootstrapCostPerVerifiedSuccess(records, { seedKey: seedKey("costPerVerifiedSuccess") }),
    },
  };
}

/** Ground-truth tier (rows) vs chosen tier (columns), for one strategy over one split. */
function confusionMatrix(records: MissionRun[]): Record<Tier, Record<Tier, number>> {
  const m = {} as Record<Tier, Record<Tier, number>>;
  for (const t of TIER_ORDER) m[t] = { fast: 0, balanced: 0, strong: 0, long: 0 };
  for (const r of records) m[r.groundTruthTier][r.chosenTier]++;
  return m;
}

// ---------- report assembly ----------

interface StrategyReport {
  strategy: StrategyName;
  calibration: StrategyMetrics;
  holdout: StrategyMetricsWithCI;
  holdoutConfusion: Record<Tier, Record<Tier, number>>;
}

interface BenchmarkReport {
  generatedAt: string;
  corpusVersion: string;
  corpusFingerprint: string;
  missionCounts: { total: number; calibration: number; holdout: number };
  strategies: StrategyReport[];
  browserSmoke: BrowserSmokeResult;
  liveLane: LiveLaneResult;
  determinismSelfCheck: { passed: boolean; note: string };
  methodologyNote: string;
}

const METHODOLOGY_NOTE =
  "Costs, turns, and success/failure for every (mission, tier) pair below come from " +
  "bench/lib/simulate.ts — a deterministic, seeded function of mission ground truth and tier " +
  "capability, NOT a live model call and NOT fabricated report content. Route regret, " +
  "under-route rate, over-route rate, and cost-per-verified-success are computed over the " +
  "frozen holdout split only (calibration numbers are shown separately, as a diagnostic). " +
  "90% confidence intervals are bootstrap resamples of the holdout mission set, seeded " +
  "deterministically per metric so re-running this script reproduces the exact same interval. " +
  "See bench/README.md for the full methodology, the corpus construction rationale, and the " +
  "jev-auto isolation note.";

function buildReport(browserSmoke: BrowserSmokeResult, liveLane: LiveLaneResult): BenchmarkReport {
  const corpus = loadCorpus();
  const calibrationMissions = bySplit(corpus.missions, "calibration");
  const holdoutMissions = bySplit(corpus.missions, "holdout");

  const calibRecords = buildAllRecords(calibrationMissions);
  const holdoutRecords = buildAllRecords(holdoutMissions);

  const strategies: StrategyReport[] = STRATEGIES.map((strategy) => ({
    strategy,
    calibration: computeMetrics(calibRecords[strategy]),
    holdout: computeMetricsWithCI(holdoutRecords[strategy], `holdout|${corpusFingerprint(corpus)}|${strategy}`),
    holdoutConfusion: confusionMatrix(holdoutRecords[strategy]),
  }));

  return {
    generatedAt: new Date().toISOString(),
    corpusVersion: corpus.corpus_version,
    corpusFingerprint: corpusFingerprint(corpus),
    missionCounts: { total: corpus.missions.length, calibration: calibrationMissions.length, holdout: holdoutMissions.length },
    strategies,
    browserSmoke,
    liveLane,
    determinismSelfCheck: { passed: false, note: "overwritten below" },
    methodologyNote: METHODOLOGY_NOTE,
  };
}

/**
 * Rebuild the whole deterministic-harness computation a second time and diff it against the
 * first, field-for-field except the two fields that are allowed to vary (`generatedAt` and
 * `browserSmoke`/`liveLane`, which touch real wall-clock I/O). This is the "deterministic
 * acceptance check" for the benchmark's own numbers: if this ever fails, something in the
 * simulator or metrics stopped being a pure function, and the run aborts rather than shipping
 * numbers that wouldn't reproduce.
 */
function determinismSelfCheck(first: BenchmarkReport): { passed: boolean; note: string } {
  const second = buildReport(first.browserSmoke, first.liveLane);
  const strip = (r: BenchmarkReport) => ({ ...r, generatedAt: "", determinismSelfCheck: null as any });
  const a = JSON.stringify(strip(first));
  const b = JSON.stringify(strip(second));
  if (a === b) return { passed: true, note: "recomputing every strategy/metric/CI a second time produced byte-identical JSON" };
  return { passed: false, note: "recomputation diverged — the simulator or metrics are not a pure function of the corpus" };
}

// ---------- markdown rendering ----------

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number | null) => (n === null ? "n/a (no successes)" : `$${n.toFixed(4)}`);
const ciStr = (ci: BootstrapResult | null, fmt: (n: number) => string) => (ci ? `[${fmt(ci.lo)}, ${fmt(ci.hi)}]` : "n/a (< min sample size)");

function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`# Lisa mission-routing benchmark`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Corpus: \`${report.corpusVersion}\` (fingerprint \`${report.corpusFingerprint}\`) — ${report.missionCounts.total} missions (${report.missionCounts.calibration} calibration / ${report.missionCounts.holdout} holdout)`);
  lines.push("");
  lines.push(`> ${report.methodologyNote}`);
  lines.push("");

  lines.push(`## Determinism self-check`);
  lines.push("");
  lines.push(report.determinismSelfCheck.passed ? `✅ PASSED — ${report.determinismSelfCheck.note}` : `❌ FAILED — ${report.determinismSelfCheck.note}`);
  lines.push("");

  lines.push(`## Headline results (holdout split, deterministic-harness evidence)`);
  lines.push("");
  lines.push(`| Strategy | n | Success rate | Under-route | Over-route | Mean route regret (90% CI) | Cost / verified success (90% CI) | Total cost |`);
  lines.push(`|---|---:|---:|---:|---:|---|---|---:|`);
  for (const s of report.strategies) {
    const h = s.holdout;
    lines.push(
      `| ${s.strategy} | ${h.n} | ${pct(h.successRate)} | ${pct(h.underRouteRate)} | ${pct(h.overRouteRate)} | ` +
        `$${h.meanRouteRegret.toFixed(4)} ${ciStr(h.ci90.meanRouteRegret, (n) => `$${n.toFixed(4)}`)} | ` +
        `${usd(h.costPerVerifiedSuccessUsd)} ${ciStr(h.ci90.costPerVerifiedSuccessUsd, (n) => `$${n.toFixed(4)}`)} | ` +
        `$${h.totalCostUsd.toFixed(4)} |`,
    );
  }
  lines.push("");
  lines.push(
    "`oracle-cheapest-successful` is a cheating upper bound (it searches every tier's simulated outcome per mission with perfect " +
      "hindsight) — no real strategy can beat it; it exists to show how much headroom is left. Route regret uses the oracle as its " +
      "baseline; cost-per-verified-success is each strategy's own total attempted spend divided by its verified successes.",
  );
  lines.push("");
  lines.push(
    "**Read cost-per-verified-success together with success rate, not alone.** The numerator includes every attempted run, including " +
      "failed attempts, so under-routing is charged rather than discarded. Even so, a low-success strategy can still have a deceptively " +
      "low ratio if its failed attempts are very cheap; the success-rate launch gate remains mandatory.",
  );
  lines.push("");

  lines.push(`## Calibration split (diagnostic only — not the headline numbers)`);
  lines.push("");
  lines.push(`| Strategy | n | Success rate | Under-route | Over-route | Mean route regret | Cost / verified success |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const s of report.strategies) {
    const c = s.calibration;
    lines.push(`| ${s.strategy} | ${c.n} | ${pct(c.successRate)} | ${pct(c.underRouteRate)} | ${pct(c.overRouteRate)} | $${c.meanRouteRegret.toFixed(4)} | ${usd(c.costPerVerifiedSuccessUsd)} |`);
  }
  lines.push("");

  lines.push(`## Routing confusion (holdout): ground-truth tier vs chosen tier`);
  lines.push("");
  for (const s of report.strategies) {
    lines.push(`### ${s.strategy}`);
    lines.push("");
    lines.push(`| ground truth \\ chosen | fast | balanced | strong | long |`);
    lines.push(`|---|---:|---:|---:|---:|`);
    for (const truth of TIER_ORDER) {
      const row = s.holdoutConfusion[truth];
      lines.push(`| **${truth}** | ${row.fast} | ${row.balanced} | ${row.strong} | ${row.long} |`);
    }
    lines.push("");
  }

  lines.push(`## Real-browser smoke check (deterministic-harness, no LLM)`);
  lines.push("");
  lines.push(`Method: \`${report.browserSmoke.method}\`. Ran at ${report.browserSmoke.ranAt}.`);
  lines.push("");
  lines.push(
    "The pass/fail `checks` below are deterministic across runs. The raw `detail` log lines in the JSON artifact embed the fixture " +
      "server's OS-assigned localhost port, which is different every run by design (an ephemeral port, not a routing or simulation " +
      "input) — expect those lines, and only those lines, to differ between two runs of `npm run bench`.",
  );
  lines.push("");
  lines.push(report.browserSmoke.passed ? "✅ PASSED — Lisa's real Playwright primitives detected both seeded defects in the fixture app." : "❌ FAILED");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(report.browserSmoke.checks, null, 2));
  lines.push("```");
  lines.push("");

  lines.push(`## Live-model lane`);
  lines.push("");
  if (!report.liveLane.executed) {
    lines.push(`Not executed: ${report.liveLane.reason}`);
  } else {
    lines.push(`Executed against the local fixture app with real Anthropic credentials. Sample size: ${report.liveLane.sampleSize}.`);
    lines.push("");
    lines.push(`| Mission | Passed | Tier | Model |`);
    lines.push(`|---|---|---|---|`);
    for (const r of report.liveLane.records) {
      lines.push(`| ${r.missionId} | ${r.passed ? "✅" : "❌"} | ${r.tier ?? "n/a"} | ${r.model} |`);
    }
  }
  lines.push("");

  lines.push(`## Launch decision`);
  lines.push("");
  lines.push(
    `❌ **NOT ELIGIBLE FOR PRODUCTION ROUTING YET.** The deterministic lane validates the appraiser, accounting, ` +
      `pinning, and browser harness, but it does not establish model-quality non-inferiority. Promotion requires repeated ` +
      `live runs of fixed-strong, fixed-balanced, and routed-pinned on the untouched holdout corpus with identical app resets ` +
      `and objective acceptance checks.`,
  );
  lines.push("");

  lines.push(`## Limitations`);
  lines.push("");
  lines.push(`- The deterministic-harness lane models mission *outcomes* from ground-truth capability tiers with a seeded success-probability curve — it does not run a real model and does not fabricate report content (bug titles, repro steps). See \`bench/lib/simulate.ts\`.`);
  lines.push(`- \`routed-pinned\` in this benchmark runs with \`LISA_ROUTING=1\` and no long-tier opt-in (the cautious default) — missions whose ground truth is \`long\` under-route by construction under this strategy. That's a real, disclosed property of the recommended default config, not a bug in the benchmark.`);
  lines.push(`- The corpus is 30 hand-authored missions. Confidence intervals reflect that sample size (bootstrap over ~15-21 holdout missions per stratum split) — treat point estimates as more informative than tight interval bounds.`);
  lines.push(`- Display pricing in \`src/routing/ladder.ts\` mirrors jev-auto's own disclaimer: illustrative, not a billing source of truth.`);
  lines.push("");

  return lines.join("\n");
}

// ---------- main ----------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantsLive = args.includes("--live");

  console.error("[bench] running real-browser smoke check (Playwright, no LLM)...");
  const browserSmoke = await runBrowserSmoke();
  console.error(`[bench] browser smoke: ${browserSmoke.passed ? "PASSED" : "FAILED"}`);

  let liveLane: LiveLaneResult;
  if (wantsLive) {
    console.error("[bench] --live requested, attempting live-model lane...");
    const corpus = loadCorpus();
    const sample = bySplit(corpus.missions, "holdout").filter((m) => m.groundTruthTier === "fast" || m.groundTruthTier === "balanced").slice(0, 2);
    liveLane = await runLiveLane(sample, { routed: true });
  } else {
    liveLane = { executed: false, reason: "--live was not passed; the deterministic lane is the default and requires no credentials.", sampleSize: 0, records: [] };
  }
  console.error(`[bench] live-model lane: ${liveLane.executed ? `ran ${liveLane.sampleSize} mission(s)` : `skipped (${liveLane.reason})`}`);

  console.error("[bench] computing strategy metrics over the frozen corpus...");
  const report = buildReport(browserSmoke, liveLane);
  report.determinismSelfCheck = determinismSelfCheck(report);
  console.error(`[bench] determinism self-check: ${report.determinismSelfCheck.passed ? "PASSED" : "FAILED"}`);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const jsonPath = path.join(RESULTS_DIR, "latest.json");
  const mdPath = path.join(RESULTS_DIR, "latest.md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(report));
  console.error(`[bench] wrote ${jsonPath}`);
  console.error(`[bench] wrote ${mdPath}`);

  if (!report.determinismSelfCheck.passed) {
    console.error("[bench] ABORTING with non-zero exit: determinism self-check failed.");
    process.exitCode = 1;
    return;
  }
  if (!browserSmoke.passed) {
    console.error("[bench] WARNING: real-browser smoke check failed — Lisa's own browser primitives may be broken.");
    process.exitCode = 1;
    return;
  }
  if (wantsLive && !liveLane.executed) {
    console.error("[bench] --live was requested but no live-model evidence was produced.");
    process.exitCode = 1;
    return;
  }
  console.error("[bench] done.");
}

main().catch((e) => {
  console.error("[bench] fatal:", e?.stack ?? e);
  process.exitCode = 1;
});
