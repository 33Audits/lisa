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
import { loadConfig, resolveCredentials } from "../config.js";
import { chromiumInstalled } from "../browser.js";
import { HARNESSES, installTarget, statusOf, type HarnessStatus } from "../harness/index.js";

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

export async function doctorCommand(configFlag?: string): Promise<void> {
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

  if (ctx) {
    for (const { label, value } of describeContext(ctx)) console.log(`  ${pc.dim(label.padEnd(10))} ${value}`);
    console.log("");
  }

  console.log(pc.bold("Environment"));
  if (process.env.ANTHROPIC_API_KEY) check("ok", "ANTHROPIC_API_KEY is set");
  else fail("ANTHROPIC_API_KEY is not set — the agent loop calls the Claude API directly");

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
    } catch (e) {
      fail(firstLine(e));
    }
  }

  console.log("\n" + pc.bold("Harnesses"));
  if (!ctx) {
    console.log(pc.dim("  (skipped — no config)"));
  } else {
    const target = installTarget(ctx);
    const width = Math.max(...HARNESSES.map((h) => h.id.length)) + 2;
    for (const h of HARNESSES) {
      try {
        console.log(`  ${h.id.padEnd(width)}${STATUS_LABEL[statusOf(h.plan(target))]}`);
      } catch (e) {
        console.log(`  ${h.id.padEnd(width)}${pc.red("needs attention")}  ${pc.dim(firstLine(e))}`);
      }
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
