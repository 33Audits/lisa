/**
 * Codex CLI adapter.
 *
 *   ~/.codex/config.toml   — `[mcp_servers.lisa]`, merged (see toml.ts). Always here:
 *                            Codex keeps MCP servers in one user-global TOML file, so this
 *                            half was never able to travel through a repo.
 *   ~/.codex/AGENTS.md     — the workflow under user scope, in a marker block
 *   <repo>/AGENTS.md       — the same block under project scope, committed so a teammate
 *                            who clones the repo gets the instructions without installing
 */

import fs from "node:fs";
import path from "node:path";
import { AGENTS_FILE, agentsChange, markerBlockChange } from "./agents-md.js";
import { briefFor } from "./instructions.js";
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
  summary: "MCP server in ~/.codex/config.toml + a lisa section in ~/.codex/AGENTS.md",

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
    const brief =
      target.scope === "user"
        ? markerBlockChange(target, briefFor(target), path.join(target.home, CODEX_DIR, AGENTS_FILE), "agent workflow (global AGENTS.md section)")
        : agentsChange(target, briefFor(target));
    return [{ path: file, contents, before, label: "MCP server registration" }, brief];
  },

  nextSteps(target: InstallTarget): string[] {
    return [
      "Start a new `codex` session — it reads ~/.codex/config.toml at launch.",
      "Codex will ask to approve the `lisa` server's tools the first time — say yes.",
      "Then try: “run QA on staging”.",
      ...(target.scope === "user"
        ? ["That's the machine done. In any other repo, `lisa init` is all that's left — the wiring is already there."]
        : []),
    ];
  },
};
