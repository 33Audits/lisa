/**
 * Codex CLI adapter.
 *
 *   ~/.codex/config.toml   — `[mcp_servers.lisa]`, merged (see toml.ts)
 *   <repo>/AGENTS.md       — the workflow, in a marker block
 *
 * Split scope, unlike Claude Code: Codex keeps MCP servers in one user-global TOML file,
 * so the registration can't travel through the repo. `AGENTS.md` can and does — which is
 * why the brief is project-scoped even though the wiring isn't. A teammate who clones the
 * repo gets the instructions and has to run `lisa install codex` once for the server.
 */

import fs from "node:fs";
import path from "node:path";
import { agentsChange } from "./agents-md.js";
import { setTomlTable } from "./toml.js";
import { whichSync } from "./command.js";
import { readIfExists, type DetectResult, type DetectTarget, type FileChange, type Harness, type InstallTarget } from "./types.js";

export const CODEX_DIR = ".codex";
export const CODEX_CONFIG = "config.toml";

function configPath(home: string): string {
  return path.join(home, CODEX_DIR, CODEX_CONFIG);
}

export const codex: Harness = {
  id: "codex",
  displayName: "Codex CLI",
  summary: "MCP server in ~/.codex/config.toml + a lisa section in AGENTS.md",

  detect(target: DetectTarget): DetectResult {
    if (fs.existsSync(configPath(target.home))) return { installed: true, evidence: `found ~/${CODEX_DIR}/${CODEX_CONFIG}` };
    if (fs.existsSync(path.join(target.home, CODEX_DIR))) return { installed: true, evidence: `found ~/${CODEX_DIR}` };
    if (whichSync("codex")) return { installed: true, evidence: "`codex` is on your PATH" };
    return { installed: false, evidence: `no ~/${CODEX_DIR} directory and no \`codex\` on PATH` };
  },

  plan(target: InstallTarget): FileChange[] {
    const file = configPath(target.home);
    const before = readIfExists(file);
    const contents = setTomlTable(
      before,
      ["mcp_servers", "lisa"],
      { command: target.server.command, args: target.server.args },
      file,
    );
    return [{ path: file, contents, before, label: "MCP server registration" }, agentsChange(target, "mcp")];
  },

  nextSteps(): string[] {
    return [
      "Start a new `codex` session — it reads ~/.codex/config.toml at launch.",
      "Codex will ask to approve the `lisa` server's tools the first time — say yes.",
      "Then try: “run QA on staging”.",
    ];
  },
};
