/**
 * `lisa init` — scaffold a config so a fresh user gets somewhere without hand-editing YAML.
 *
 * Interactive by default, with every prompt also settable as a flag so CI and scripting
 * work. Config is assembled from text templates rather than dumped through js-yaml:
 * this is a file people hand-edit afterwards, and a round-trip would strip the comments
 * that explain it.
 *
 * The non-production confirmation is not ceremony. lisa clicks buttons in a real
 * browser against whatever URL it is handed.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { contextFor, findProjectConfig, globalConfigPath, initTargetPath, UserError } from "../paths.js";
import { readTemplate, render } from "../templates.js";
import { DEFAULT_TOOLS_MODE, HARNESSES, detectAll, detectTarget, findHarness, type ToolsMode } from "../harness/index.js";
import { installCommand, pickToolsMode } from "./install.js";

export interface InitOptions {
  config?: string;
  global?: boolean;
  yes?: boolean;
  force?: boolean;
  name?: string;
  url?: string;
  /** commander sets this false for --no-login, true for --login, undefined for neither. */
  login?: boolean;
  usernameEnv?: string;
  passwordEnv?: string;
  mission?: MissionKey;
  nonProduction?: boolean;
  /** A harness id, or "none" for standalone/CI. Skips the interactive question either way. */
  harness?: string;
  /** Tool surface for the chained install. Undefined asks on a TTY; ignored without a harness. */
  mode?: ToolsMode;
}

/**
 * `opts.harness` resolved to a harness id, `null` for standalone/CI, or `undefined` when
 * nothing was passed and the interactive prompt should decide. Separate from the prompt
 * so `--harness <id>` and `--harness none` give scripted setups the same power as a human
 * answering the question.
 */
function resolveHarnessFlag(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim().toLowerCase() === "none") return null;
  return findHarness(raw).id;
}

/**
 * The first question `lisa init` asks: are you wiring this into a coding agent, or
 * running it yourself? Answering with a harness changes what happens after the config
 * is written — `initCommand` chains straight into `lisa install <harness>` — so someone
 * who already knows they want Claude Code (or Codex, Cursor, Windsurf) never has to
 * remember to run a second command.
 *
 * Skipped entirely off a TTY: a non-interactive `--yes` run is already the "hosting on a
 * server / CI" case, so it defaults to standalone unless `--harness` says otherwise.
 */
async function pickInitHarness(dir: string): Promise<string | null> {
  const detected = detectAll(detectTarget(dir));
  const value = await ask(
    p.select({
      message: "How will you run lisa?",
      options: [
        ...HARNESSES.map((h) => ({
          value: h.id,
          label: h.displayName,
          hint: detected.find((d) => d.harness.id === h.id)?.result.installed ? "detected here" : undefined,
        })),
        {
          value: "__standalone__",
          label: "Standalone — terminal, CI, or a server",
          hint: "you'll run `lisa run` yourself and set ANTHROPIC_API_KEY",
        },
      ],
    }),
  );
  return value === "__standalone__" ? null : value;
}

const MISSIONS = {
  smoke: { file: "mission-smoke.txt", label: "Smoke test — load every page, check for errors, exercise the main controls" },
  auth: { file: "mission-auth.txt", label: "Login + core flow — sign in, verify the dashboard, edit a setting, log out" },
  minimal: { file: "mission-minimal.txt", label: "Minimal placeholder — I'll write the real plan myself" },
} as const;

export type MissionKey = keyof typeof MISSIONS;
export const MISSION_KEYS = Object.keys(MISSIONS) as MissionKey[];

/**
 * Hostnames that read as somebody's staging environment. Used to pick the default
 * answer for the non-production confirmation, and to decide whether `--yes` may skip
 * it. Takes a hostname, never a host — a `:port` suffix defeats every anchor here.
 */
const NON_PROD =
  /(^|[.\-])(staging|stage|dev|development|test|testing|qa|preview|sandbox|demo|local|localhost)([.\-]|$)|^(127\.0\.0\.1|::1|0\.0\.0\.0)$|\.(local|test|internal|localhost)$|\.internal\./i;

export function looksNonProduction(hostname: string): boolean {
  // URL.hostname brackets IPv6 literals; strip them so ::1 anchors.
  return NON_PROD.test(hostname.replace(/^\[|\]$/g, ""));
}

/** `acme-dashboard` -> `ACME_DASHBOARD`, for default credential env var names. */
export function envPrefix(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!slug) return "LISA";
  return /^[0-9]/.test(slug) ? `P_${slug}` : slug;
}

function parseUrl(raw: string): URL {
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UserError("must be an http or https URL");
  return url;
}

/** Existing project names, read defensively — a malformed config should not crash init. */
function existingProjectNames(file: string): string[] {
  try {
    const doc = yaml.load(fs.readFileSync(file, "utf-8")) as any;
    return Array.isArray(doc?.projects) ? doc.projects.map((x: any) => String(x?.name ?? "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function hasProjectsKey(file: string): boolean {
  try {
    const doc = yaml.load(fs.readFileSync(file, "utf-8")) as any;
    return Array.isArray(doc?.projects);
  } catch {
    return false;
  }
}

/** Unwrap a clack prompt, exiting cleanly on Ctrl-C instead of throwing a symbol around. */
async function ask<T>(prompt: Promise<T>): Promise<Exclude<T, symbol>> {
  const value = await prompt;
  if (p.isCancel(value)) {
    p.cancel("Cancelled — nothing was written.");
    process.exit(130);
  }
  return value as Exclude<T, symbol>;
}

/** Append `KEY=` lines for any credential env var the file doesn't already mention. */
function writeEnvExample(root: string, vars: string[]): { file: string; added: string[] } | null {
  if (!vars.length) return null;
  const file = path.join(root, ".env.example");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const present = new Set(Object.keys(parseKeys(existing)));
  const added = vars.filter((v) => !present.has(v));
  if (!added.length) return { file, added };

  const header = existing
    ? ""
    : "# Copy to .env and fill in. .env is gitignored; this file is not.\n" +
      "# ANTHROPIC_API_KEY is what drives the agent itself.\n\nANTHROPIC_API_KEY=\n";
  const body = added.map((v) => `${v}=`).join("\n");
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(file, `${existing}${sep}${header}${body}\n`, "utf-8");
  return { file, added };
}

function parseKeys(text: string): Record<string, true> {
  const out: Record<string, true> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) out[m[1]] = true;
  }
  return out;
}

const IGNORES = [
  { pattern: ".env", comment: "secrets — never commit" },
  { pattern: ".lisa/", comment: "lisa runtime output (seen-bug state, reports, screenshots)" },
];

/** Make sure .env and .lisa/ are ignored. Additive — never rewrites what's there. */
function ensureGitignore(root: string): string[] {
  const file = path.join(root, ".gitignore");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = IGNORES.filter((i) => !lines.has(i.pattern) && !lines.has(`/${i.pattern}`));
  if (!missing.length) return [];

  const block = missing.map((i) => `# ${i.comment}\n${i.pattern}`).join("\n");
  const sep = !existing ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(file, `${existing}${sep}${block}\n`, "utf-8");
  return missing.map((i) => i.pattern);
}

function renderEntry(a: {
  name: string;
  baseUrl: string;
  host: string;
  credentials: Record<string, string>;
  mission: string;
}): string {
  const creds = Object.entries(a.credentials);
  return render(readTemplate("project-entry.yaml"), {
    name: a.name,
    base_url: a.baseUrl,
    allowed_host: a.host,
    credentials: creds.length
      ? ["credentials_env:", ...creds.map(([role, env]) => `  ${role}: ${env}`)].join("\n")
      : "",
    mission: a.mission.replace(/\s+$/, ""),
  });
}

export async function initCommand(opts: InitOptions, cwd: string = process.cwd()): Promise<void> {
  const interactive = !opts.yes && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!interactive && !opts.yes) {
    throw new UserError("`lisa init` needs a TTY to prompt. Pass --yes with --url (and --name) to run non-interactively.");
  }

  // Where are we writing? An existing config anywhere up the tree wins, so running
  // init from a subdirectory adds to the repo's config instead of shadowing it.
  const target = opts.config
    ? path.resolve(cwd, opts.config)
    : opts.global
      ? globalConfigPath()
      : (findProjectConfig(cwd) ?? initTargetPath(cwd));
  const root = path.dirname(target);
  const exists = fs.existsSync(target);

  if (interactive) p.intro(pc.bold("lisa init"));

  // ---- how will you run lisa? (asked first — it decides what happens after the write) ----
  const harnessFlag = resolveHarnessFlag(opts.harness);
  const harnessChoice = harnessFlag !== undefined ? harnessFlag : interactive ? await pickInitHarness(root) : null;
  // Resolved here rather than inside the chained install, because the "next steps" printed
  // below differ by mode — a native user must not be told to go and get an API key.
  const toolsMode: ToolsMode = harnessChoice
    ? (opts.mode ?? (interactive ? await pickToolsMode() : DEFAULT_TOOLS_MODE))
    : DEFAULT_TOOLS_MODE;

  // ---- existing config: append, overwrite, or bail ----
  let mode: "create" | "append" | "overwrite" = exists ? "append" : "create";
  if (exists && opts.force) mode = "overwrite";
  else if (exists && interactive) {
    p.log.info(`Found an existing config at ${pc.dim(target)}`);
    mode = await ask(
      p.select({
        message: "What should I do with it?",
        options: [
          { value: "append" as const, label: "Add another project to it" },
          { value: "overwrite" as const, label: "Replace it", hint: "the current contents are lost" },
        ],
      }),
    );
  }
  if (mode === "append" && !hasProjectsKey(target)) {
    throw new UserError(
      `${target} exists but has no \`projects:\` list, so there is nothing to append to.\n` +
        `  Fix the file by hand, or re-run with --force to replace it.`,
    );
  }
  const taken = mode === "append" ? existingProjectNames(target) : [];

  // ---- project name ----
  const defaultName = path.basename(path.resolve(cwd)) || "app";
  const name = (
    opts.name ??
    (interactive
      ? await ask(
          p.text({
            message: "Project name",
            placeholder: defaultName,
            defaultValue: defaultName,
            validate: (v) => {
              const n = (v || defaultName).trim();
              if (!n) return "Required.";
              if (taken.includes(n)) return `"${n}" is already in this config.`;
              return undefined;
            },
          }),
        )
      : defaultName)
  ).trim();
  if (taken.includes(name)) {
    throw new UserError(`"${name}" is already in ${target}. Pick another name, or edit the existing entry.`);
  }

  // ---- staging URL ----
  if (!interactive && !opts.url) throw new UserError("--yes needs --url: there is nothing sensible to default a staging URL to.");
  const rawUrl =
    opts.url ??
    (await ask(
      p.text({
        message: "Staging base URL",
        placeholder: "https://staging.example.com",
        validate: (v) => {
          if (!v?.trim()) return "Required.";
          try {
            parseUrl(v.trim());
            return undefined;
          } catch (e: any) {
            return `Not a usable URL — ${e?.message ?? e}`;
          }
        },
      }),
    ));
  const url = parseUrl(rawUrl.trim());
  const baseUrl = url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/$/, ""));

  // ---- the gate ----
  // `--non-production` is the flag form of the confirmation, and answers it in either
  // mode: a scripted-but-interactive invocation should not stop to ask what it was told.
  const plausible = looksNonProduction(url.hostname);
  if (interactive && !opts.nonProduction) {
    const confirmed = await ask(
      p.confirm({
        message: `${pc.bold(url.host)} is a staging or test environment — not production?`,
        initialValue: plausible,
      }),
    );
    if (!confirmed) {
      p.cancel("Stopped. lisa clicks buttons in a real browser; point it at a non-production environment.");
      process.exit(1);
    }
  } else if (!interactive && !opts.nonProduction && !plausible) {
    throw new UserError(
      `${url.host} does not look like a staging host, and --yes cannot ask.\n` +
        `  lisa drives a real browser against this URL. If it really is non-production,\n` +
        `  re-run with --non-production to say so explicitly.`,
    );
  }

  // ---- login + credentials ----
  const needsLogin = opts.login ?? (interactive ? await ask(p.confirm({ message: "Does the app need a login?", initialValue: true })) : false);
  const prefix = envPrefix(name);
  const credentials: Record<string, string> = {};
  if (needsLogin) {
    const defUser = `${prefix}_USERNAME`;
    const defPass = `${prefix}_PASSWORD`;
    credentials.username =
      opts.usernameEnv ??
      (interactive
        ? (
            await ask(
              p.text({ message: "Env var holding the test username", placeholder: defUser, defaultValue: defUser }),
            )
          ).trim() || defUser
        : defUser);
    credentials.password =
      opts.passwordEnv ??
      (interactive
        ? (
            await ask(
              p.text({ message: "Env var holding the test password", placeholder: defPass, defaultValue: defPass }),
            )
          ).trim() || defPass
        : defPass);
  }

  // ---- starter mission ----
  const defaultMission: MissionKey = needsLogin ? "auth" : "smoke";
  const missionKey =
    opts.mission ??
    (interactive
      ? await ask(
          p.select({
            message: "Starter mission (you can edit it in the config afterwards)",
            initialValue: defaultMission,
            options: MISSION_KEYS.map((k) => ({ value: k, label: MISSIONS[k].label })),
          }),
        )
      : defaultMission);
  if (!MISSION_KEYS.includes(missionKey)) {
    throw new UserError(`Unknown mission "${missionKey}". Choose one of: ${MISSION_KEYS.join(", ")}`);
  }

  // ---- write ----
  const entry = renderEntry({ name, baseUrl, host: url.host, credentials, mission: readTemplate(MISSIONS[missionKey].file) });

  fs.mkdirSync(root, { recursive: true });
  if (mode === "append") {
    const current = fs.readFileSync(target, "utf-8");
    fs.writeFileSync(target, `${current}${current.endsWith("\n") ? "" : "\n"}\n${entry}`, "utf-8");
  } else {
    // The header template already ends on `projects:` plus a newline.
    fs.writeFileSync(target, `${readTemplate("config-header.yaml")}${entry}`, "utf-8");
  }

  const env = writeEnvExample(root, Object.values(credentials));
  const ignored = opts.global ? [] : ensureGitignore(root);

  // ---- report ----
  // Relative while we're still inside the tree; absolute once it would climb out,
  // because `../../../../tmp/...` is worse than just saying where the file is.
  const rel = (f: string) => {
    const r = path.relative(cwd, f);
    return !r ? path.basename(f) : r.startsWith("..") ? f : r;
  };
  const wrote = [
    `${mode === "append" ? "updated" : "wrote"}  ${rel(target)}`,
    ...(env?.added.length ? [`updated  ${rel(env.file)}`] : []),
    ...(ignored.length ? [`updated  ${rel(path.join(root, ".gitignore"))}  (+${ignored.join(", ")})`] : []),
  ];

  // The API key step depends on who is going to do the reasoning. In native mode the
  // harness's own model drives, so there is no second key to set — saying otherwise here
  // would send someone to the Console to solve a problem they just avoided. `lisa run`
  // and CI still call the API directly either way, which is why the line isn't dropped.
  const steps: string[] = [];
  if (Object.values(credentials).length) {
    steps.push(`Put the test credentials in ${pc.bold(rel(path.join(root, ".env")))}: ${Object.values(credentials).join(", ")}`);
  }
  if (harnessChoice && toolsMode === "native") {
    steps.push(
      `No ${pc.bold("ANTHROPIC_API_KEY")} needed — ${findHarness(harnessChoice).displayName} drives the browser itself. ` +
        `(Set one only if you also want to run ${pc.bold("lisa run")} or CI.)`,
    );
  } else if (harnessChoice) {
    steps.push(`Set ${pc.bold("ANTHROPIC_API_KEY")} (in .env or your shell) — the lisa-mcp process ${findHarness(harnessChoice).displayName} spawns needs it too.`);
  } else {
    steps.push(`Set ${pc.bold("ANTHROPIC_API_KEY")} (in .env or your shell).`);
  }
  steps.push(`Sharpen the mission in ${pc.bold(rel(target))} — the more specific it is, the better the report.`);
  if (!harnessChoice) steps.push(`Run ${pc.bold(`lisa run ${name}`)}${interactive ? pc.dim("  (add --headed to watch)") : ""}`);
  const next = steps.map((s, i) => `${i + 1}. ${s}`);

  if (interactive) {
    p.note(wrote.join("\n"), "Files");
    p.note(next.join("\n"), "Next");
    p.outro(pc.green(`${name} is configured.`));
  } else {
    console.log(wrote.join("\n"));
    console.log(`\nNext:\n${next.join("\n")}`);
  }

  // ---- chain into `lisa install` when the first question picked a harness ----
  if (harnessChoice) {
    const ctx = contextFor(target, opts.global ? "global" : "project");
    // `mode` is passed explicitly so `installCommand` doesn't ask the question again.
    await installCommand({ yes: opts.yes, mode: toolsMode }, ctx, harnessChoice);
  }
}
