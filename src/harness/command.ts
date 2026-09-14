/**
 * How the harness should launch lisa's MCP server.
 *
 * Order matters:
 *   1. `--command` — the escape hatch, wins over everything.
 *   2. `lisa-mcp` on PATH — what a global install gives you, and the most stable thing
 *      to bake into a config file that may outlive this node version.
 *   3. `node <packageRoot>/dist/mcp-server.js` — the repo-checkout case.
 *
 * The `--config` path is always absolute. The harness spawns the server with *its* cwd,
 * which is not necessarily the project, so config discovery cannot be relied on.
 */

import fs from "node:fs";
import path from "node:path";
import { UserError, type RuntimeContext } from "../paths.js";
import { packageRoot } from "../templates.js";
import type { ServerCommand } from "./types.js";

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

export function resolveServerCommand(ctx: RuntimeContext, override?: string): ServerCommand {
  const args = ["--config", ctx.configPath];

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
