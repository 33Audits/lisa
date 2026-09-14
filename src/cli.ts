#!/usr/bin/env node
/**
 * lisa — terminal app.
 *
 *   lisa list                                show configured projects
 *   lisa run <project> [--headed] [--all]    run a QA session, streaming actions live
 *   lisa report <project>                    pretty-print the last report
 *   lisa reset <project>                     forget seen bugs (re-report everything)
 *   lisa where                               show which config and directories are in use
 */

import { createRequire } from "node:module";
import { Command } from "commander";
import pc from "picocolors";
import { runProject, loadLastReport, resetState, type AgentEvent, type Report, type Bug } from "./core.js";
import { loadProjects, findProject, resolveCredentials } from "./config.js";
import { resolveContext, ConfigNotFoundError, type RuntimeContext } from "./paths.js";
import { printBanner, bannerLine } from "./banner.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

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
        e.name === "fill" ? `${a.selector} ← ${JSON.stringify(a.value)}` :
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

withConfig(program.command("list").description("show configured projects")).action((o) => {
  const ctx = resolveContext(o.config);
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
  .action(async (name: string | undefined, o) => {
    const ctx = resolveContext(o.config);
    const projects = o.all ? loadProjects(ctx) : name ? [findProject(ctx, name)] : null;
    if (!projects) {
      console.error(pc.red("Provide a project name or --all. See `lisa list`."));
      process.exitCode = 1;
      return;
    }
    for (const p of projects) {
      console.log("\n" + bannerLine(`→ ${p.name}`) + pc.dim(`  ${p.base_url}`));
      const report = await runProject(p, ctx, { headed: o.headed, slowMo: Number(o.slowMo), slack: o.slack, onEvent: renderEvent });
      renderReport(report);
      if (o.json) console.log("\n" + JSON.stringify(report, null, 2));
      if (o.slack && process.env.SLACK_WEBHOOK_URL) console.log(pc.dim("\nPosted to Slack."));
      // exit 2 on new criticals so CI can gate on it
      if (report.new_bugs?.some((b) => b.severity === "critical")) process.exitCode = 2;
    }
  });

withConfig(program.command("report").description("show the last report for a project"))
  .argument("<project>")
  .action((name: string, o) => {
    const ctx = resolveContext(o.config);
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
    const ctx = resolveContext(o.config);
    resetState(ctx, name);
    console.log(`Cleared seen-bug state for ${pc.bold(name)}.`);
  });

withConfig(program.command("where").description("show which config and directories are in use")).action((o) => {
  const ctx: RuntimeContext = resolveContext(o.config);
  const row = (k: string, v: string) => console.log(`  ${pc.dim(k.padEnd(10))} ${v}`);
  row("scope", ctx.scope);
  row("config", ctx.configPath);
  row("state", ctx.stateDir);
  row("artifacts", ctx.artifactsDir);
});

if (process.argv.length <= 2) {
  printBanner(version);
  program.outputHelp();
  process.exit(0);
}

program.parseAsync().catch((err) => {
  // Config problems are user errors, not crashes — no stack trace.
  if (err instanceof ConfigNotFoundError) console.error(pc.red(err.message));
  else console.error(pc.red(err?.stack ?? String(err)));
  process.exit(1);
});
