/**
 * Windsurf adapter.
 *
 *   ~/.codeium/windsurf/mcp_config.json          — the server registration (merged).
 *                                                  Always here: Windsurf's MCP config is
 *                                                  user-global, with no per-repo form.
 *   ~/.codeium/windsurf/memories/global_rules.md — the workflow under user scope
 *   <repo>/AGENTS.md                             — the same block under project scope
 *
 * The JSON uses the standard `mcpServers` key, so the registration itself is identical to
 * Claude Code's — just at a different path.
 */

import fs from "node:fs";
import path from "node:path";
import { agentsChange, markerBlockChange } from "./agents-md.js";
import { briefFor } from "./instructions.js";
import { mcpJsonChange } from "./merge.js";
import type { DetectResult, DetectTarget, FileChange, Harness, InstallTarget } from "./types.js";

export const WINDSURF_DIR = path.join(".codeium", "windsurf");
export const WINDSURF_MCP_FILE = path.join(WINDSURF_DIR, "mcp_config.json");
/** Windsurf's global rules file — the user-scope home for the brief. */
export const WINDSURF_RULES_FILE = path.join(WINDSURF_DIR, "memories", "global_rules.md");
/** Windsurf's own rules directory — evidence of local use, not something lisa writes. */
export const WINDSURF_LOCAL_DIR = ".windsurf";

export const windsurf: Harness = {
  id: "windsurf",
  displayName: "Windsurf",
  summary: "MCP server in ~/.codeium/windsurf/mcp_config.json + a lisa section in its global rules",

  detect(target: DetectTarget): DetectResult {
    if (fs.existsSync(path.join(target.home, WINDSURF_DIR))) return { installed: true, evidence: `found ~/${WINDSURF_DIR}` };
    if (fs.existsSync(path.join(target.dir, WINDSURF_LOCAL_DIR))) return { installed: true, evidence: `found ${WINDSURF_LOCAL_DIR} in ${target.dir}` };
    return { installed: false, evidence: `no ~/${WINDSURF_DIR} directory and no ${WINDSURF_LOCAL_DIR} here` };
  },

  plan(target: InstallTarget): FileChange[] {
    const brief =
      target.scope === "user"
        ? markerBlockChange(target, briefFor(target), path.join(target.home, WINDSURF_RULES_FILE), "agent workflow (global rules section)")
        : agentsChange(target, briefFor(target));
    return [mcpJsonChange(path.join(target.home, WINDSURF_MCP_FILE), target.server), brief];
  },

  nextSteps(target: InstallTarget): string[] {
    return [
      "Windsurf → Settings → MCP Servers → Refresh (or reload the window).",
      "Check `lisa` shows up with its four tools, and enable it if it's off.",
      "Then, in Cascade, try: “run QA on staging”.",
      ...(target.scope === "user"
        ? ["That's the machine done. In any other repo, `lisa init` is all that's left — the wiring is already there."]
        : []),
    ];
  },
};
