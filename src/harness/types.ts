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
import { UserError, type RuntimeContext } from "../paths.js";

/** How lisa's MCP server gets launched by the harness. */
export interface ServerCommand {
  command: string;
  args: string[];
}

/**
 * Which tool surface the harness gets, and therefore which brief it's given.
 *
 * `native` exposes the browser primitives so the harness's own model drives — no second
 * API key. `oneshot` exposes `run_qa`, which runs lisa's private agent loop against its
 * own ANTHROPIC_API_KEY. One field, because these are not independent choices: a brief
 * telling the agent to call `run_qa` against a server registered with `--tools native` is
 * a brief describing a tool that isn't there.
 */
export type ToolsMode = "native" | "oneshot";
export const TOOLS_MODES: ToolsMode[] = ["native", "oneshot"];

/**
 * `lisa install` writes native; `lisa-mcp` itself still defaults to oneshot. Two defaults
 * on purpose — someone wiring into a coding agent wants native, and every registration
 * already on disk (none of which carry `--tools`) must keep working untouched.
 */
export const DEFAULT_TOOLS_MODE: ToolsMode = "native";

export function parseToolsMode(raw: string): ToolsMode {
  const value = raw.trim().toLowerCase();
  if ((TOOLS_MODES as string[]).includes(value)) return value as ToolsMode;
  throw new UserError(`Unknown --mode "${raw}". Expected ${TOOLS_MODES.join(" or ")}.`);
}

/**
 * Where the wiring lives: once per machine, or once per repo.
 *
 * `user` writes into the harness's own home-directory config — one registration that
 * serves every repo, because the server is launched without `--config` and discovers
 * whichever `lisa.config.yaml` sits in the directory the harness spawned it from.
 *
 * `project` writes into the repo, so the wiring can be committed. It is no longer the
 * default: a per-repo registration means a per-repo approval prompt, N copies of the
 * brief to keep in sync, and — before this change — a registration carrying an absolute
 * config path that was correct on exactly one machine.
 */
export type InstallScope = "user" | "project";
export const INSTALL_SCOPES: InstallScope[] = ["user", "project"];

/** Install once per machine unless asked otherwise. See `InstallScope`. */
export const DEFAULT_INSTALL_SCOPE: InstallScope = "user";

export function parseInstallScope(raw: string): InstallScope {
  const value = raw.trim().toLowerCase();
  if ((INSTALL_SCOPES as string[]).includes(value)) return value as InstallScope;
  throw new UserError(`Unknown --scope "${raw}". Expected ${INSTALL_SCOPES.join(" or ")}.`);
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
  /** Drives both the server's `--tools` argument and which brief the adapter renders. */
  mode: ToolsMode;
  /** Whether this install is once-per-machine (`user`) or committed to the repo (`project`). */
  scope: InstallScope;
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
  /**
   * One line when this harness can't honour `scope` completely, or null when it can.
   *
   * Cursor is the case that needs it: its MCP config has a home-directory form, but its
   * rules are a per-repo directory with no user-global file equivalent, so a `user`
   * install still leaves the brief in the repo. Saying so is better than a "wired"
   * report that quietly means something different here than everywhere else.
   */
  scopeNote?(scope: InstallScope): string | null;
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
