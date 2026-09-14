/**
 * Claude Code adapter.
 *
 * Two files, and the pair moves together with the scope:
 *
 *   user     ~/.claude.json                  — `mcpServers.lisa`, merged
 *            ~/.claude/skills/lisa/SKILL.md  — the workflow, as a personal skill
 *   project  .mcp.json                       — same registration, committed
 *            .claude/skills/lisa/SKILL.md    — same workflow, committed
 *
 * `~/.claude.json` is Claude Code's own state file — it holds session history and
 * per-project state alongside `mcpServers`. The merge is surgical and refuses outright
 * to touch a file it could not parse, which matters far more here than it does for a
 * `.mcp.json` that exists only to hold servers.
 */

import fs from "node:fs";
import path from "node:path";
import { mcpJsonChange } from "./merge.js";
import { briefFor, renderDocument } from "./instructions.js";
import { change, type DetectResult, type DetectTarget, type FileChange, type Harness, type InstallTarget } from "./types.js";

export const MCP_FILE = ".mcp.json";
/** Claude Code's user-level state file, which also holds user-scope MCP servers. */
export const USER_MCP_FILE = ".claude.json";
export const SKILL_FILE = path.join(".claude", "skills", "lisa", "SKILL.md");

export const claudeCode: Harness = {
  id: "claude-code",
  displayName: "Claude Code",
  summary: "MCP server + a lisa skill, in ~/.claude by default or committed with --project",

  detect(target: DetectTarget): DetectResult {
    const local = path.join(target.dir, ".claude");
    if (fs.existsSync(local)) return { installed: true, evidence: `found ${path.join(".claude")} in ${target.dir}` };
    if (fs.existsSync(path.join(target.dir, MCP_FILE))) return { installed: true, evidence: `found ${MCP_FILE} in ${target.dir}` };
    if (fs.existsSync(path.join(target.home, ".claude"))) return { installed: true, evidence: `found ~/.claude` };
    return { installed: false, evidence: "no .claude directory here or in your home directory" };
  },

  plan(target: InstallTarget): FileChange[] {
    const base = target.scope === "user" ? target.home : target.dir;
    const mcpFile = target.scope === "user" ? USER_MCP_FILE : MCP_FILE;
    return [
      mcpJsonChange(path.join(base, mcpFile), target.server),
      change(path.join(base, SKILL_FILE), renderDocument("skill.md", target, briefFor(target)), "agent workflow (skill)"),
    ];
  },

  nextSteps(target: InstallTarget): string[] {
    if (target.scope === "project") {
      return [
        "Restart Claude Code (or reload the window) so it picks up .mcp.json.",
        "Claude Code will ask you to approve the `lisa` server the first time — say yes.",
        "Check it with `/mcp`, then try: “run QA on staging”.",
      ];
    }
    return [
      // ~/.claude.json is Claude Code's live state file, not a config it only reads. A
      // running instance holds it in memory and rewrites it on exit, which would drop a
      // registration written underneath it — so quitting is the step, not reloading.
      "Quit Claude Code fully and start it again — it rewrites ~/.claude.json on exit, so a reload isn't enough.",
      "It'll ask you to approve the `lisa` server the first time — say yes.",
      "Check it with `/mcp`, then try: “run QA on staging”.",
      "That's the machine done. In any other repo, `lisa init` is all that's left — the wiring is already there.",
    ];
  },
};
