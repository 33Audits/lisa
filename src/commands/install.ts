/**
 * `lisa install [harness]` — wire lisa into an agent harness.
 *
 * Everything here is a view of one `plan()` call:
 *   default     show the plan, confirm on a TTY, write
 *   --dry-run   show the plan, write nothing
 *   --print     dump the desired file contents for hand-placement
 *   --status    report wired / stale / not-wired and stop
 *
 * The registration carries an absolute `--config` path. The harness starts the server
 * with its own working directory, so lisa's own config discovery can't be relied on.
 */

import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { UserError, type RuntimeContext } from "../paths.js";
import {
  DEFAULT_INSTALL_SCOPE,
  DEFAULT_TOOLS_MODE,
  HARNESSES,
  applyChanges,
  changeKind,
  detectAll,
  detectTarget,
  findHarness,
  harnessIds,
  installTarget,
  statusOf,
  wiredMode,
  type FileChange,
  type Harness,
  type HarnessStatus,
  type InstallScope,
  type InstallTarget,
  type TargetOptions,
  type ToolsMode,
} from "../harness/index.js";

export interface InstallOptions {
  config?: string;
  dir?: string;
  command?: string;
  yes?: boolean;
  dryRun?: boolean;
  print?: boolean;
  status?: boolean;
  /** Undefined means "ask on a TTY, otherwise take the default". */
  mode?: ToolsMode;
  /** Once per machine (default) or committed to this repo. */
  scope?: InstallScope;
}

const KIND_LABEL = { create: pc.green("create  "), update: pc.yellow("update  "), unchanged: pc.dim("ok      ") } as const;

const STATUS_LABEL: Record<HarnessStatus, string> = {
  wired: pc.green("wired"),
  stale: pc.yellow("out of date"),
  "not-wired": pc.dim("not wired"),
};

/**
 * Paths read better relative to the directory being wired, until they'd climb out of it.
 *
 * User-scope installs climb out by design, and an absolute `/Users/you/.claude.json` in
 * the summary is noise — so anything under the home directory falls back to `~/…` rather
 * than to the full path.
 */
function rel(file: string, dir: string): string {
  const r = path.relative(dir, file);
  if (!r) return path.basename(file);
  if (!r.startsWith("..")) return r;
  const fromHome = path.relative(os.homedir(), file);
  return fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome) ? path.join("~", fromHome) : file;
}

function describe(changes: FileChange[], dir: string): string[] {
  return changes.map((c) => `${KIND_LABEL[changeKind(c)]}${rel(c.path, dir)}${pc.dim(`  — ${c.label}`)}`);
}

const DETECTED_LABEL = { yes: pc.green("detected"), no: pc.dim("not detected") } as const;

/**
 * `--list` must work before there is a config, so it detects from `cwd` rather than
 * taking an `InstallTarget` — detection needs no lisa config, and this is meant to be
 * usable before `lisa init` has ever run.
 */
export function listHarnesses(cwd: string = process.cwd()): void {
  const rows = detectAll(detectTarget(cwd));
  const idWidth = Math.max(...rows.map((r) => r.harness.id.length)) + 2;
  const nameWidth = Math.max(...rows.map((r) => r.harness.displayName.length)) + 2;
  for (const { harness: h, result } of rows) {
    console.log(`${pc.bold(h.id.padEnd(idWidth))}${h.displayName.padEnd(nameWidth)}${DETECTED_LABEL[result.installed ? "yes" : "no"]}`);
    console.log(`${" ".repeat(idWidth)}${pc.dim(h.summary)}`);
  }
}

/**
 * What `npm run setup` prints: the one-time command for this machine.
 *
 * Runs before any config exists — that is the whole point, it fires straight after the
 * build — so it detects from the cwd like `--list` does and never resolves a context.
 * With nothing detected it still prints the commands, because "no harness found" on a
 * fresh machine usually means the editor is installed elsewhere, not that there is none.
 */
export function suggestInstall(cwd: string = process.cwd()): void {
  const detected = detectAll(detectTarget(cwd)).filter((d) => d.result.installed);
  const ids = detected.length ? detected.map((d) => d.harness.id) : ["claude-code"];

  console.log(pc.bold("\nlisa is built and on your PATH.\n"));
  if (detected.length) {
    console.log(`Detected on this machine: ${detected.map((d) => pc.bold(d.harness.id)).join(", ")}`);
  } else {
    console.log(pc.dim("No harness detected here — if you use one, the command below still wires it."));
  }
  console.log(`
${pc.bold("Wire it into your agent — once per machine:")}

${ids.map((id) => `  ${pc.green(`lisa install ${id}`)}`).join("\n")}

${pc.bold("Then, in each app repo you want QA'd:")}

  ${pc.green("lisa init")}     ${pc.dim("— staging URL, login, missions")}

${pc.dim(`Later: \`lisa update\` re-applies the wiring after you pull a new lisa.
       \`lisa doctor\` says whether this machine is ready to run.`)}
`);
}

/**
 * The mode question, asked once and shared with `lisa init`'s chained install.
 *
 * The tradeoff is real rather than a default with a fallback, so the picker states it:
 * native moves the cost of reasoning off your API bill and onto your context window.
 */
export async function pickToolsMode(): Promise<ToolsMode> {
  const value = await p.select<ToolsMode>({
    message: "How should the agent run QA?",
    initialValue: DEFAULT_TOOLS_MODE,
    options: [
      {
        value: "native",
        label: "Your agent drives the browser",
        hint: "no second API key — but each page read costs tokens in your session",
      },
      {
        value: "oneshot",
        label: "lisa runs its own agent and hands back a report",
        hint: "needs ANTHROPIC_API_KEY, billed separately — cheap on your context",
      },
    ],
  });
  if (p.isCancel(value)) {
    p.cancel("Cancelled — nothing was written.");
    process.exit(130);
  }
  return value;
}

const MODE_LABEL: Record<ToolsMode, string> = { native: "native", oneshot: "oneshot" };

/** One harness, one block: detected-on-this-machine, wiring state, and a line per file it owns. */
function reportStatus(harness: Harness, target: InstallTarget, targetOpts: TargetOptions, planned?: FileChange[]): void {
  const detected = harness.detect(target);
  let changes: FileChange[];
  try {
    changes = planned ?? harness.plan(target);
  } catch (e) {
    console.log(`${pc.bold(harness.displayName)}  ${DETECTED_LABEL[detected.installed ? "yes" : "no"]}  ${pc.red("needs attention")}`);
    console.log(`  ${(e as Error).message.split("\n")[0]}`);
    return;
  }
  const status = statusOf(changes);
  // A harness wired in the *other* mode reads as "out of date" against this one. True, but
  // unhelpful on its own — say which mode it's actually in.
  let note = "";
  if (status !== "wired") {
    try {
      const actual = wiredMode(harness, target.ctx, targetOpts);
      if (actual.status === "wired" && actual.mode) {
        // Scope is called out only when it differs, for the same reason as mode: a working
        // per-repo install must not read as broken just because the default moved.
        const differs = [
          actual.mode !== target.mode ? `${MODE_LABEL[actual.mode]} mode` : null,
          actual.scope && actual.scope !== target.scope ? `${actual.scope} scope` : null,
        ].filter(Boolean);
        note = pc.dim(`  (wired in ${differs.join(", ")}, not ${MODE_LABEL[target.mode]} / ${target.scope})`);
      }
    } catch {
      // The status we already have is the answer; this was only ever a nicety.
    }
  }
  console.log(`${pc.bold(harness.displayName)}  ${DETECTED_LABEL[detected.installed ? "yes" : "no"]}  ${STATUS_LABEL[status]}${note}`);
  for (const line of describe(changes, target.dir)) console.log(`  ${line}`);
}

async function pickHarness(target: InstallTarget): Promise<Harness> {
  const value = await p.select({
    message: "Which harness should lisa be wired into?",
    options: HARNESSES.map((h) => {
      const detected = h.detect(target);
      // A broken config file in one harness shouldn't stop you choosing another.
      let state: string;
      try {
        state = STATUS_LABEL[statusOf(h.plan(target))];
      } catch {
        state = pc.red("needs attention");
      }
      return { value: h.id, label: h.displayName, hint: `${state}${detected.installed ? ", detected here" : ""}` };
    }),
  });
  if (p.isCancel(value)) {
    p.cancel("Cancelled — nothing was written.");
    process.exit(130);
  }
  return findHarness(value);
}

export async function installCommand(opts: InstallOptions, ctx: RuntimeContext, harnessId?: string): Promise<void> {
  const interactive = !opts.yes && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  // A read-only view must not stop to ask a question, so it reports against the default
  // mode. A write on a TTY does ask, because the two modes are a genuine tradeoff and not
  // a preference — see pickToolsMode.
  const readOnly = Boolean(opts.status || opts.print || opts.dryRun);
  const scope = opts.scope ?? DEFAULT_INSTALL_SCOPE;
  const optionsFor = (mode: ToolsMode): TargetOptions => ({ dir: opts.dir, command: opts.command, mode, scope });

  // Everything before the mode is settled runs against this: detection and the harness
  // picker's own wiring hints, neither of which the mode changes in any interesting way.
  const defaults = optionsFor(opts.mode ?? DEFAULT_TOOLS_MODE);
  const defaultTarget = installTarget(ctx, defaults);

  // `--status` with no harness named reports on all of them — the seed for `lisa doctor`.
  if (opts.status && !harnessId) {
    for (const h of HARNESSES) reportStatus(h, defaultTarget, defaults);
    return;
  }

  if (!harnessId && !interactive) {
    const found = detectAll(defaultTarget).filter((d) => d.result.installed);
    if (found.length) {
      console.log("Detected on this machine:");
      for (const { harness, result } of found) console.log(`  ${pc.bold(harness.id)}  ${pc.dim(result.evidence)}`);
      console.log("");
    }
    throw new UserError(
      `Which harness? Pass one of: ${harnessIds().join(", ")}\n` + `  (\`lisa install --list\` describes what each one wires up.)`,
    );
  }

  // Harness first, then mode: the picker shows each harness's wiring state, and that state
  // is mode-dependent, so asking about the mode first would report against a guess.
  const harness = harnessId ? findHarness(harnessId) : await pickHarness(defaultTarget);
  const mode = opts.mode ?? (interactive && !readOnly ? await pickToolsMode() : DEFAULT_TOOLS_MODE);
  const targetOpts = optionsFor(mode);
  const target = installTarget(ctx, targetOpts);
  const changes = harness.plan(target);

  // ---- read-only views ----
  if (opts.status) {
    reportStatus(harness, target, targetOpts, changes);
    return;
  }

  if (opts.print) {
    for (const c of changes) {
      console.log(pc.dim(`# ${rel(c.path, target.dir)} — ${c.label}`));
      console.log(c.contents.endsWith("\n") ? c.contents : c.contents + "\n");
    }
    return;
  }

  const pending = changes.filter((c) => changeKind(c) !== "unchanged");

  if (opts.dryRun) {
    console.log(`${pc.bold(harness.displayName)}  ${pc.dim(`${MODE_LABEL[mode]} mode, in ${target.dir}`)}`);
    for (const line of describe(changes, target.dir)) console.log(`  ${line}`);
    console.log(pending.length ? pc.dim(`\n${pending.length} file(s) would change. Re-run without --dry-run to apply.`) : pc.green("\nAlready wired."));
    return;
  }

  // ---- write ----
  if (interactive) p.intro(pc.bold(`lisa install ${harness.id}`));

  const detected = harness.detect(target);
  if (interactive && !detected.installed) p.log.warn(`${harness.displayName} wasn't detected here — ${detected.evidence}. Wiring it up anyway.`);

  if (!pending.length) {
    const msg = `${harness.displayName} is already wired to ${rel(ctx.configPath, target.dir)}.`;
    if (interactive) p.outro(pc.green(msg));
    else console.log(msg);
    return;
  }

  if (interactive) {
    p.note(describe(changes, target.dir).join("\n"), `Changes in ${target.dir}`);
    const go = await p.confirm({ message: "Write these files?", initialValue: true });
    if (p.isCancel(go) || !go) {
      p.cancel("Cancelled — nothing was written.");
      process.exit(130);
    }
  }

  const written = applyChanges(changes);
  const summary = written.map((c) => `${changeKind(c) === "create" ? "wrote  " : "updated"}  ${rel(c.path, target.dir)}`).join("\n");
  // The API-key step belongs to oneshot alone. Native mode's whole point is that the
  // harness's own model drives, so telling a native user to go get a Console key would be
  // telling them to solve the problem they just chose their way out of.
  const steps =
    mode === "oneshot"
      ? [...harness.nextSteps(target), `Set ANTHROPIC_API_KEY where ${harness.displayName} can see it — lisa's own agent loop needs it.`]
      : harness.nextSteps(target);
  const next = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const modeLine =
    mode === "native"
      ? `${harness.displayName} drives the browser itself — no ANTHROPIC_API_KEY needed for it (\`lisa run\` and CI still need one).`
      : `${harness.displayName} calls run_qa, and lisa drives — that needs its own ANTHROPIC_API_KEY.`;

  const scopeLine =
    scope === "user"
      ? `Installed for your whole account — every repo on this machine is wired. Re-run \`lisa update\` after upgrading lisa.`
      : `Installed into this repo, so it can be committed. Teammates who clone it still need lisa itself on their PATH.`;
  const caveat = harness.scopeNote?.(scope) ?? null;

  if (interactive) {
    p.note(summary, "Files");
    p.note(modeLine, `Mode: ${MODE_LABEL[mode]}`);
    p.note(scopeLine, `Scope: ${scope}`);
    if (caveat) p.log.warn(caveat);
    p.note(next, "Next");
    p.outro(pc.green(`lisa is wired into ${harness.displayName}.`));
  } else {
    // Name the directory: with --dir the relative paths alone don't say where they landed.
    console.log(pc.dim(`${target.dir}/`));
    console.log(summary);
    console.log(pc.dim(`\n${MODE_LABEL[mode]} mode — ${modeLine}`));
    console.log(pc.dim(`${scope} scope — ${scopeLine}`));
    if (caveat) console.log(pc.yellow(`\n⚠ ${caveat}`));
    console.log(`\nNext:\n${next}`);
  }
}
