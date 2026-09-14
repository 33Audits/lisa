#!/usr/bin/env node
/**
 * lisa — terminal app.
 *
 *   lisa init                                scaffold a config
 *   lisa install [harness]                   wire lisa into Claude Code (and friends), once per machine
 *   lisa update                              rebuild lisa and refresh that wiring
 *   lisa list                                show configured projects
 *   lisa run <project> [--headed] [--all]    run a QA session, streaming actions live
 *   lisa report <project>                    pretty-print the last report
 *   lisa reset <project>                     forget seen bugs (re-report everything)
 *   lisa where                               show which config and directories are in use
 *   lisa doctor                              check API key, Chromium, config, and harness wiring
 */

import { createRequire } from "node:module";
import { Command } from "commander";
import pc from "picocolors";
import { runProject, loadLastReport, resetState, type AgentEvent, type Report, type Bug } from "./core.js";
import { loadProjects, findProject, resolveCredentials } from "./config.js";
import { describeContext, resolveContext, UserError, type RuntimeContext } from "./paths.js";
import { loadEnvFile } from "./env.js";
import { printBanner, bannerLine } from "./banner.js";
import { initCommand, MISSION_KEYS, type MissionKey } from "./commands/init.js";
import { installCommand, listHarnesses, suggestInstall } from "./commands/install.js";
import { doctorCommand } from "./commands/doctor.js";
import { updateCommand } from "./commands/update.js";
import { harnessIds, parseInstallScope, parseToolsMode, TOOLS_MODES } from "./harness/index.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/**
 * Resolve the context and load the credentials sitting beside it. `.env` is read from
 * the config root rather than the cwd, so a global install picks up the right project's
 * secrets; anything already in process.env wins, so CI secrets are never clobbered.
 */
function context(configFlag?: string): RuntimeContext {
  const ctx = resolveContext(configFlag);
  loadEnvFile(ctx.root);
  return ctx;
}

const SEV = { critical: pc.red("CRITICAL"), major: pc.yellow("MAJOR"), minor: pc.cyan("minor") } as const;

function renderEvent(e: AgentEvent): void {
  switch (e.type) {
    case "turn":
      process.stdout.write(pc.dim(`\n[turn ${e.turn}/${e.max}] `));
      break;
    case "thinking":
      console.log(pc.italic(pc.gray(e.text)));
      break;
    case "tool_call": {
      const a = e.args;
      const detail =
        e.name === "navigate" ? a.url :
        e.name === "click" ? (a.selector ?? `"${a.text}"`) :
        // Never print a credential's value — the role name is what's informative anyway.
        e.name === "fill" ? `${a.selector} ← ${a.credential ? pc.dim(`<${a.credential}>`) : JSON.stringify(a.value)}` :
        e.name === "screenshot" ? a.name :
        e.name === "wait" ? `${a.seconds}s` :
        e.name === "submit_report" ? `${(a.bugs ?? []).length} bug(s)` : "";
      console.log(`${pc.blue("▶")} ${pc.bold(e.name)} ${pc.dim(detail)}`);
      break;
    }
    case "tool_result": {
      if (e.result.error) console.log(`  ${pc.red("✗")} ${e.result.error}`);
      else if (e.name === "read_page") {
        const ce = e.result.console_errors?.length ?? 0, fr = e.result.failed_requests?.length ?? 0;
        console.log(`  ${pc.green("✓")} ${e.result.title || e.result.url}` + (ce || fr ? pc.red(`  (${ce} console errors, ${fr} failed requests)`) : ""));
      } else if (e.name === "screenshot") console.log(`  ${pc.green("✓")} saved ${e.result.saved}`);
      break;
    }
  }
}

function renderReport(r: Report): void {
  console.log("\n" + pc.bold(pc.underline(`QA Report — ${r.project ?? ""}`)) + pc.dim(r.ran_at ? `  ${r.ran_at}` : ""));
  console.log(r.summary);
  console.log(pc.dim("Coverage: ") + (r.coverage.join(", ") || "n/a"));
  const show = (label: string, bugs: Bug[] | undefined) => {
    if (!bugs?.length) return;
    console.log("\n" + pc.bold(`${label} (${bugs.length})`));
    for (const b of bugs) {
      console.log(`\n  ${SEV[b.severity] ?? b.severity}  ${pc.bold(b.title)}`);
      console.log(`  ${pc.dim("page:")} ${b.page}`);
      b.repro_steps.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
      console.log(`  ${pc.dim("expected:")} ${b.expected}\n  ${pc.dim("actual:")}   ${b.actual}`);
      if (b.evidence) console.log(`  ${pc.dim("evidence:")} ${b.evidence}`);
    }
  };
  show("New bugs", r.new_bugs ?? r.bugs);
  show("Known bugs (still present)", r.known_bugs);
  if (!r.bugs.length) console.log("\n" + pc.green("No bugs found ✅"));
  if (r.screenshots?.length) console.log("\n" + pc.dim(`Screenshots: ${r.screenshots.join(", ")}`));
}

const program = new Command()
  .name("lisa")
  .description("Autonomous QA agent: Claude + Playwright")
  .version(version)
  .showHelpAfterError();

const withConfig = (cmd: Command) => cmd.option("-c, --config <path>", "path to lisa.config.yaml");

withConfig(program.command("init").description("scaffold a lisa.config.yaml for a project"))
  .option("-y, --yes", "don't prompt; use flags and defaults (needs --url)")
  .option("-g, --global", `write to the global config instead of this directory`)
  .option("-f, --force", "replace an existing config instead of adding to it")
  .option("--name <name>", "project name (default: this directory's name)")
  .option("--url <url>", "staging base URL")
  .option("--login", "the app needs a login")
  .option("--no-login", "the app needs no login")
  .option("--username-env <var>", "env var holding the test username")
  .option("--password-env <var>", "env var holding the test password")
  .option("--mission <kind>", `starter mission: ${MISSION_KEYS.join(" | ")}`)
  .option("--non-production", "assert the URL is not production (required by --yes on a prod-looking host)")
  .option("--harness <id|none>", `wire into an agent harness after writing the config (${harnessIds().join(" | ")}), or "none" for standalone/CI — skips the interactive question either way`)
  .option("--mode <mode>", `tool surface for the chained install: ${TOOLS_MODES.join(" | ")}`)
  .action(async (o) => {
    if (!o.yes) printBanner(version);
    await initCommand({
      config: o.config,
      global: o.global,
      yes: o.yes,
      force: o.force,
      name: o.name,
      url: o.url,
      // commander only defines `login` once --login or --no-login is seen.
      login: "login" in o ? o.login : undefined,
      usernameEnv: o.usernameEnv,
      passwordEnv: o.passwordEnv,
      mission: o.mission as MissionKey | undefined,
      nonProduction: o.nonProduction,
      harness: o.harness,
      mode: o.mode ? parseToolsMode(o.mode) : undefined,
    });
  });

withConfig(program.command("install").description("wire lisa into an agent harness"))
  .argument("[harness]", `which harness: ${harnessIds().join(" | ")}`)
  .option("-d, --dir <path>", "directory to write harness files into (default: the config's directory)")
  .option("-y, --yes", "don't prompt; just write")
  .option("-n, --dry-run", "show what would change, write nothing")
  .option("--print", "print the file contents instead of writing them")
  .option("--status", "report whether this harness is wired, and stop")
  .option("--list", "list the supported harnesses")
  .option("--command <cmd>", "override the command the harness uses to start lisa's MCP server")
  .option(
    "--mode <mode>",
    `native: your agent drives the browser (no second API key) | oneshot: lisa drives and hands back a report (needs ANTHROPIC_API_KEY)`,
  )
  .option("--scope <scope>", `user: wire once for this machine (default) | project: write into this repo so it can be committed`)
  .option("--user", "shorthand for --scope user")
  .option("--project", "shorthand for --scope project")
  .option("--suggest", "print the one-time install command for this machine, and stop")
  .action(async (harness: string | undefined, o) => {
    // --list and --suggest are catalogues, not operations: both must work before there is
    // a config, which is exactly when someone reads them.
    if (o.list) return listHarnesses();
    if (o.suggest) return suggestInstall();
    if (o.user && o.project) throw new UserError("--user and --project contradict each other. Pass one.");
    const scope = o.scope ? parseInstallScope(o.scope) : o.user ? "user" : o.project ? "project" : undefined;
    const quiet = o.yes || o.print || o.status || o.dryRun;
    if (!quiet) printBanner(version);
    await installCommand(
      {
        dir: o.dir,
        command: o.command,
        yes: o.yes,
        dryRun: o.dryRun,
        print: o.print,
        status: o.status,
        mode: o.mode ? parseToolsMode(o.mode) : undefined,
        scope,
      },
      context(o.config),
      harness,
    );
  });

withConfig(program.command("update").description("rebuild lisa and refresh the harness wiring it already installed"))
  .option("-n, --check", "report what would change, write nothing")
  .option("--no-build", "only refresh the wiring; don't pull and rebuild lisa itself")
  .action(async (o) => {
    if (!o.check) printBanner(version);
    // commander sets `build: false` for --no-build and true otherwise.
    await updateCommand({ check: o.check, noBuild: o.build === false }, context(o.config));
  });

withConfig(program.command("list").description("show configured projects")).action((o) => {
  const ctx = context(o.config);
  for (const p of loadProjects(ctx)) {
    const { missing } = resolveCredentials(p);
    const warn = missing.length ? pc.yellow(`  ⚠ unset: ${missing.join(", ")}`) : "";
    console.log(`${pc.bold(p.name)}  ${pc.dim(p.base_url)}${warn}`);
  }
});

withConfig(program.command("run").description("run a QA session"))
  .argument("[project]", "project name (or use --all)")
  .option("--all", "run every configured project")
  .option("--headed", "show the browser window while the agent works")
  .option("--slow-mo <ms>", "delay between browser actions when --headed", "250")
  .option("--no-slack", "don't post to Slack, just print")
  .option("--json", "print the raw report JSON at the end")
  .option("-m, --mission <text>", "replace the configured mission for this run (e.g. to re-verify one fix)")
  .action(async (name: string | undefined, o) => {
    const ctx = context(o.config);
    const projects = o.all ? loadProjects(ctx) : name ? [findProject(ctx, name)] : null;
    if (!projects) {
      console.error(pc.red("Provide a project name or --all. See `lisa list`."));
      process.exitCode = 1;
      return;
    }
    // Parity with the MCP server's `mission_override`: the CLI is the contract, so
    // anything an MCP-wired agent can do, an agent with only a shell must be able to too.
    if (o.mission) {
      if (o.all) throw new UserError("--mission targets one project's flows; it can't be combined with --all.");
      projects[0] = { ...projects[0], mission: o.mission };
    }
    for (const p of projects) {
      console.log("\n" + bannerLine(`→ ${p.name}`) + pc.dim(`  ${p.base_url}`));
      const report = await runProject(p, ctx, { headed: o.headed, slowMo: Number(o.slowMo), slack: o.slack, onEvent: renderEvent });
      renderReport(report);
      if (o.json) console.log("\n" + JSON.stringify(report, null, 2));
      // A webhook failure is loud but never fatal: the report is already on disk and the
      // exit code stays a statement about what QA found, not about who heard about it.
      if (report.slack_error) {
        console.error(pc.yellow(`\n⚠ Slack notification failed: ${report.slack_error}`));
        console.error(pc.dim(`  The findings above were still saved — see \`lisa report ${p.name}\`. They count as seen, so Slack won't get them on the next run.`));
      } else if (o.slack && process.env.SLACK_WEBHOOK_URL) {
        console.log(pc.dim("\nPosted to Slack."));
      }
      // exit 2 on new criticals so CI can gate on it
      if (report.new_bugs?.some((b) => b.severity === "critical")) process.exitCode = 2;
    }
  });

withConfig(program.command("report").description("show the last report for a project"))
  .argument("<project>")
  .action((name: string, o) => {
    const ctx = context(o.config);
    const r = loadLastReport(ctx, name);
    if (!r) {
      console.error(pc.red(`No report yet for ${name}. Run \`lisa run ${name}\`.`));
      process.exitCode = 1;
      return;
    }
    renderReport(r);
  });

withConfig(program.command("reset").description("forget previously-seen bugs for a project"))
  .argument("<project>")
  .action((name: string, o) => {
    const ctx = context(o.config);
    resetState(ctx, name);
    console.log(`Cleared seen-bug state for ${pc.bold(name)}.`);
  });

withConfig(program.command("where").description("show which config and directories are in use")).action((o) => {
  const ctx: RuntimeContext = context(o.config);
  for (const { label, value } of describeContext(ctx)) console.log(`  ${pc.dim(label.padEnd(10))} ${value}`);
});

withConfig(program.command("doctor").description("check the environment: API key, Chromium, config, harness wiring")).action(async (o) => {
  await doctorCommand(o.config);
});

if (process.argv.length <= 2) {
  printBanner(version);
  program.outputHelp();
  process.exit(0);
}

program.parseAsync().catch((err) => {
  // Bad config or bad flags are user errors, not crashes — no stack trace.
  if (err instanceof UserError) console.error(pc.red(err.message));
  else console.error(pc.red(err?.stack ?? String(err)));
  process.exit(1);
});
