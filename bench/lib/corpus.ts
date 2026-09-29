/**
 * Loader + shape for the frozen mission corpus (`bench/corpus/missions.json`).
 *
 * Read with `fs.readFileSync` + `JSON.parse` rather than a native ESM JSON import — this repo
 * targets NodeNext module resolution under `"type": "module"`, where a JSON import needs an
 * import-attribute syntax whose stability varies across the Node 20.x line this project
 * supports (`engines.node: >=20`). `fs` has no such version edge.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Tier } from "../../src/routing/index.js";

export type Split = "calibration" | "holdout";

export interface MissionAcceptance {
  minBugs: number;
  maxBugs: number;
  requiredCoverageContains: string[];
}

export interface MissionSpec {
  id: string;
  split: Split;
  /**
   * Human QA-lead judgment call: the minimum tier that can do this mission justice. This is
   * the benchmark's ground truth — it feeds the oracle strategy and the under/over-route
   * metrics. It is never given to the appraiser under test; the appraiser only ever sees
   * `mission`, `credentialRoleCount`, and `maxTurns`, exactly like a real run.
   */
  groundTruthTier: Tier;
  credentialRoleCount: number;
  maxTurns: number;
  /** Ground-truth complexity inputs to the deterministic cost/turns simulator — not shown to the appraiser. */
  expectedSteps: number;
  expectedPages: number;
  mission: string;
  acceptance: MissionAcceptance;
}

export interface Corpus {
  corpus_version: string;
  frozen: boolean;
  freeze_note: string;
  splits: Split[];
  tiers: Tier[];
  missions: MissionSpec[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORPUS_PATH = path.join(__dirname, "..", "corpus", "missions.json");

const VALID_SPLITS = new Set<Split>(["calibration", "holdout"]);
const VALID_TIERS = new Set<Tier>(["fast", "balanced", "strong", "long"]);

function validateCorpus(c: Corpus, sourcePath: string): void {
  if (!Array.isArray(c.missions) || c.missions.length === 0) {
    throw new Error(`corpus at ${sourcePath} has no missions`);
  }
  const seen = new Set<string>();
  for (const m of c.missions) {
    if (seen.has(m.id)) throw new Error(`corpus at ${sourcePath}: duplicate mission id ${m.id}`);
    seen.add(m.id);
    if (!VALID_SPLITS.has(m.split)) throw new Error(`mission ${m.id}: invalid split "${m.split}"`);
    if (!VALID_TIERS.has(m.groundTruthTier)) throw new Error(`mission ${m.id}: invalid groundTruthTier "${m.groundTruthTier}"`);
    if (!m.mission || !m.mission.trim()) throw new Error(`mission ${m.id}: empty mission text`);
    if (m.maxTurns <= 0) throw new Error(`mission ${m.id}: maxTurns must be positive`);
  }
  const hasCalibration = c.missions.some((m) => m.split === "calibration");
  const hasHoldout = c.missions.some((m) => m.split === "holdout");
  if (!hasCalibration || !hasHoldout) {
    throw new Error(`corpus at ${sourcePath} must have at least one mission in each split (calibration/holdout)`);
  }
}

export function loadCorpus(corpusPath: string = DEFAULT_CORPUS_PATH): Corpus {
  const raw = JSON.parse(fs.readFileSync(corpusPath, "utf-8")) as Corpus;
  validateCorpus(raw, corpusPath);
  return raw;
}

export function bySplit(missions: MissionSpec[], split: Split): MissionSpec[] {
  return missions.filter((m) => m.split === split);
}

export function byTier(missions: MissionSpec[]): Record<Tier, MissionSpec[]> {
  const out: Record<Tier, MissionSpec[]> = { fast: [], balanced: [], strong: [], long: [] };
  for (const m of missions) out[m.groundTruthTier].push(m);
  return out;
}

/**
 * A short, stable content hash — lets a benchmark report assert exactly which corpus content
 * it ran against, independent of `corpus_version` (a human-maintained label that could drift
 * from the file without anyone noticing).
 */
export function corpusFingerprint(c: Corpus): string {
  const canonical = JSON.stringify({
    corpus_version: c.corpus_version,
    missions: c.missions.slice().sort((a, b) => a.id.localeCompare(b.id)),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
