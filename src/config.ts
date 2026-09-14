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

const ProjectSchema = z
  .object({
    name: z.string().min(1),
    base_url: z.string().url(),
    /** Navigation outside this host is blocked. Defaults to base_url's host. */
    allowed_host: z.string().min(1).optional(),
    /** Map of role -> env var NAME holding the secret, e.g. { username: ACME_QA_USERNAME }. */
    credentials_env: z.record(EnvVarName).default({}),
    mission: z.string().min(1),
  })
  .transform((p) => ({ ...p, allowed_host: p.allowed_host ?? new URL(p.base_url).host }));

const ConfigSchema = z.object({
  projects: z.array(ProjectSchema).min(1, "config must define at least one project"),
});

export type ProjectConfig = z.output<typeof ProjectSchema>;
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
