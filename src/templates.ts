/**
 * Template loading and rendering.
 *
 * `templates/` sits at the package root, so it is located by walking up from this
 * module to the directory holding package.json. That works identically from `src/`
 * under tsx and from `dist/` once installed — a relative `../templates` does not,
 * because `dist/commands/` is one level deeper than `src/`.
 *
 * Rendering is deliberately dumber than a template engine. Config templates are files
 * people hand-edit afterwards, so we substitute text and never round-trip through
 * js-yaml (which would strip every comment).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedRoot: string | null = null;

export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return (cachedRoot = dir);
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not locate the lisa package root above ${fileURLToPath(import.meta.url)}`);
    dir = parent;
  }
}

export function templatesDir(): string {
  return path.join(packageRoot(), "templates");
}

export function readTemplate(name: string): string {
  const file = path.join(templatesDir(), name);
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    throw new Error(`Missing template ${name} (looked in ${templatesDir()}). The install may be incomplete.`);
  }
}

/**
 * Substitute `{{key}}` placeholders.
 *
 * A placeholder alone on its line is a *block*: its value is indented to match, and if
 * the value is empty the whole line disappears. That is what lets one template hold an
 * optional `credentials_env:` map and a multi-line `mission: |` body without the caller
 * doing indentation arithmetic. Anywhere else it is a plain scalar substitution.
 */
export function render(template: string, vars: Record<string, string>): string {
  const out: string[] = [];
  for (const line of template.split("\n")) {
    const block = /^([ \t]*)\{\{(\w+)\}\}[ \t]*$/.exec(line);
    if (block) {
      const value = vars[block[2]] ?? "";
      if (!value.trim()) continue;
      for (const l of value.replace(/\s+$/, "").split("\n")) out.push(l ? block[1] + l : "");
      continue;
    }
    out.push(line.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? ""));
  }
  return out.join("\n");
}
