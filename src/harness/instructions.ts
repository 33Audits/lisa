/**
 * Agent instructions, rendered from one source per *brief*.
 *
 * There are two briefs, not one template with a swappable invocation line. The CLI-only
 * variant differs in more than naming: there is no `mission_override` argument (it's a
 * `--mission` flag), Slack is opt-*out* rather than opt-in, and exit codes matter because
 * the agent is reading a shell result instead of a tool response. Parameterising all of
 * that would have produced a template nobody could read.
 *
 * What *is* shared is the procedure (run → triage → fix → re-verify), the wrapper
 * templates, and the per-install substitution: the paths in the brief point at the
 * *user's* repo, so they're rendered per target rather than hardcoded.
 */

import path from "node:path";
import { readTemplate, render } from "../templates.js";
import type { InstallTarget } from "./types.js";

/** Which set of instructions the harness can actually act on. */
export type Brief = "mcp" | "cli";

const WORKFLOW_TEMPLATE: Record<Brief, string> = { mcp: "workflow.md", cli: "workflow-cli.md" };

/** The skill/rule `description:` — natural-language triggers, not brand words. */
export const SKILL_DESCRIPTION =
  'Run the autonomous QA agent against a project\'s staging environment, triage the bugs it finds, fix them in this codebase, and re-verify. Use when the user asks to "run QA", "QA this", "check staging for bugs", or "see if the fix worked".';

/** Display a path relative to the user's repo when it lives inside it. */
function forDisplay(file: string, dir: string): string {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

/**
 * Push every heading down `by` levels, leaving fenced code alone.
 *
 * The workflow templates start at `##` because they're the whole document in a skill or
 * a Cursor rule. Inside `AGENTS.md` they're one `##` section of someone else's file, so
 * their sections have to become `###` or the block reads as a sibling of the user's own
 * headings rather than part of ours.
 */
export function shiftHeadings(md: string, by: number): string {
  let inFence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : line.replace(/^(#{1,5})(\s)/, (_m, h: string, s: string) => "#".repeat(h.length + by) + s);
    })
    .join("\n");
}

/** The workflow body: sections at `##`, no title (the wrapper supplies one). */
export function renderWorkflow(target: InstallTarget, brief: Brief = "mcp"): string {
  return render(readTemplate(WORKFLOW_TEMPLATE[brief]), {
    artifacts: forDisplay(target.ctx.shotsDir, target.dir),
    config: forDisplay(target.ctx.configPath, target.dir),
  });
}

/** A standalone document: frontmatter wrapper + `# ` title + the workflow. */
export function renderDocument(template: string, target: InstallTarget, brief: Brief = "mcp"): string {
  return render(readTemplate(template), { description: SKILL_DESCRIPTION, workflow: renderWorkflow(target, brief) });
}

/** The body of lisa's `AGENTS.md` marker block: one `##` section, subsections at `###`. */
export function renderAgentsSection(target: InstallTarget, brief: Brief): string {
  return render(readTemplate("agents-section.md"), { workflow: shiftHeadings(renderWorkflow(target, brief), 1) });
}
