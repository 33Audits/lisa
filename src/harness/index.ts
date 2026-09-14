/**
 * The harness registry.
 *
 * Adapters plug in by appending to HARNESSES — nothing in `lisa install` knows any harness
 * by name. Order is the order the interactive picker offers them.
 *
 * There is no shell-only fallback adapter. Native mode structurally requires MCP: every
 * `lisa` CLI invocation is a fresh process, so an agent with only a shell has nowhere to
 * keep a browser between actions. Four adapters that genuinely work beats five where one
 * is quietly on a second-class path. `lisa run --json` and `--mission` are untouched —
 * that CLI surface is how CI and standalone use work, and it never depended on an adapter.
 */

import os from "node:os";
import path from "node:path";
import { UserError, type RuntimeContext } from "../paths.js";
import { resolveServerCommand } from "./command.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";
import { windsurf } from "./windsurf.js";
import {
  DEFAULT_TOOLS_MODE,
  TOOLS_MODES,
  statusOf,
  type DetectResult,
  type DetectTarget,
  type Harness,
  type HarnessStatus,
  type InstallTarget,
  type ToolsMode,
} from "./types.js";

export const HARNESSES: Harness[] = [claudeCode, codex, cursor, windsurf];

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
  /** Which tool surface to register and brief for. Defaults to native. */
  mode?: ToolsMode;
}

/**
 * Project-scoped harness files default to the config's own directory — that is the app
 * repo for a project config. Under a global config there is no repo to speak of, so the
 * cwd is the only sensible answer.
 */
export function installTarget(ctx: RuntimeContext, opts: TargetOptions = {}, cwd: string = process.cwd()): InstallTarget {
  const dir = opts.dir ? path.resolve(cwd, opts.dir) : ctx.scope === "project" ? ctx.root : path.resolve(cwd);
  const mode = opts.mode ?? DEFAULT_TOOLS_MODE;
  return { ctx, dir, home: os.homedir(), mode, server: resolveServerCommand(ctx, opts.command, mode) };
}

/**
 * Wiring state without assuming a mode.
 *
 * A harness installed in oneshot mode is *wired*, not *out of date* — it is just wired to
 * the other surface. `lisa doctor` has to say so, because telling someone their working
 * install is broken is worse than saying nothing. `lisa install --status` uses this to
 * explain a "stale" it would otherwise report without a reason.
 *
 * Errors are swallowed to `null` deliberately: one harness with an unparseable config file
 * must not take down a report that covers four of them.
 */
export function wiredMode(harness: Harness, ctx: RuntimeContext, opts: TargetOptions = {}): { status: HarnessStatus; mode: ToolsMode | null } {
  const results: { mode: ToolsMode; status: HarnessStatus }[] = [];
  for (const mode of TOOLS_MODES) {
    try {
      results.push({ mode, status: statusOf(harness.plan(installTarget(ctx, { ...opts, mode }))) });
    } catch {
      // This mode can't even be planned; another might still be informative.
    }
  }
  const wired = results.find((r) => r.status === "wired");
  if (wired) return { status: "wired", mode: wired.mode };
  // No mode could even be planned: re-run once outside the try so the real error surfaces
  // instead of a status we'd be inventing.
  if (!results.length) harness.plan(installTarget(ctx, opts));
  return { status: results.every((r) => r.status === "not-wired") ? "not-wired" : "stale", mode: null };
}

export * from "./types.js";
export { claudeCode, codex, cursor, windsurf };
