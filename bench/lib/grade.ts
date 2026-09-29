/**
 * Deterministic acceptance checks for a real `Report` — the grader the live-model lane uses.
 *
 * This is the piece that keeps "live-model evidence" honest: it never asks an LLM whether a
 * run passed, it checks the submitted `Report` object against the mission's own frozen
 * acceptance criteria with plain string/array comparisons. Same grader, whether the report
 * came from a real `runAgent` call against the fixture app or was hand-built in a test.
 */

import type { Report } from "../../src/core.js";
import type { MissionSpec } from "./corpus.js";

export interface GradeResult {
  passed: boolean;
  checks: {
    hasSummary: boolean;
    bugCountInRange: boolean;
    coverageMentionsRequired: boolean;
    severitiesValid: boolean;
  };
  reasons: string[];
}

const VALID_SEVERITIES = new Set(["critical", "major", "minor"]);

export function gradeReport(mission: MissionSpec, report: Report): GradeResult {
  const reasons: string[] = [];

  const hasSummary = typeof report.summary === "string" && report.summary.trim().length > 0;
  if (!hasSummary) reasons.push("summary is empty");

  const bugCount = report.bugs?.length ?? 0;
  const bugCountInRange = bugCount >= mission.acceptance.minBugs && bugCount <= mission.acceptance.maxBugs;
  if (!bugCountInRange) {
    reasons.push(`bug count ${bugCount} outside expected [${mission.acceptance.minBugs}, ${mission.acceptance.maxBugs}]`);
  }

  const coverageText = (report.coverage ?? []).join(" ").toLowerCase();
  const coverageMentionsRequired = mission.acceptance.requiredCoverageContains.every((token) => coverageText.includes(token.toLowerCase()));
  if (!coverageMentionsRequired) reasons.push("coverage does not mention every required token");

  const severitiesValid = (report.bugs ?? []).every((b) => VALID_SEVERITIES.has(b.severity));
  if (!severitiesValid) reasons.push("a bug has an invalid severity");

  const checks = { hasSummary, bugCountInRange, coverageMentionsRequired, severitiesValid };
  const passed = Object.values(checks).every(Boolean);
  return { passed, checks, reasons };
}
