/**
 * A surgical TOML table writer for `~/.codex/config.toml`.
 *
 * This is not a TOML parser and deliberately so. The file holds the user's model
 * settings, approval policy, sandbox rules, and their *other* MCP servers, usually with
 * comments explaining why. Parsing it and re-serialising would hand back a
 * semantically-equal file that looks nothing like the one they wrote — the same reason
 * `lisa init` appends config as text instead of round-tripping through js-yaml.
 *
 * So: locate the `[mcp_servers.lisa]` header, find where that table ends (the next header
 * line), and swap those lines. Every other byte survives untouched.
 *
 * Two shapes we refuse rather than guess at, because either one means the caller's mental
 * model of the file is wrong and writing would corrupt it:
 *   - `[[mcp_servers]]`     — an array of tables, not a table of tables
 *   - `mcp_servers = { … }` — an inline table at the root
 */

import { UserError } from "../paths.js";

export type TomlValue = string | string[];

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function tomlString(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function tomlValue(v: TomlValue): string {
  return Array.isArray(v) ? `[${v.map(tomlString).join(", ")}]` : tomlString(v);
}

function renderKeyPath(segments: string[]): string {
  return segments.map((s) => (BARE_KEY.test(s) ? s : tomlString(s))).join(".");
}

export function renderTomlTable(segments: string[], entries: Record<string, TomlValue>): string {
  const lines = [`[${renderKeyPath(segments)}]`];
  for (const [k, v] of Object.entries(entries)) lines.push(`${BARE_KEY.test(k) ? k : tomlString(k)} = ${tomlValue(v)}`);
  return lines.join("\n");
}

/**
 * Parse a table header line into its key path. `null` for anything that isn't one.
 *
 * `[[a.b]]` is reported as a header too (so it still terminates the preceding table) but
 * flagged, because an array-of-tables named `mcp_servers` is one of the refusal cases.
 */
function parseHeader(line: string): { path: string[]; array: boolean } | null {
  const m = /^\s*(\[\[?)([^\]]*)(\]\]?)\s*(?:#.*)?$/.exec(line);
  if (!m) return null;
  const array = m[1] === "[[";
  if (array !== (m[3] === "]]")) return null;

  const segments: string[] = [];
  // Split on dots that are not inside a quoted segment.
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (const ch of m[2]) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ".") {
      segments.push(buf.trim());
      buf = "";
    } else buf += ch;
  }
  segments.push(buf.trim());
  return segments.every(Boolean) ? { path: segments, array } : null;
}

/** Toggle state for `"""` / `'''` multi-line strings, so a `[` inside one isn't a header. */
function fenceDelta(line: string, open: string | null): string | null {
  let state = open;
  for (let i = 0; i < line.length - 2; i++) {
    const tri = line.slice(i, i + 3);
    if (tri !== '"""' && tri !== "'''") continue;
    if (state === null) state = tri;
    else if (state === tri) state = null;
    i += 2;
  }
  return state;
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/**
 * Return the complete desired contents of `file` with `[<segments>]` set to `entries`.
 *
 * An existing table is replaced in place. Sub-tables of it (`[mcp_servers.lisa.env]`,
 * say) are left alone — the scan stops at the next header, so anything the user added
 * under our key survives.
 */
export function setTomlTable(
  before: string | null,
  segments: string[],
  entries: Record<string, TomlValue>,
  file: string,
): string {
  const rendered = renderTomlTable(segments, entries);
  const text = before ?? "";
  if (!text.trim()) return rendered + "\n";

  const lines = text.split("\n");
  const root = segments[0];

  let quote: string | null = null;
  let current: string[] = [];
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasOpen = quote !== null;
    quote = fenceDelta(line, quote);
    if (wasOpen) continue;

    const header = parseHeader(line);
    if (header) {
      if (header.array && header.path[0] === root) {
        throw new UserError(
          `${file} declares \`${line.trim()}\` — an array of tables, which lisa doesn't know how to add a server to.\n` +
            `  Add the server by hand:\n\n${rendered.replace(/^/gm, "    ")}\n`,
        );
      }
      current = header.path;
      if (!header.array && samePath(header.path, segments)) {
        if (start !== -1) {
          throw new UserError(
            `${file} declares \`[${renderKeyPath(segments)}]\` more than once, so lisa can't tell which one is live.\n` +
              `  Remove the duplicate, then re-run \`lisa install\`.`,
          );
        }
        start = i;
      }
      continue;
    }

    // A root-level `mcp_servers = { … }` means the servers live in an inline table.
    if (current.length === 0) {
      const assign = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/.exec(line);
      const key = assign?.[1] ?? assign?.[2] ?? assign?.[3];
      if (key === root) {
        throw new UserError(
          `${file} sets \`${root}\` as an inline value, so lisa can't add a \`[${renderKeyPath(segments)}]\` table without conflicting with it.\n` +
            `  Convert it to table syntax (or add lisa inside it by hand), then re-run \`lisa install\`.`,
        );
      }
    }
  }

  if (start === -1) return text.replace(/\s*$/, "") + "\n\n" + rendered + "\n";

  // Find the end of our table: the next header line outside a multi-line string.
  quote = null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const wasOpen = quote !== null;
    quote = fenceDelta(lines[i], quote);
    if (wasOpen) continue;
    if (parseHeader(lines[i])) {
      end = i;
      break;
    }
  }

  // Keep whatever blank lines separated our table from the next one.
  const trailing: string[] = [];
  let cut = end;
  while (cut > start + 1 && lines[cut - 1].trim() === "") {
    trailing.unshift(lines[cut - 1]);
    cut--;
  }

  return [...lines.slice(0, start), ...rendered.split("\n"), ...trailing, ...lines.slice(end)].join("\n");
}
