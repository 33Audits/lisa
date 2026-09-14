/**
 * Where lisa's config, state, and artifacts live.
 *
 * Resolution order for config:
 *   --config flag  ->  $LISA_CONFIG  ->  ./lisa.config.yaml (walking up to the repo root)
 *   ->  ~/.config/lisa/config.yaml
 *
 * State and artifacts anchor to whichever config won, never to the current directory —
 * a globally installed binary must not scatter output wherever it happens to be run.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ConfigScope = "project" | "global";

export interface RuntimeContext {
  /** Absolute path to the config file in use. */
  configPath: string;
  /** Directory the config lives in; everything else hangs off this. */
  root: string;
  stateDir: string;
  artifactsDir: string;
  shotsDir: string;
  scope: ConfigScope;
}

export const CONFIG_FILENAMES = ["lisa.config.yaml", "lisa.config.yml", ".lisa.yaml"] as const;
export const PRIMARY_CONFIG_FILENAME = CONFIG_FILENAMES[0];

function xdgHome(envVar: string, fallback: string): string {
  const fromEnv = process.env[envVar];
  return fromEnv && path.isAbsolute(fromEnv) ? fromEnv : path.join(os.homedir(), fallback);
}

export function globalConfigPath(): string {
  return path.join(xdgHome("XDG_CONFIG_HOME", ".config"), "lisa", "config.yaml");
}

export function globalDataDir(): string {
  return path.join(xdgHome("XDG_STATE_HOME", path.join(".local", "state")), "lisa");
}

/** Walk up from `from` looking for a project config, stopping at the repo root. */
export function findProjectConfig(from: string = process.cwd()): string | null {
  let dir = path.resolve(from);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    // Don't escape the repository we're standing in.
    if (fs.existsSync(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function dirFromEnv(envVar: string): string | null {
  const raw = process.env[envVar];
  return raw ? path.resolve(raw) : null;
}

export function contextFor(configPath: string, scope: ConfigScope): RuntimeContext {
  const resolved = path.resolve(configPath);
  const root = path.dirname(resolved);
  const base = scope === "project" ? path.join(root, ".lisa") : globalDataDir();
  const stateDir = dirFromEnv("LISA_STATE_DIR") ?? path.join(base, "state");
  const artifactsDir = dirFromEnv("LISA_ARTIFACTS_DIR") ?? path.join(base, "artifacts");
  return { configPath: resolved, root, stateDir, artifactsDir, shotsDir: path.join(artifactsDir, "screenshots"), scope };
}

/**
 * Something the user can fix by changing a flag or a file. Entrypoints print the
 * message alone — a stack trace here is noise that buries the instruction.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export class ConfigNotFoundError extends UserError {
  constructor() {
    super(
      `No lisa config found.\n\n` +
        `  Looked for ${PRIMARY_CONFIG_FILENAME} here and in parent directories,\n` +
        `  then ${globalConfigPath()}\n\n` +
        `  Run \`lisa init\` to create one.`,
    );
    this.name = "ConfigNotFoundError";
  }
}

/** Resolve the context to run under. Throws ConfigNotFoundError if nothing is configured. */
export function resolveContext(explicitPath?: string, cwd: string = process.cwd()): RuntimeContext {
  const explicit = explicitPath ?? process.env.LISA_CONFIG;
  if (explicit) {
    const resolved = path.resolve(cwd, explicit);
    if (!fs.existsSync(resolved)) throw new Error(`Config not found: ${resolved}`);
    return contextFor(resolved, resolved === globalConfigPath() ? "global" : "project");
  }

  const projectConfig = findProjectConfig(cwd);
  if (projectConfig) return contextFor(projectConfig, "project");

  const global = globalConfigPath();
  if (fs.existsSync(global)) return contextFor(global, "global");

  throw new ConfigNotFoundError();
}

/** Where `lisa init` should write when run in `cwd`. */
export function initTargetPath(cwd: string = process.cwd(), global = false): string {
  return global ? globalConfigPath() : path.join(path.resolve(cwd), PRIMARY_CONFIG_FILENAME);
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The rows `lisa where` prints — factored out so `lisa doctor` renders the same ones. */
export function describeContext(ctx: RuntimeContext): { label: string; value: string }[] {
  return [
    { label: "scope", value: ctx.scope },
    { label: "config", value: ctx.configPath },
    { label: "state", value: ctx.stateDir },
    { label: "artifacts", value: ctx.artifactsDir },
  ];
}
