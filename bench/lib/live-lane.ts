/**
 * The live-model lane: runs a small sample of real missions through the real `runAgent` /
 * `resolveRunModel` code path, against the local fixture app, using real Anthropic credentials.
 *
 * Gated on an Anthropic API key or bearer auth token being present — this repo, and the benchmark's primary output,
 * must work without one (see `bench/README.md`). When the key is absent, `runLiveLane` returns
 * immediately with `executed: false` and the reason, and the caller records that honestly in
 * the report rather than silently omitting the section. When a key *is* present, this is real
 * execution: real Anthropic billing, a real browser, the actual production `runAgent` function
 * — nothing here is simulated, and every record it produces is tagged `evidence: "live-model"`
 * so it can never be confused with the deterministic-harness numbers that make up the bulk of
 * the benchmark.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent, type ProjectConfig, type Report } from "../../src/core.js";
import { contextFor } from "../../src/paths.js";
import { startFixtureServer } from "./fixture-server.js";
import { gradeReport } from "./grade.js";
import type { MissionSpec } from "./corpus.js";

export interface LiveLaneRecord {
  missionId: string;
  passed: boolean;
  reasons: string[];
  routingEnabled: boolean;
  tier: string | null;
  model: string;
  evidence: "live-model";
}

export interface LiveLaneResult {
  executed: boolean;
  reason: string;
  sampleSize: number;
  records: LiveLaneRecord[];
}

const NOT_EXECUTED = (reason: string): LiveLaneResult => ({ executed: false, reason, sampleSize: 0, records: [] });

/**
 * `sampleMissions` should be small (a handful) — this spends real API credits per call, once
 * per mission, for the whole `runAgent` browser/tool loop.
 */
export async function runLiveLane(sampleMissions: MissionSpec[], opts: { routed: boolean } = { routed: true }): Promise<LiveLaneResult> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return NOT_EXECUTED("neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set — the live-model lane does not run without production credentials, by design.");
  }
  if (!sampleMissions.length) {
    return NOT_EXECUTED("no sample missions were provided");
  }

  const fixture = await startFixtureServer();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-bench-live-"));
  const configPath = path.join(tmpRoot, "lisa.config.yaml");
  fs.writeFileSync(configPath, "projects: []\n");
  const ctx = contextFor(configPath, "project");

  const savedRouting = process.env.LISA_ROUTING;
  if (opts.routed) process.env.LISA_ROUTING = "1";
  else delete process.env.LISA_ROUTING;

  const records: LiveLaneRecord[] = [];
  try {
    for (const mission of sampleMissions) {
      const project: ProjectConfig = {
        name: `bench-live-${mission.id}`,
        base_url: fixture.url,
        allowed_host: fixture.host,
        credentials_env: {},
        mission: mission.mission,
      };
      const report: Report = await runAgent(project, ctx, {});
      const grade = gradeReport(mission, report);
      records.push({
        missionId: mission.id,
        passed: grade.passed,
        reasons: grade.reasons,
        routingEnabled: report.routing?.enabled ?? false,
        tier: report.routing?.tier ?? null,
        model: report.routing?.model ?? "unknown",
        evidence: "live-model",
      });
    }
    return { executed: true, reason: "ran against the local fixture app with real Anthropic credentials", sampleSize: sampleMissions.length, records };
  } finally {
    if (savedRouting === undefined) delete process.env.LISA_ROUTING;
    else process.env.LISA_ROUTING = savedRouting;
    await fixture.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
