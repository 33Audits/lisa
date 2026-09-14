/**
 * Config loading and validation.
 *
 * lisa.config.yaml holds project definitions and the *names* of the env vars that carry
 * credentials — never the credentials themselves.
 */

import fs from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";
import { UserError, type RuntimeContext } from "./paths.js";

/** Bug severities. Lives here rather than core.ts so config can map them without importing the engine. */
export type Severity = "critical" | "major" | "minor";

export const SEVERITIES: Severity[] = ["critical", "major", "minor"];

/**
 * Env var names only — `A-Z`, `0-9`, `_`. A literal secret pasted here (an email, a URL,
 * anything with a `@`, `.`, or `-`) can never name an env var, so it resolves to nothing and
 * the run silently loses its credentials. Reject it at load instead of degrading.
 *
 * A literal that happens to look like an identifier still slips through — that case lands in
 * `missing` at resolve time, which is already reported.
 */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `v` could name an env var. `lisa init` checks this before writing a name anywhere. */
export function isEnvVarName(v: string): boolean {
  return ENV_VAR_NAME.test(v);
}

const EnvVarName = z.string().refine((v) => ENV_VAR_NAME.test(v), {
  message:
    "must be the NAME of an env var (e.g. ACME_QA_PASSWORD), not the secret itself. " +
    "Put the value in .env beside this config and reference it by name here.",
});

/**
 * Linear's own priority scale: 0 none, 1 urgent, 2 high, 3 medium, 4 low. A QA bug that
 * blocks a core flow is what "urgent" is for; cosmetic goes to the bottom of a real backlog
 * rather than the middle of it.
 */
export const DEFAULT_SEVERITY_PRIORITY: Record<Severity, number> = { critical: 1, major: 2, minor: 4 };

const Priority = z.number().int().min(0).max(4);

/** Shared by the global block and a project's override — everything except the key name. */
const linearCommon = {
  /** Team key (`ENG`) or UUID. Required once the two halves are merged. */
  team: z.string().min(1).optional(),
  /** Optional Linear project to file into, by name. */
  project: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).optional(),
  severity_priority: z.object({ critical: Priority, major: Priority, minor: Priority }).partial().optional(),
};

const GlobalLinearSchema = z.object({ api_key_env: EnvVarName.default("LINEAR_API_KEY"), ...linearCommon });
const ProjectLinearSchema = z.object({ api_key_env: EnvVarName.optional(), ...linearCommon });

/**
 * A project's Linear settings after the global block and its own override are merged — the
 * only shape anything downstream sees. `team` is non-optional here because a config that
 * couldn't name one never gets this far (see the superRefine below).
 */
export interface LinearSettings {
  api_key_env: string;
  team: string;
  project?: string;
  labels: string[];
  severity_priority: Record<Severity, number>;
}

type LinearBlock = z.output<typeof ProjectLinearSchema>;

/**
 * Merge the global `linear:` block with a project's override, project wins per field.
 *
 * Returns null when neither exists — that is the "Linear isn't configured" signal, and it is
 * why filing is opt-in rather than something a user discovers by finding issues in their
 * tracker. `team` missing returns null too; the superRefine reports it as a config error
 * first, so nothing reaches here in that state during a real load.
 */
function mergeLinear(global?: LinearBlock, override?: LinearBlock): LinearSettings | null {
  if (!global && !override) return null;
  const team = override?.team ?? global?.team;
  const api_key_env = override?.api_key_env ?? global?.api_key_env ?? "LINEAR_API_KEY";
  if (!team) return null;
  return {
    api_key_env,
    team,
    project: override?.project ?? global?.project,
    labels: override?.labels ?? global?.labels ?? [],
    severity_priority: { ...DEFAULT_SEVERITY_PRIORITY, ...global?.severity_priority, ...override?.severity_priority },
  };
}

const ProjectSchema = z
  .object({
    name: z.string().min(1),
    base_url: z.string().url(),
    /** Navigation outside this host is blocked. Defaults to base_url's host. */
    allowed_host: z.string().min(1).optional(),
    /** Map of role -> env var NAME holding the secret, e.g. { username: ACME_QA_USERNAME }. */
    credentials_env: z.record(EnvVarName).default({}),
    mission: z.string().min(1),
    /** Per-project override of the top-level `linear:` block. Merged, not replaced. */
    linear: ProjectLinearSchema.optional(),
  })
  .transform((p) => ({ ...p, allowed_host: p.allowed_host ?? new URL(p.base_url).host }));

/**
 * Linear settings are resolved *at load*, not at use: `findProject` hands callers a single
 * project and the engine's `finishReport` only ever sees one, so a global block that stayed
 * global would have to be re-read — and re-merged — at every call site that files anything.
 * Merging once here means `project.linear` is the whole answer everywhere downstream.
 */
const ConfigSchema = z
  .object({
    linear: GlobalLinearSchema.optional(),
    projects: z.array(ProjectSchema).min(1, "config must define at least one project"),
  })
  .superRefine((c, ctx) => {
    c.projects.forEach((p, i) => {
      const configured = c.linear || p.linear;
      if (configured && !(p.linear?.team ?? c.linear?.team)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: p.linear ? ["projects", i, "linear", "team"] : ["linear", "team"],
          message: `no Linear team for project "${p.name}" — set linear.team to a team key (e.g. ENG) or UUID`,
        });
      }
    });
  })
  .transform((c) => ({
    ...c,
    projects: c.projects.map((p) => ({ ...p, linear: mergeLinear(c.linear, p.linear) })),
  }));

export type ProjectConfig = Omit<z.output<typeof ProjectSchema>, "linear"> & { linear?: LinearSettings | null };
export type LisaConfig = z.output<typeof ConfigSchema>;

function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

export function loadConfig(ctx: RuntimeContext): LisaConfig {
  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(ctx.configPath, "utf-8"));
  } catch (e: any) {
    throw new UserError(`Could not parse ${ctx.configPath}:\n  ${e?.message ?? e}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new UserError(`Invalid config at ${ctx.configPath}:\n${formatIssues(parsed.error)}`);
  return parsed.data;
}

export function loadProjects(ctx: RuntimeContext): ProjectConfig[] {
  return loadConfig(ctx).projects;
}

export function findProject(ctx: RuntimeContext, name: string): ProjectConfig {
  const projects = loadProjects(ctx);
  const match = projects.find((p) => p.name === name);
  if (match) return match;
  throw new UserError(`No project named "${name}" in ${ctx.configPath}.\n  Available: ${projects.map((p) => p.name).join(", ")}`);
}

/** Resolve a project's credential env var names to their values. */
export function resolveCredentials(project: ProjectConfig): { creds: Record<string, string>; missing: string[] } {
  const creds: Record<string, string> = {};
  const missing: string[] = [];
  for (const [role, envVar] of Object.entries(project.credentials_env)) {
    const value = process.env[envVar];
    if (value) creds[role] = value;
    else missing.push(envVar);
  }
  return { creds, missing };
}

/**
 * The Linear settings for a project *and* the key they need, or null.
 *
 * Both halves have to be present for filing to mean anything, and neither is an error on its
 * own: no `linear:` block is the default, and a block whose key isn't set is a machine that
 * hasn't been given one yet (CI before the secret lands, a teammate's first clone). Callers
 * that care about the difference read `settings` and `key` separately — `doctor` does.
 */
export function resolveLinear(project: ProjectConfig): { settings: LinearSettings; key: string } | null {
  const settings = project.linear;
  if (!settings) return null;
  const key = process.env[settings.api_key_env];
  return key ? { settings, key } : null;
}
