/**
 * How the harness should launch lisa's MCP server.
 *
 * Order matters:
 *   1. `--command` — the escape hatch, wins over everything.
 *   2. `lisa-mcp` on PATH — what a global install gives you, and the most stable thing
 *      to bake into a config file that may outlive this node version.
 *   3. `node <packageRoot>/dist/mcp-server.js` — the repo-checkout case.
 *
 * `--config` is written only when it has to be. A registration that names an absolute
 * config path is pinned to one project *and* one machine — which is why the committed
 * `.mcp.json` a teammate cloned never worked for them. When the server can find the
 * right config on its own, the flag is left off and discovery does the work:
 *
 *   user scope      always omitted — one registration serves every repo, and the harness
 *                   spawns the server with the repo as its cwd
 *   project scope   omitted when discovery from the harness directory lands on this very
 *                   config (the ordinary case), absolute otherwise (`--dir` elsewhere, or
 *                   a global config with no project file to find)
 */

import fs from "node:fs";
import path from "node:path";
import { findProjectConfig, UserError, type RuntimeContext } from "../paths.js";
import { packageRoot } from "../templates.js";
import { DEFAULT_INSTALL_SCOPE, DEFAULT_TOOLS_MODE, type InstallScope, type ServerCommand, type ToolsMode } from "./types.js";

const MCP_BIN = process.platform === "win32" ? "lisa-mcp.cmd" : "lisa-mcp";

/** First executable named `bin` on PATH, or null. */
export function whichSync(bin: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() || st.isSymbolicLink()) return candidate;
    } catch {
      // not here; keep looking
    }
  }
  return null;
}

/** Split a user-supplied command string, honouring simple quoting. */
export function splitCommand(raw: string): string[] {
  const parts = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((p) => (/^["'].*["']$/.test(p) ? p.slice(1, -1) : p));
}

/**
 * Would a server started in `dir` discover this exact config on its own?
 *
 * `findProjectConfig` is the same walk `resolveContext` performs, so asking it here is
 * asking the real question rather than re-deriving the answer from path shapes.
 */
export function configIsDiscoverableFrom(ctx: RuntimeContext, dir: string): boolean {
  return findProjectConfig(dir) === ctx.configPath;
}

export function resolveServerCommand(
  ctx: RuntimeContext,
  override?: string,
  mode: ToolsMode = DEFAULT_TOOLS_MODE,
  scope: InstallScope = DEFAULT_INSTALL_SCOPE,
  dir: string = ctx.root,
): ServerCommand {
  // `--tools` is written explicitly even for oneshot, which is also the server's default.
  // A registration that names its mode is a registration whose behaviour doesn't change
  // under someone else's later decision about what the default should be.
  const needsConfig = scope === "project" && !configIsDiscoverableFrom(ctx, dir);
  const args = needsConfig ? ["--config", ctx.configPath, "--tools", mode] : ["--tools", mode];

  if (override) {
    const [command, ...rest] = splitCommand(override);
    if (!command) throw new UserError("--command was empty.");
    return { command, args: [...rest, ...args] };
  }

  if (whichSync(MCP_BIN)) return { command: "lisa-mcp", args };

  const bundled = path.join(packageRoot(), "dist", "mcp-server.js");
  if (fs.existsSync(bundled)) return { command: "node", args: [bundled, ...args] };

  throw new UserError(
    `Can't work out how the harness should start lisa's MCP server.\n\n` +
      `  \`${MCP_BIN}\` isn't on PATH, and there's no build at ${bundled}.\n\n` +
      `  Install lisa globally (\`npm i -g lisa-cli\`), or run \`npm run build\` in the\n` +
      `  lisa checkout, or pass the command yourself: \`lisa install <harness> --command "..."\``,
  );
}
