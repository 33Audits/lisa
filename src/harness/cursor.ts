/**
 * Cursor adapter.
 *
 *   .cursor/mcp.json        — the server registration (same document shape as .mcp.json)
 *   .cursor/rules/lisa.mdc  — the workflow, as an agent-requested rule
 *
 * Both project-scoped, so this is the other adapter whose wiring travels through git.
 *
 * `alwaysApply: false` in the rule's frontmatter is deliberate: the brief is several
 * hundred words of QA procedure that is irrelevant to every request that isn't about QA.
 * Cursor pulls an agent-requested rule in when the `description` matches what the user
 * asked for, which is exactly the trigger behaviour the Claude Code skill gets for free.
 */

import fs from "node:fs";
import path from "node:path";
import { mcpJsonChange } from "./merge.js";
import { renderDocument } from "./instructions.js";
import { change, type DetectResult, type DetectTarget, type FileChange, type Harness, type InstallTarget } from "./types.js";

export const CURSOR_DIR = ".cursor";
export const CURSOR_MCP_FILE = path.join(CURSOR_DIR, "mcp.json");
export const CURSOR_RULE_FILE = path.join(CURSOR_DIR, "rules", "lisa.mdc");

export const cursor: Harness = {
  id: "cursor",
  displayName: "Cursor",
  summary: "MCP server in .cursor/mcp.json + a lisa rule in .cursor/rules/",

  detect(target: DetectTarget): DetectResult {
    if (fs.existsSync(path.join(target.dir, CURSOR_DIR))) return { installed: true, evidence: `found ${CURSOR_DIR} in ${target.dir}` };
    if (fs.existsSync(path.join(target.home, CURSOR_DIR))) return { installed: true, evidence: `found ~/${CURSOR_DIR}` };
    return { installed: false, evidence: `no ${CURSOR_DIR} directory here or in your home directory` };
  },

  plan(target: InstallTarget): FileChange[] {
    return [
      mcpJsonChange(path.join(target.dir, CURSOR_MCP_FILE), target.server),
      change(path.join(target.dir, CURSOR_RULE_FILE), renderDocument("cursor-rule.mdc", target, "mcp"), "agent workflow (rule)"),
    ];
  },

  nextSteps(): string[] {
    return [
      "Reload the Cursor window so it picks up .cursor/mcp.json.",
      "Settings → Tools & MCP: enable the `lisa` server (Cursor starts new servers disabled).",
      "Then, in Agent mode, try: “run QA on staging”.",
    ];
  },
};
