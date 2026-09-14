#!/usr/bin/env node
/**
 * MCP server: exposes lisa to any MCP-speaking harness (Claude Code, Codex, Cursor, ...).
 *
 * `lisa install <harness>` writes the registration for you and bakes in an absolute
 * --config path. Run standalone:
 *   lisa-mcp --config /abs/path/to/lisa.config.yaml
 *
 * Tool names stay action-shaped (`run_qa`, not `run_lisa`) — an agent picks tools by
 * reading their names, and the brand tells it nothing about what the tool does.
 *
 * NOTE: stdout is the MCP transport. Never console.log here — use console.error.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runProject, loadLastReport, resetState } from "./core.js";
import { loadProjects, findProject } from "./config.js";
import { resolveContext, type RuntimeContext } from "./paths.js";
import { loadEnvFile } from "./env.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const configIdx = process.argv.indexOf("--config");
const CONFIG = configIdx >= 0 ? process.argv[configIdx + 1] : undefined;

/**
 * Resolved per call, not at boot: a harness spawns us with its own cwd, and a config
 * problem should reach the agent as a readable tool error rather than killing the server.
 *
 * `.env` beside the config is loaded here too — a harness-spawned process inherits the
 * harness's environment, which is not where the project's test credentials live.
 */
function ctx(): RuntimeContext {
  const c = resolveContext(CONFIG);
  loadEnvFile(c.root);
  return c;
}

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(e as Error)?.message ?? String(e)}` }], isError: true });

const server = new McpServer({ name: "lisa", version });

server.registerTool(
  "list_qa_projects",
  { description: "List the projects lisa knows how to test, with their staging URLs and missions." },
  async () => {
    try {
      const projects = loadProjects(ctx()).map((p) => ({ name: p.name, base_url: p.base_url, mission: p.mission }));
      return text(JSON.stringify(projects, null, 2));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "run_qa",
  {
    description:
      "Run an autonomous exploratory QA session against a project's staging environment. Launches a headless browser, " +
      "clicks through the configured mission, and returns a structured bug report (new bugs vs. previously-known bugs, " +
      "with repro steps, expected/actual, evidence, and screenshot paths). Takes 1–5 minutes. " +
      "Set post_to_slack=true to also notify the team channel.",
    inputSchema: {
      project: z.string().describe("Project name from list_qa_projects"),
      post_to_slack: z.boolean().default(false).describe("Post new bugs to the Slack QA channel"),
      mission_override: z.string().optional().describe("Replace the configured mission with a focused one, e.g. to re-verify a specific fix"),
    },
  },
  async ({ project, post_to_slack, mission_override }) => {
    try {
      const c = ctx();
      const p = findProject(c, project);
      if (mission_override) p.mission = mission_override;
      const log: string[] = [];
      const report = await runProject(p, c, {
        slack: post_to_slack,
        onEvent: (e) => { if (e.type === "tool_call") log.push(`${e.name} ${JSON.stringify(e.args).slice(0, 120)}`); },
      });
      console.error(`[lisa] ${project}: ${report.new_bugs?.length ?? 0} new, ${report.known_bugs?.length ?? 0} known`);
      return text(JSON.stringify({ ...report, action_log: log }, null, 2));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_last_qa_report",
  { description: "Return the most recent QA report for a project without re-running the agent.", inputSchema: { project: z.string() } },
  async ({ project }) => {
    try {
      const r = loadLastReport(ctx(), project);
      return text(r ? JSON.stringify(r, null, 2) : `No report yet for ${project}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "reset_qa_state",
  { description: "Forget previously-seen bugs for a project so the next run reports everything as new (e.g. after a big fix).", inputSchema: { project: z.string() } },
  async ({ project }) => {
    try {
      resetState(ctx(), project);
      return text(`Cleared seen-bug state for ${project}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[lisa] MCP server ready (v${version})`);
