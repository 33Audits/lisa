/**
 * `lisa doctor` — is this machine set up to run lisa?
 *
 * Extends `lisa where`: same config/state/artifact rows, plus the things that make a
 * run actually succeed — an API key, a Chromium binary, a config that parses, and
 * which harnesses are wired. Never throws: a missing config or a broken project entry
 * is exactly the kind of thing you run `doctor` to find, so each check is reported
 * inline instead of aborting the rest.
 */

import pc from "picocolors";
import { describeContext, resolveContext, type RuntimeContext } from "../paths.js";
import { loadConfig, resolveCredentials, type ProjectConfig } from "../config.js";
import { resolveTarget } from "../linear.js";
import { loadEnvFile } from "../env.js";
import { chromiumInstalled } from "../browser.js";
import { HARNESSES, wiredMode, type HarnessStatus, type InstallScope, type ToolsMode } from "../harness/index.js";
import { installKind, pendingLine, readState } from "../update-check.js";

type Level = "ok" | "warn" | "fail";

const ICON: Record<Level, string> = { ok: pc.green("✓"), warn: pc.yellow("⚠"), fail: pc.red("✗") };

function check(level: Level, text: string): Level {
  console.log(`  ${ICON[level]} ${text}`);
  return level;
}

const STATUS_LABEL: Record<HarnessStatus, string> = {
  wired: pc.green("wired"),
  stale: pc.yellow("out of date"),
  "not-wired": pc.dim("not wired"),
};

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0];
}

interface HarnessRow {
  id: string;
  status: HarnessStatus;
  mode: ToolsMode | null;
  scope: InstallScope | null;
  error?: string;
}

/**
 * Wiring state per harness, computed once and read twice: for the Harnesses section, and
 * for the API-key verdict — which depends on whether anything is wired in native mode.
 */
function harnessRows(ctx: RuntimeContext): HarnessRow[] {
  return HARNESSES.map((h) => {
    try {
      return { id: h.id, ...wiredMode(h, ctx) };
    } catch (e) {
      return { id: h.id, status: "not-wired" as const, mode: null, scope: null, error: firstLine(e) };
    }
  });
}

/**
 * Whether this install is behind, straight from the cache the notice path fills — doctor is
 * a report, so it never goes to the network and never makes the user wait.
 */
function versionCheck(current: string): void {
  const state = readState();
  const pending = pendingLine(state, current);
  if (pending) check("warn", pending);
  else if (!state.checked_at) check("ok", `lisa ${current} (${installKind()} install) — no update check has run yet`);
  else check("ok", `lisa ${current} is up to date` + pc.dim(`  (checked ${state.checked_at})`));
}

/**
 * Whether Linear filing would actually work, per project.
 *
 * This is the one check that goes to the network, and it earns it: resolving the team is the
 * only way to tell a working key from a revoked one, and a typo'd team key from a real one.
 * Everything it can find — no block, no key, bad key, bad team — is a ⚠ rather than a ✗:
 * Linear is opt-in, so none of it means lisa is broken, only that no issues will be filed.
 */
async function linearChecks(projects: ProjectConfig[]): Promise<void> {
  const configured = projects.filter((p) => p.linear);
  if (!configured.length) return;

  // One probe per distinct team+key pair — the common case is every project sharing the
  // global block, and doctor should not make the same round trip five times to say so.
  const probed = new Map<string, string | null>();
  for (const p of configured) {
    const settings = p.linear!;
    const key = process.env[settings.api_key_env];
    if (!key) {
      check("warn", `${p.name}: Linear configured but ${settings.api_key_env} is not set — no issues will be filed`);
      continue;
    }
    const cacheKey = `${settings.api_key_env}|${settings.team}|${settings.project ?? ""}|${settings.labels.join(",")}`;
    if (!probed.has(cacheKey)) {
      try {
        await resolveTarget(key, settings);
        probed.set(cacheKey, null);
      } catch (e) {
        probed.set(cacheKey, firstLine(e));
      }
    }
    const error = probed.get(cacheKey);
    if (error) check("warn", `${p.name}: Linear — ${error}`);
    else check("ok", `${p.name}: Linear team ${settings.team}`);
  }
}

export async function doctorCommand(configFlag?: string, version = "unknown"): Promise<void> {
  let hardFailure = false;
  const fail = (text: string) => {
    check("fail", text);
    hardFailure = true;
  };

  let ctx: RuntimeContext | null = null;
  let configError: unknown = null;
  try {
    ctx = resolveContext(configFlag);
  } catch (e) {
    configError = e;
  }

  // Same as every other command's `.env` handling: loaded from the config's directory,
  // never the cwd, and only fills in what process.env doesn't already have. Without this,
  // a key correctly sitting in `.env` reads here as "not set".
  if (ctx) loadEnvFile(ctx.root);

  if (ctx) {
    for (const { label, value } of describeContext(ctx)) console.log(`  ${pc.dim(label.padEnd(10))} ${value}`);
    console.log("");
  }

  // Computed before the Environment section because the API-key verdict depends on it.
  const rows = ctx ? harnessRows(ctx) : [];
  const nativeWired = rows.some((r) => r.status === "wired" && r.mode === "native");

  console.log(pc.bold("Environment"));
  versionCheck(version);
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    check("ok", "ANTHROPIC_API_KEY is set");
  } else if (nativeWired) {
    // Not a failure: a native install's whole point is that the harness's model drives, so
    // nothing here is broken. But `lisa run` and CI do still call the API directly, so
    // silence would be wrong too.
    check("warn", "ANTHROPIC_API_KEY is not set — fine for your native harness wiring, but `lisa run` and CI need one");
  } else {
    fail("ANTHROPIC_API_KEY is not set — the agent loop calls the Claude API directly");
  }

  if (chromiumInstalled()) check("ok", "Chromium is installed");
  else check("warn", "Chromium isn't installed yet — `lisa run` downloads it on first use (skip with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)");

  console.log("\n" + pc.bold("Config"));
  if (!ctx) {
    fail(configError ? firstLine(configError) : "no config found — run `lisa init`");
  } else {
    try {
      const projects = loadConfig(ctx).projects;
      check("ok", `parses — ${projects.length} project${projects.length === 1 ? "" : "s"}`);
      for (const p of projects) {
        const { missing } = resolveCredentials(p);
        if (missing.length) check("warn", `${p.name}: missing ${missing.join(", ")}`);
        else check("ok", `${p.name}: credentials set`);
      }
      await linearChecks(projects);
    } catch (e) {
      fail(firstLine(e));
    }
  }

  console.log("\n" + pc.bold("Harnesses"));
  if (!ctx) {
    console.log(pc.dim("  (skipped — no config)"));
  } else {
    const width = Math.max(...HARNESSES.map((h) => h.id.length)) + 2;
    for (const row of rows) {
      if (row.error) {
        console.log(`  ${row.id.padEnd(width)}${pc.red("needs attention")}  ${pc.dim(row.error)}`);
        continue;
      }
      // Naming the mode is the whole reason doctor checks every combination: "wired"
      // without it can't distinguish an install that needs an API key from one that
      // doesn't. Scope rides along for the same reason — it tells you whether a new repo
      // will already be wired or still needs `lisa install`.
      const facts = [row.scope, row.mode].filter(Boolean).join(", ");
      console.log(`  ${row.id.padEnd(width)}${STATUS_LABEL[row.status]}${facts ? pc.dim(`  (${facts})`) : ""}`);
    }
  }

  console.log("");
  if (hardFailure) {
    console.log(pc.red("Some checks failed — fix the ✗ items above."));
    process.exitCode = 1;
  } else {
    console.log(pc.green("Everything checks out."));
  }
}
