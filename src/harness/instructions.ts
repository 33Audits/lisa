/**
 * Agent instructions, rendered from one source per *brief*.
 *
 * There are two briefs, not one template with a swappable invocation line. The `native`
 * variant differs in more than naming: the agent drives the browser itself rather than
 * waiting on one long tool call, so it needs the QA procedure, the destructive-action
 * rules, the severity guide, and a note about what `qa_read_page` costs its own context —
 * none of which the `mcp` brief has any use for. Parameterising all of that would have
 * produced a template nobody could read.
 *
 * What *is* shared is the second half — triage → fix → re-verify. That half is about
 * *this repo's code*, not about how QA ran, so it reads nearly identically in both.
 * Also shared: the wrapper templates and the per-install substitution, since the paths
 * in a brief point at the *user's* repo rather than anything hardcoded.
 */

import path from "node:path";
import { readTemplate, render } from "../templates.js";
import type { InstallTarget } from "./types.js";

/** Which set of instructions the harness can actually act on. */
export type Brief = "mcp" | "native";

const WORKFLOW_TEMPLATE: Record<Brief, string> = { mcp: "workflow.md", native: "workflow-native.md" };

/**
 * The brief that matches the tool surface being registered. One expression, in one place,
 * so an adapter can't wire `--tools native` and then hand the agent `run_qa` instructions.
 */
export function briefFor(target: InstallTarget): Brief {
  return target.mode === "native" ? "native" : "mcp";
}

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

/**
 * How the brief describes what config it is talking to.
 *
 * A user-scope brief is read in repos that did not exist when it was written, so it must
 * not name one. It describes the discovery rule instead — which is exactly what the
 * server does at runtime, since a user-scope registration carries no `--config`.
 */
function wiringSentence(target: InstallTarget): string {
  return target.scope === "user"
    ? "lisa is installed for your whole account: it reads the `lisa.config.yaml` belonging to whichever repo you're working in."
    : `lisa is wired to \`${forDisplay(target.ctx.configPath, target.dir)}\`.`;
}

/**
 * The workflow body: sections at `##`, no title (the wrapper supplies one).
 *
 * Paths render relative to the *config root* rather than the install directory. For a
 * project install those are the same directory; for a user install it keeps the artifact
 * path generic (`.lisa/artifacts/screenshots`) instead of baking in whichever repo
 * happened to be current when the machine was set up.
 */
export function renderWorkflow(target: InstallTarget, brief: Brief = "mcp"): string {
  return render(readTemplate(WORKFLOW_TEMPLATE[brief]), {
    artifacts: forDisplay(target.ctx.shotsDir, target.ctx.root),
    wiring: wiringSentence(target),
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
