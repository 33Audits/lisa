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

import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { UserError, type RuntimeContext } from "../paths.js";
import {
  HARNESSES,
  applyChanges,
  changeKind,
  detectAll,
  detectTarget,
  findHarness,
  harnessIds,
  installTarget,
  statusOf,
  type FileChange,
  type Harness,
  type HarnessStatus,
  type InstallTarget,
} from "../harness/index.js";

export interface InstallOptions {
  config?: string;
  dir?: string;
  command?: string;
  yes?: boolean;
  dryRun?: boolean;
  print?: boolean;
  status?: boolean;
}

const KIND_LABEL = { create: pc.green("create  "), update: pc.yellow("update  "), unchanged: pc.dim("ok      ") } as const;

const STATUS_LABEL: Record<HarnessStatus, string> = {
  wired: pc.green("wired"),
  stale: pc.yellow("out of date"),
  "not-wired": pc.dim("not wired"),
};

/** Paths read better relative to the directory being wired, until they'd climb out of it. */
function rel(file: string, dir: string): string {
  const r = path.relative(dir, file);
  return !r ? path.basename(file) : r.startsWith("..") ? file : r;
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
  for (const { harness: h, result } of detectAll(detectTarget(cwd))) {
    console.log(`${pc.bold(h.id.padEnd(14))} ${h.displayName.padEnd(14)} ${DETECTED_LABEL[result.installed ? "yes" : "no"]}`);
    console.log(`${" ".repeat(15)}${pc.dim(h.summary)}`);
  }
}

/** One harness, one block: detected-on-this-machine, wiring state, and a line per file it owns. */
function reportStatus(harness: Harness, target: InstallTarget, planned?: FileChange[]): void {
  const detected = harness.detect(target);
  let changes: FileChange[];
  try {
    changes = planned ?? harness.plan(target);
  } catch (e) {
    console.log(`${pc.bold(harness.displayName)}  ${DETECTED_LABEL[detected.installed ? "yes" : "no"]}  ${pc.red("needs attention")}`);
    console.log(`  ${(e as Error).message.split("\n")[0]}`);
    return;
  }
  console.log(`${pc.bold(harness.displayName)}  ${DETECTED_LABEL[detected.installed ? "yes" : "no"]}  ${STATUS_LABEL[statusOf(changes)]}`);
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
  const target = installTarget(ctx, { dir: opts.dir, command: opts.command });

  // `--status` with no harness named reports on all of them — the seed for `lisa doctor`.
  if (opts.status && !harnessId) {
    for (const h of HARNESSES) reportStatus(h, target);
    return;
  }

  if (!harnessId && !interactive) {
    const found = detectAll(target).filter((d) => d.result.installed);
    if (found.length) {
      console.log("Detected on this machine:");
      for (const { harness, result } of found) console.log(`  ${pc.bold(harness.id)}  ${pc.dim(result.evidence)}`);
      console.log("");
    }
    throw new UserError(
      `Which harness? Pass one of: ${harnessIds().join(", ")}\n` + `  (\`lisa install --list\` describes what each one wires up.)`,
    );
  }

  const harness = harnessId ? findHarness(harnessId) : await pickHarness(target);
  const changes = harness.plan(target);

  // ---- read-only views ----
  if (opts.status) {
    reportStatus(harness, target, changes);
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
    console.log(`${pc.bold(harness.displayName)}  ${pc.dim(`in ${target.dir}`)}`);
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
  const next = harness.nextSteps(target).map((s, i) => `${i + 1}. ${s}`).join("\n");

  if (interactive) {
    p.note(summary, "Files");
    p.note(next, "Next");
    p.outro(pc.green(`lisa is wired into ${harness.displayName}.`));
  } else {
    // Name the directory: with --dir the relative paths alone don't say where they landed.
    console.log(pc.dim(`${target.dir}/`));
    console.log(summary);
    console.log(`\nNext:\n${next}`);
  }
}
