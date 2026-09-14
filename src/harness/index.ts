/**
 * The harness registry.
 *
 * Step 4 adds codex, cursor, windsurf, and the generic (CLI-only) adapter. They plug in
 * by appending to HARNESSES — nothing in `lisa install` knows any harness by name.
 */

import os from "node:os";
import path from "node:path";
import { UserError, type RuntimeContext } from "../paths.js";
import { resolveServerCommand } from "./command.js";
import { claudeCode } from "./claude-code.js";
import type { DetectResult, DetectTarget, Harness, InstallTarget } from "./types.js";

export const HARNESSES: Harness[] = [claudeCode];

export function harnessIds(): string[] {
  return HARNESSES.map((h) => h.id);
}

export function findHarness(id: string): Harness {
  const key = id.trim().toLowerCase();
  const found = HARNESSES.find((h) => h.id === key);
  if (!found) throw new UserError(`Unknown harness "${id}". Available: ${harnessIds().join(", ")}`);
  return found;
}

/**
 * What `detect()` needs, and nothing more — no lisa config required. This is what lets
 * `lisa install --list` show which harnesses are actually on this machine before a
 * `lisa.config.yaml` exists to resolve.
 */
export function detectTarget(cwd: string = process.cwd()): DetectTarget {
  return { dir: path.resolve(cwd), home: os.homedir() };
}

/** Run `detect()` for every registered harness. */
export function detectAll(target: DetectTarget): { harness: Harness; result: DetectResult }[] {
  return HARNESSES.map((harness) => ({ harness, result: harness.detect(target) }));
}

export interface TargetOptions {
  /** Where project-scoped harness files go. Defaults to the config's directory. */
  dir?: string;
  /** Override the command the harness uses to start the MCP server. */
  command?: string;
}

/**
 * Project-scoped harness files default to the config's own directory — that is the app
 * repo for a project config. Under a global config there is no repo to speak of, so the
 * cwd is the only sensible answer.
 */
export function installTarget(ctx: RuntimeContext, opts: TargetOptions = {}, cwd: string = process.cwd()): InstallTarget {
  const dir = opts.dir ? path.resolve(cwd, opts.dir) : ctx.scope === "project" ? ctx.root : path.resolve(cwd);
  return { ctx, dir, home: os.homedir(), server: resolveServerCommand(ctx, opts.command) };
}

export * from "./types.js";
export { claudeCode };
