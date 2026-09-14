/**
 * "There's a newer lisa" — and, once it lands, "here's what changed and what you have to do".
 *
 * Two halves that share one small state file:
 *
 *   1. A *pending-update* nudge. Every ordinary command prints at most one line saying the
 *      install is behind, with the exact command to fix it. The line is rendered from a
 *      cache; the network/git work that fills the cache runs detached, after the command
 *      has already finished, so no command ever waits on it. That means a freshly released
 *      version is announced on the run after the one that noticed it — the same trade npm
 *      makes, and the right one: a QA run must not block on a registry being slow.
 *
 *   2. A *just-updated* summary. The state file remembers which version last ran, so when a
 *      newer one starts, lisa prints the CHANGELOG sections between the two — with
 *      `### Actions required` in full. This is the half that survives either upgrade path:
 *      `lisa update` for a checkout, `npm i -g lisa-cli@latest` for a package install, both
 *      simply end with a different version running.
 *
 * The nudge is decoration (suppressed off-TTY, in CI, on request). The just-updated summary
 * is not — it can be the only place a breaking change is stated — so it only obeys an
 * explicit opt-out.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { globalDataDir } from "./paths.js";
import { packageRoot } from "./templates.js";

/** How long a cached check stays good. Long enough that most invocations do no work at all. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Hidden argv the detached refresh process is spawned with. */
export const REFRESH_ARGV = "__refresh-update-check";

export type InstallKind = "git" | "npm";

interface State {
  checked_at?: string;
  kind?: InstallKind;
  /** npm installs: the version the registry calls latest. */
  latest?: string;
  /** git checkouts: commits on the upstream branch that aren't in HEAD. */
  behind?: number;
  /** The lisa version that last ran here — the anchor for the just-updated summary. */
  last_seen_version?: string;
}

/** Is the lisa package a git working tree we can pull, or an installed artifact? */
export function checkoutRoot(): string | null {
  const root = packageRoot();
  return fs.existsSync(path.join(root, ".git")) ? root : null;
}

export function installKind(): InstallKind {
  return checkoutRoot() ? "git" : "npm";
}

/**
 * Machine-level, not per-project: an install is one thing on the machine, and a nudge that
 * reappeared once per repo would be noise.
 */
export function statePath(): string {
  return path.join(globalDataDir(), "update-check.json");
}

export function readState(): State {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf-8")) as unknown;
    return raw && typeof raw === "object" ? (raw as State) : {};
  } catch {
    // A missing or corrupt cache means "check again", never a failure. This file is
    // disposable by construction.
    return {};
  }
}

export function writeState(next: State): void {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(next, null, 2) + "\n");
  } catch {
    // A read-only HOME degrades to "check every time", which is still correct.
  }
}

/** Numeric semver compare; a prerelease suffix sorts before its release. -1 | 0 | 1. */
export function cmpVersion(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ""] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

// ---------------------------------------------------------------------------
// CHANGELOG.md
// ---------------------------------------------------------------------------

export interface Release {
  version: string;
  /** Section heading -> bullet lines, in file order. */
  sections: { heading: string; bullets: string[] }[];
}

const ACTIONS_HEADING = "actions required";

/**
 * Parse `## [x.y.z] - date` releases and their `### Section` bullets.
 *
 * Deliberately forgiving: an unparseable file yields no releases, and the caller falls back
 * to "see CHANGELOG.md". A changelog that has drifted should never be able to break a run.
 */
export function parseChangelog(text: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let section: { heading: string; bullets: string[] } | null = null;

  for (const line of text.split("\n")) {
    const head = /^##\s+\[?v?(\d+\.\d+\.\d+[\w.-]*)\]?/.exec(line);
    if (head) {
      release = { version: head[1], sections: [] };
      section = null;
      releases.push(release);
      continue;
    }
    if (!release) continue;
    const sub = /^###\s+(.+?)\s*$/.exec(line);
    if (sub) {
      section = { heading: sub[1], bullets: [] };
      release.sections.push(section);
      continue;
    }
    if (!section) continue;
    const bullet = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (bullet) {
      section.bullets.push(bullet[1]);
      continue;
    }
    // A wrapped bullet: an indented continuation line belongs to the bullet above it.
    // Without this, an entry long enough to wrap in the source file loses everything after
    // its first line — and a truncated "Actions required" is worse than none.
    const cont = /^\s+(\S.*?)\s*$/.exec(line);
    if (cont && section.bullets.length) section.bullets[section.bullets.length - 1] += ` ${cont[1]}`;
  }
  return releases.filter((r) => r.sections.length > 0);
}

export function changelogPath(): string {
  return path.join(packageRoot(), "CHANGELOG.md");
}

export function readChangelog(): Release[] {
  try {
    return parseChangelog(fs.readFileSync(changelogPath(), "utf-8"));
  } catch {
    return [];
  }
}

/** Releases in `(from, to]`, newest first. `from` is exclusive: you already ran it. */
export function releasesBetween(releases: Release[], from: string, to: string): Release[] {
  return releases
    .filter((r) => cmpVersion(r.version, from) > 0 && cmpVersion(r.version, to) <= 0)
    .sort((a, b) => cmpVersion(b.version, a.version));
}

function isActions(heading: string): boolean {
  return heading.trim().toLowerCase() === ACTIONS_HEADING;
}

/**
 * Render the delta. `Actions required` prints in full and first, because it is the only part
 * that obliges the reader to do something; the rest is trimmed to a few lines with a pointer
 * to the file, since a wall of release notes in front of a QA run just gets scrolled past.
 */
export function renderReleases(releases: Release[], opts: { restOfNotes?: number } = {}): string[] {
  const cap = opts.restOfNotes ?? 4;
  const out: string[] = [];

  for (const r of releases) {
    out.push(`  ${pc.bold(`v${r.version}`)}`);
    for (const s of r.sections.filter((s) => isActions(s.heading))) {
      out.push(`    ${pc.yellow(pc.bold("Actions required"))}`);
      for (const b of s.bullets) out.push(`      ${pc.yellow("→")} ${b}`);
    }
    const rest = r.sections.filter((s) => !isActions(s.heading)).flatMap((s) => s.bullets.map((b) => `${s.heading}: ${b}`));
    for (const line of rest.slice(0, cap)) out.push(`    ${pc.dim(`• ${line}`)}`);
    if (rest.length > cap) out.push(`    ${pc.dim(`• …${rest.length - cap} more`)}`);
  }
  return out;
}

/** True when any release in the delta obliges the reader to do something. */
export function hasActions(releases: Release[]): boolean {
  return releases.some((r) => r.sections.some((s) => isActions(s.heading) && s.bullets.length > 0));
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

function optedOut(): boolean {
  return Boolean(process.env.LISA_NO_UPDATE_CHECK);
}

/** The nudge is decoration; the just-updated summary is not, so they gate differently. */
function nudgeAllowed(): boolean {
  return !optedOut() && Boolean(process.stderr.isTTY) && !process.env.CI;
}

/** One line naming the pending update and the exact command that applies it. */
export function pendingLine(state: State, current: string): string | null {
  if (state.kind === "git" && (state.behind ?? 0) > 0) {
    const n = state.behind as number;
    return `lisa is ${n} commit${n === 1 ? "" : "s"} behind origin — run \`lisa update\` to pull, rebuild, and refresh the harness wiring.`;
  }
  if (state.kind === "npm" && state.latest && cmpVersion(state.latest, current) > 0) {
    return `lisa ${state.latest} is available (you have ${current}) — run \`npm i -g lisa-cli@latest\`, then \`lisa update\` to refresh the harness wiring.`;
  }
  return null;
}

/**
 * Print the "you're now on a newer version" summary, and return whether anything printed.
 *
 * Also the place `last_seen_version` advances, so a delta is announced exactly once — the
 * caller may pass `state` it has already read to keep this to a single write.
 */
export function reportUpgrade(current: string, state: State = readState()): boolean {
  const previous = state.last_seen_version;
  if (previous === current) return false;

  // First run ever, or a downgrade (a `git checkout` of an older tag, a pinned reinstall):
  // record and stay quiet. There is no forward delta to narrate.
  if (!previous || cmpVersion(current, previous) <= 0) {
    writeState({ ...state, last_seen_version: current });
    return false;
  }

  // A newer version is running, so whatever the cache said was pending has been applied.
  writeState({ ...state, last_seen_version: current, behind: 0, latest: current });
  if (optedOut()) return false;

  const delta = releasesBetween(readChangelog(), previous, current);
  const lines = [pc.bold(pc.green(`\nUpdated to lisa v${current}`)) + pc.dim(`  (was ${previous})`)];
  if (delta.length) {
    lines.push(...renderReleases(delta));
    if (!hasActions(delta)) lines.push(pc.dim("  Nothing to do — the wiring lisa already installed still matches."));
  } else {
    // The version moved but the changelog doesn't cover it. Say so rather than implying
    // there were no changes.
    lines.push(pc.dim(`  No changelog entry for this version — see ${changelogPath()}`));
  }
  lines.push(pc.dim(`  Full notes: ${changelogPath()}\n`));
  console.error(lines.join("\n"));
  return true;
}

/**
 * Called once before every ordinary command. Prints at most one notice, then schedules the
 * refresh that will make the *next* invocation accurate.
 */
export function updateNotice(current: string): void {
  const state = readState();
  const upgraded = reportUpgrade(current, state);

  if (!upgraded && nudgeAllowed()) {
    const line = pendingLine(state, current);
    if (line) console.error(pc.yellow(`\n⚠ ${line}\n`));
  }

  const age = state.checked_at ? Date.now() - Date.parse(state.checked_at) : Infinity;
  if (!optedOut() && !process.env.CI && !(age < MAX_AGE_MS)) scheduleRefresh();
}

/**
 * Spawn the refresh detached and forget it. `unref` plus ignored stdio means this process
 * exits on its own schedule and the child's output can never interleave with a report.
 */
function scheduleRefresh(): void {
  try {
    const entry = process.argv[1];
    if (!entry) return;
    spawn(process.execPath, [entry, REFRESH_ARGV], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Best-effort by design: failing to schedule a check is not worth a word to the user.
  }
}

// ---------------------------------------------------------------------------
// The refresh itself (runs in the detached child)
// ---------------------------------------------------------------------------

/** Commits on the tracked upstream branch that aren't in HEAD. `null` when there's no upstream. */
function commitsBehind(root: string): number | null {
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf-8", timeout: 20_000 });
  if (git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).status !== 0) return null;
  // Fetch refs only — never touches the working tree, so this is safe to run behind the
  // user's back while they have uncommitted work.
  git(["fetch", "--quiet"]);
  const r = git(["rev-list", "--count", "HEAD..@{u}"]);
  const n = Number.parseInt((r.stdout ?? "").trim(), 10);
  return r.status === 0 && Number.isFinite(n) ? n : null;
}

async function latestOnNpm(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}/latest`, {
      headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * Refresh the cache. Always stamps `checked_at`, including on failure — otherwise an
 * offline machine would spawn a doomed child on every single command.
 */
export async function refreshUpdateCheck(packageName: string): Promise<void> {
  const state = readState();
  const root = checkoutRoot();
  const next: State = { ...state, kind: root ? "git" : "npm", checked_at: new Date().toISOString() };

  if (root) next.behind = commitsBehind(root) ?? 0;
  else next.latest = (await latestOnNpm(packageName)) ?? state.latest;

  writeState(next);
}
