/**
 * `AGENTS.md` — the instruction file two adapters share.
 *
 * Codex and Windsurf both read it, and they deliberately share one marker block rather
 * than each claiming a private one: this is a brief addressed to whichever agent is
 * reading the repo, and two lisa sections telling it two different things would be worse
 * than one that's occasionally rewritten.
 *
 * The consequence is visible instead of hidden. Installing `codex --mode oneshot` after
 * `windsurf --mode native` rewrites the block from the native brief to the `run_qa` one,
 * and `lisa install windsurf --status` then reports "out of date" — because status is
 * derived from the plan, not self-reported.
 */

import path from "node:path";
import { renderAgentsSection, type Brief } from "./instructions.js";
import { applyMarkerBlock } from "./markers.js";
import { readIfExists, type FileChange, type InstallTarget } from "./types.js";

export const AGENTS_FILE = "AGENTS.md";

export function agentsChange(target: InstallTarget, brief: Brief): FileChange {
  const file = path.join(target.dir, AGENTS_FILE);
  const before = readIfExists(file);
  return {
    path: file,
    contents: applyMarkerBlock(before, renderAgentsSection(target, brief), file),
    before,
    label: "agent workflow (AGENTS.md section)",
  };
}
