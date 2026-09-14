/**
 * Minimal .env loader.
 *
 * `lisa init` tells you to put credentials in `.env`; if lisa never reads that file,
 * the very next thing you do fails. Loaded from the config root (not the cwd) so a
 * globally installed binary picks up the right project's secrets.
 *
 * Existing `process.env` always wins — CI secrets must never be clobbered by a file
 * that happens to be checked out in the workspace.
 *
 * No `dotenv` dependency: this is 20 lines of parsing and we control the format we
 * emit in `.env.example`.
 */

import fs from "node:fs";
import path from "node:path";

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(raw: string): string {
  if (raw.length >= 2 && raw[0] === raw[raw.length - 1] && (raw[0] === '"' || raw[0] === "'")) {
    const body = raw.slice(1, -1);
    // Only double quotes carry escapes, same as every other dotenv implementation.
    return raw[0] === '"' ? body.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"') : body;
  }
  // Unquoted values end at an inline comment.
  return raw.replace(/\s+#.*$/, "");
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = LINE.exec(line);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

/** Load `<dir>/.env` into process.env without overwriting anything already set. */
export function loadEnvFile(dir: string): string | null {
  const file = path.join(dir, ".env");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return file;
}
