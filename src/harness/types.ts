/**
 * The harness adapter contract.
 *
 * An adapter never writes anything. It returns the *complete desired contents* of every
 * file it wants to own, and the caller decides what to do with that: write it (`install`),
 * print it (`--print`), summarise it (`--dry-run`), or compare it against what is on disk
 * to report whether the harness is wired.
 *
 * That is the whole point of the split. `--print`, dry-run, status, and the post-install
 * summary are four views of one computation instead of four code paths that drift.
 *
 * `apply` and `status` from the sketch live here as free functions rather than methods:
 * they are identical for every adapter, and an adapter that could implement them
 * differently is an adapter that could lie about what it did.
 */

import fs from "node:fs";
import path from "node:path";
import type { RuntimeContext } from "../paths.js";

/** How lisa's MCP server gets launched by the harness. */
export interface ServerCommand {
  command: string;
  args: string[];
}

/**
 * What `detect()` needs: a directory to look in and a home directory for harnesses
 * whose config is user-global. Deliberately lighter than `InstallTarget` — detecting
 * whether Claude Code is installed has nothing to do with resolving lisa's own config
 * or the command that would launch its MCP server, and `--list` has to work before
 * either of those exists.
 */
export interface DetectTarget {
  dir: string;
  home: string;
}

export interface InstallTarget extends DetectTarget {
  /** The resolved lisa context — `ctx.configPath` is what gets baked into registrations. */
  ctx: RuntimeContext;
  server: ServerCommand;
}

export interface DetectResult {
  /** Did we find evidence this harness is actually in use here? */
  installed: boolean;
  /** One line naming what we found (or looked for and didn't). */
  evidence: string;
}

export interface FileChange {
  /** Absolute path. */
  path: string;
  /** Complete desired contents. */
  contents: string;
  /** Current contents, or null when the file does not exist yet. */
  before: string | null;
  /** What this file does, for the summary: "MCP server registration". */
  label: string;
}

export interface Harness {
  id: string;
  displayName: string;
  /** One line for the picker: what wiring this actually produces. */
  summary: string;
  detect(target: DetectTarget): DetectResult;
  plan(target: InstallTarget): FileChange[];
  /** Printed after a successful install — how to make the harness pick the change up. */
  nextSteps(target: InstallTarget): string[];
}

export type ChangeKind = "create" | "update" | "unchanged";

export function changeKind(c: FileChange): ChangeKind {
  if (c.before === null) return "create";
  return c.before === c.contents ? "unchanged" : "update";
}

export type HarnessStatus = "wired" | "stale" | "not-wired";

/**
 * Derived from the plan, never self-reported:
 *   every file already correct            -> wired
 *   every file missing                    -> not-wired
 *   anything in between (missing or drifted) -> stale
 */
export function statusOf(changes: FileChange[]): HarnessStatus {
  if (!changes.length) return "not-wired";
  const kinds = changes.map(changeKind);
  if (kinds.every((k) => k === "unchanged")) return "wired";
  if (kinds.every((k) => k === "create")) return "not-wired";
  return "stale";
}

/** Write every change that isn't already correct. Returns the ones actually written. */
export function applyChanges(changes: FileChange[]): FileChange[] {
  const written: FileChange[] = [];
  for (const c of changes) {
    if (changeKind(c) === "unchanged") continue;
    fs.mkdirSync(path.dirname(c.path), { recursive: true });
    fs.writeFileSync(c.path, c.contents, "utf-8");
    written.push(c);
  }
  return written;
}

export function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** Build a change by reading the current file off disk. */
export function change(file: string, contents: string, label: string): FileChange {
  return { path: file, contents, before: readIfExists(file), label };
}
