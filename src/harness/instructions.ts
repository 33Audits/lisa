/**
 * Agent instructions, rendered from one source.
 *
 * `templates/workflow.md` is the whole brief; every harness gets the same one, with the
 * invocation paragraph swapped for whatever that harness actually offers the agent. It
 * is written for a harness holding lisa's MCP tools — the CLI-only variant arrives with
 * the generic adapter.
 *
 * The paths in it are absolute-or-relative to the *user's* repo, not ours, so they're
 * substituted per install rather than hardcoded.
 */

import path from "node:path";
import { readTemplate, render } from "../templates.js";
import type { InstallTarget } from "./types.js";

/** The skill `description:` — natural-language triggers, not brand words. */
export const SKILL_DESCRIPTION =
  'Run the autonomous QA agent against a project\'s staging environment, triage the bugs it finds, fix them in this codebase, and re-verify. Use when the user asks to "run QA", "QA this", "check staging for bugs", or "see if the fix worked".';

const MCP_INVOCATION =
  "You have MCP tools from the `lisa` server: `list_qa_projects`, `run_qa`, `get_last_qa_report`, `reset_qa_state`.";

/** Display a path relative to the user's repo when it lives inside it. */
function forDisplay(file: string, dir: string): string {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

export function renderWorkflow(target: InstallTarget, invocation: string = MCP_INVOCATION): string {
  return render(readTemplate("workflow.md"), {
    invocation,
    artifacts: forDisplay(target.ctx.shotsDir, target.dir),
    config: forDisplay(target.ctx.configPath, target.dir),
  });
}
