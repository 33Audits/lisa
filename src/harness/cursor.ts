/**
 * Cursor adapter.
 *
 *   ~/.cursor/mcp.json      — the server registration under user scope
 *   .cursor/mcp.json        — the same registration under project scope
 *   .cursor/rules/lisa.mdc  — the workflow, as an agent-requested rule, always in the repo
 *
 * The odd one out on scope. Cursor's MCP config has a home-directory form, so the
 * registration installs once per machine like everywhere else — but Cursor's rules are a
 * per-repo directory, and its user-level rules are plain text typed into Settings rather
 * than a file lisa could own. So a `user` install still writes the rule into the repo,
 * and `scopeNote` says so rather than letting "wired" quietly mean something different
 * here than it does for the other three.
 *
 * `alwaysApply: false` in the rule's frontmatter is deliberate: the brief is several
 * hundred words of QA procedure that is irrelevant to every request that isn't about QA.
 * Cursor pulls an agent-requested rule in when the `description` matches what the user
 * asked for, which is exactly the trigger behaviour the Claude Code skill gets for free.
 */

import fs from "node:fs";
import path from "node:path";
import { mcpJsonChange } from "./merge.js";
import { briefFor, renderDocument } from "./instructions.js";
import {
  change,
  type DetectResult,
  type DetectTarget,
  type FileChange,
  type Harness,
  type InstallScope,
  type InstallTarget,
} from "./types.js";

export const CURSOR_DIR = ".cursor";
export const CURSOR_MCP_FILE = path.join(CURSOR_DIR, "mcp.json");
export const CURSOR_RULE_FILE = path.join(CURSOR_DIR, "rules", "lisa.mdc");

export const cursor: Harness = {
  id: "cursor",
  displayName: "Cursor",
  summary: "MCP server in ~/.cursor/mcp.json + a lisa rule in the repo's .cursor/rules/",

  detect(target: DetectTarget): DetectResult {
    if (fs.existsSync(path.join(target.dir, CURSOR_DIR))) return { installed: true, evidence: `found ${CURSOR_DIR} in ${target.dir}` };
    if (fs.existsSync(path.join(target.home, CURSOR_DIR))) return { installed: true, evidence: `found ~/${CURSOR_DIR}` };
    return { installed: false, evidence: `no ${CURSOR_DIR} directory here or in your home directory` };
  },

  plan(target: InstallTarget): FileChange[] {
    const mcpBase = target.scope === "user" ? target.home : target.dir;
    return [
      mcpJsonChange(path.join(mcpBase, CURSOR_MCP_FILE), target.server),
      // Always the repo: Cursor has no user-global rules *file*. See the header note.
      change(path.join(target.dir, CURSOR_RULE_FILE), renderDocument("cursor-rule.mdc", target, briefFor(target)), "agent workflow (rule)"),
    ];
  },

  scopeNote(scope: InstallScope): string | null {
    return scope === "user"
      ? "Cursor has no user-global rules file, so the lisa rule still lands in this repo's .cursor/rules/ — run `lisa install cursor` once per repo to get it, or paste the brief into Settings → Rules yourself."
      : null;
  },

  nextSteps(target: InstallTarget): string[] {
    const source = target.scope === "user" ? "~/.cursor/mcp.json" : ".cursor/mcp.json";
    return [
      `Reload the Cursor window so it picks up ${source}.`,
      "Settings → Tools & MCP: enable the `lisa` server (Cursor starts new servers disabled).",
      "Then, in Agent mode, try: “run QA on staging”.",
    ];
  },
};
