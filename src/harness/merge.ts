/**
 * Merge helpers for files lisa does not own.
 *
 * `.mcp.json` holds the user's *other* MCP servers. Registration has to be a surgical
 * edit of one key, preserving everything else — including the file's existing
 * indentation, because a reformatted diff in someone's repo is a bug report waiting
 * to happen.
 *
 * A malformed file is a hard stop, never a silent overwrite: the alternative is
 * destroying a config we failed to read.
 */

import { UserError } from "../paths.js";
import { readIfExists, type FileChange, type ServerCommand } from "./types.js";

/** Infer the indent width of an existing JSON document; 2 when there's nothing to go on. */
export function detectIndent(text: string): number {
  for (const line of text.split("\n")) {
    const m = /^([ ]+)\S/.exec(line);
    if (m) return m[1].length;
  }
  return 2;
}

/**
 * Apply `mutate` to the parsed document and re-serialise it, keeping the original
 * indentation. `before === null` starts from an empty object.
 */
export function mergeJson(before: string | null, mutate: (doc: Record<string, any>) => void, file: string): string {
  let doc: Record<string, any> = {};
  let indent = 2;

  if (before !== null && before.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(before);
    } catch (e) {
      throw new UserError(
        `${file} is not valid JSON, so lisa won't touch it.\n` +
          `  ${(e as Error).message}\n` +
          `  Fix the file, then re-run \`lisa install\`.`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UserError(`${file} should contain a JSON object at the top level, but it doesn't. lisa won't overwrite it.`);
    }
    doc = parsed as Record<string, any>;
    indent = detectIndent(before);
  }

  mutate(doc);
  return JSON.stringify(doc, null, indent) + "\n";
}

/**
 * Set `doc.mcpServers.<name>` to `entry`, leaving every other server alone.
 *
 * Returns false and changes nothing when `mcpServers` exists but isn't an object —
 * the caller turns that into a readable error rather than clobbering it.
 */
export function setMcpServer(doc: Record<string, any>, name: string, entry: unknown): boolean {
  const existing = doc.mcpServers;
  if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) return false;
  doc.mcpServers = { ...(existing ?? {}), [name]: entry };
  return true;
}

/**
 * Register lisa in an `{ "mcpServers": { … } }` file. Claude Code's `.mcp.json` and
 * Cursor's `.cursor/mcp.json` are the same document under two names, so they share this.
 */
export function mcpJsonChange(file: string, server: ServerCommand, label = "MCP server registration"): FileChange {
  const before = readIfExists(file);
  const contents = mergeJson(
    before,
    (doc) => {
      if (!setMcpServer(doc, "lisa", { command: server.command, args: server.args })) {
        throw new UserError(`${file} has an \`mcpServers\` key that isn't an object. Fix it by hand, then re-run \`lisa install\`.`);
      }
    },
    file,
  );
  return { path: file, contents, before, label };
}
