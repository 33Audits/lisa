/**
 * Generic adapter — the universal fallback.
 *
 *   <repo>/AGENTS.md   — the CLI brief, in a marker block
 *
 * No MCP config, because the premise is a harness that doesn't speak MCP. What it does
 * have is a shell tool, so the brief tells it to run `lisa run <project> --json` and parse
 * the JSON. This is the tier that makes "works with any agent harness" true rather than
 * marketing: the CLI is the contract, MCP is the enhancement.
 *
 * It gets the `cli` brief, not the `mcp` one — see instructions.ts for why those are two
 * templates rather than one with a swappable invocation line.
 */

import fs from "node:fs";
import path from "node:path";
import { agentsChange, AGENTS_FILE } from "./agents-md.js";
import { whichSync } from "./command.js";
import type { DetectResult, DetectTarget, FileChange, Harness, InstallTarget } from "./types.js";

const LISA_BIN = process.platform === "win32" ? "lisa.cmd" : "lisa";

export const generic: Harness = {
  id: "generic",
  displayName: "Generic (CLI only)",
  summary: `a lisa section in ${AGENTS_FILE} telling any shell-capable agent to run \`lisa run --json\``,

  /**
   * There is nothing to detect: this adapter targets the convention, not a product. So it
   * reports on the file it would write into, and says plainly that it applies regardless.
   */
  detect(target: DetectTarget): DetectResult {
    if (fs.existsSync(path.join(target.dir, AGENTS_FILE))) return { installed: true, evidence: `found ${AGENTS_FILE} in ${target.dir}` };
    return { installed: false, evidence: `no ${AGENTS_FILE} yet — this adapter works with any agent that can run shell commands` };
  },

  plan(target: InstallTarget): FileChange[] {
    return [agentsChange(target, "cli")];
  },

  nextSteps(): string[] {
    const steps = [
      `Point your agent at ${AGENTS_FILE} (most read it automatically from the repo root).`,
      "Give it a shell tool, then try: “run QA on staging and fix what it finds”.",
    ];
    if (!whichSync(LISA_BIN)) {
      steps.unshift(
        `Put \`lisa\` on PATH — the brief tells the agent to run it by name (\`npm i -g lisa-cli\`, or \`npm link\` in this checkout).`,
      );
    }
    return steps;
  },
};
