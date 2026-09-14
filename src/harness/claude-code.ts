/**
 * Claude Code adapter.
 *
 * Two files, both project-scoped so they travel with the repo:
 *   .mcp.json                     — the server registration (merged; other servers untouched)
 *   .claude/skills/lisa/SKILL.md  — the workflow, generated from templates/workflow.md
 *
 * This is the mode already known to work end to end, which is why it goes first: it
 * validates the plan/apply split before the other adapters depend on it.
 */

import fs from "node:fs";
import path from "node:path";
import { mcpJsonChange } from "./merge.js";
import { briefFor, renderDocument } from "./instructions.js";
import { change, type DetectResult, type DetectTarget, type FileChange, type Harness, type InstallTarget } from "./types.js";

export const MCP_FILE = ".mcp.json";
export const SKILL_FILE = path.join(".claude", "skills", "lisa", "SKILL.md");

export const claudeCode: Harness = {
  id: "claude-code",
  displayName: "Claude Code",
  summary: "MCP server in .mcp.json + a lisa skill in .claude/skills/",

  detect(target: DetectTarget): DetectResult {
    const local = path.join(target.dir, ".claude");
    if (fs.existsSync(local)) return { installed: true, evidence: `found ${path.join(".claude")} in ${target.dir}` };
    if (fs.existsSync(path.join(target.dir, MCP_FILE))) return { installed: true, evidence: `found ${MCP_FILE} in ${target.dir}` };
    if (fs.existsSync(path.join(target.home, ".claude"))) return { installed: true, evidence: `found ~/.claude` };
    return { installed: false, evidence: "no .claude directory here or in your home directory" };
  },

  plan(target: InstallTarget): FileChange[] {
    return [
      mcpJsonChange(path.join(target.dir, MCP_FILE), target.server),
      change(path.join(target.dir, SKILL_FILE), renderDocument("skill.md", target, briefFor(target)), "agent workflow (skill)"),
    ];
  },

  nextSteps(): string[] {
    return [
      "Restart Claude Code (or reload the window) so it picks up .mcp.json.",
      "Claude Code will ask you to approve the `lisa` server the first time — say yes.",
      "Check it with `/mcp`, then try: “run QA on staging”.",
    ];
  },
};
