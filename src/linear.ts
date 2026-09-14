/**
 * Linear filing: a new bug becomes an issue, a re-sighting becomes a comment on the one it
 * already has.
 *
 * The whole design hangs off that second sentence. lisa runs on a cron, so a bug that takes a
 * week to fix is seen five times — without a fingerprint→issue map those are five identical
 * issues, and a tracker that duplicates is worse than no tracker. The map is the feature; the
 * GraphQL is plumbing.
 *
 * Nothing here writes to stdout (same rule as core.ts). Errors travel to `finishReport`, which
 * turns them into `report.linear_error` — so a Linear outage costs you the tickets and never
 * the QA run.
 *
 * Transport is bare `fetch`, matching `postToSlack` and the registry check in update-check.ts
 * — Linear is one endpoint and one header, which is not worth a dependency.
 */

import fs from "node:fs";
import path from "node:path";
import { ensureDir, type RuntimeContext } from "./paths.js";
import type { LinearSettings, Severity } from "./config.js";
import type { Bug, Report } from "./core.js";

const TIMEOUT_MS = 15_000;

/**
 * Read per call rather than frozen at import, so the tests can stand a fake Linear in front of
 * it. Doubles as the escape hatch for anyone routing through a proxy.
 */
function endpoint(): string {
  return process.env.LISA_LINEAR_ENDPOINT ?? "https://api.linear.app/graphql";
}

/**
 * How many issues one run may create. A run that finds forty bugs is a broken deploy, not
 * forty tickets, and forty issues is a mess someone has to close by hand. Mirrors the
 * `slice(0, 10)` postToSlack already applies for the same reason.
 */
export const MAX_ISSUES_PER_RUN = 10;

export interface LinearIssueRef {
  issueId: string;
  identifier: string;
  url: string;
  filed_at: string;
}

/** What a run did in Linear. Lands on the report so the CLI and a calling agent can both see it. */
export interface FiledIssue {
  fingerprint: string;
  identifier: string;
  url: string;
  action: "created" | "commented";
}

/** fingerprint -> the issue it became. */
export type IssueMap = Record<string, LinearIssueRef>;

// ---------- the fingerprint -> issue map ----------

/**
 * A sibling of the seen-bug state file, never a change to it.
 *
 * `<project>.json` is a bare JSON array that the CI job caches between runs; widening it into
 * an object would make every cached state file from before this feature unreadable. A second
 * file costs one `existsSync` and breaks nothing.
 */
export function issueMapPath(ctx: RuntimeContext, projectName: string): string {
  return path.join(ctx.stateDir, `${projectName}.linear.json`);
}

export function readIssueMap(ctx: RuntimeContext, projectName: string): IssueMap {
  const f = issueMapPath(ctx, projectName);
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, "utf-8")) as IssueMap;
  } catch {
    // A corrupt map must not take the run down with it. Losing it costs duplicate issues on
    // the next sighting, which is recoverable; throwing here costs the report, which isn't.
    return {};
  }
}

export function writeIssueMap(ctx: RuntimeContext, projectName: string, map: IssueMap): void {
  ensureDir(ctx.stateDir);
  fs.writeFileSync(issueMapPath(ctx, projectName), JSON.stringify(map, null, 2));
}

export function clearIssueMap(ctx: RuntimeContext, projectName: string): void {
  const f = issueMapPath(ctx, projectName);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// ---------- GraphQL transport ----------

/**
 * Linear answers a malformed query with HTTP 200 and a top-level `errors` array, so `res.ok`
 * on its own reports success for a request that did nothing. Both are checked.
 */
async function gql<T>(key: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(endpoint(), {
    method: "POST",
    // Personal API keys go in bare — no "Bearer " prefix. That is OAuth's shape, and using it
    // here fails as an opaque 401.
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from Linear: ${body.slice(0, 200)}`);
  let parsed: { data?: T; errors?: { message: string }[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Linear returned non-JSON: ${body.slice(0, 200)}`);
  }
  if (parsed.errors?.length) throw new Error(`Linear: ${parsed.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
  if (!parsed.data) throw new Error("Linear returned no data");
  return parsed.data;
}

// ---------- resolving names to ids ----------

interface Node {
  id: string;
  name: string;
}

interface TeamNode extends Node {
  key: string;
}

/**
 * Everything `createIssue` needs as Linear ids, resolved once per run.
 *
 * Names in config, ids on the wire: `team: ENG` is what a person can write down and check,
 * and a UUID in a YAML file is a thing nobody can verify by reading it.
 */
export interface ResolvedTarget {
  teamId: string;
  projectId?: string;
  labelIds: string[];
}

export async function resolveTarget(key: string, settings: LinearSettings): Promise<ResolvedTarget> {
  const data = await gql<{ teams: { nodes: TeamNode[] } }>(
    key,
    `query { teams(first: 250) { nodes { id key name } } }`,
  );
  const teams = data.teams.nodes;
  const wanted = settings.team.toLowerCase();
  const team = teams.find((t) => t.key.toLowerCase() === wanted || t.id === settings.team);
  if (!team) {
    throw new Error(`no Linear team "${settings.team}". Available: ${teams.map((t) => t.key).join(", ") || "(none)"}`);
  }

  const target: ResolvedTarget = { teamId: team.id, labelIds: [] };
  if (!settings.project && !settings.labels.length) return target;

  const detail = await gql<{ team: { projects: { nodes: Node[] }; labels: { nodes: Node[] } } }>(
    key,
    `query($id: String!) { team(id: $id) {
       projects(first: 250) { nodes { id name } }
       labels(first: 250) { nodes { id name } }
     } }`,
    { id: team.id },
  );

  if (settings.project) {
    const match = detail.team.projects.nodes.find((p) => p.name.toLowerCase() === settings.project!.toLowerCase());
    if (!match) {
      throw new Error(
        `no Linear project "${settings.project}" on team ${team.key}. ` +
          `Available: ${detail.team.projects.nodes.map((p) => p.name).join(", ") || "(none)"}`,
      );
    }
    target.projectId = match.id;
  }

  // A mistyped label that silently vanishes is the failure mode to avoid: the issues get
  // filed, nobody's saved view picks them up, and the config looks right. Name it instead.
  for (const label of settings.labels) {
    const match = detail.team.labels.nodes.find((l) => l.name.toLowerCase() === label.toLowerCase());
    if (!match) {
      throw new Error(
        `no Linear label "${label}" on team ${team.key}. ` +
          `Available: ${detail.team.labels.nodes.map((l) => l.name).join(", ") || "(none)"}`,
      );
    }
    target.labelIds.push(match.id);
  }
  return target;
}

// ---------- the issue body ----------

const SEVERITY_WORD: Record<Severity, string> = { critical: "Critical", major: "Major", minor: "Minor" };

export function issueTitle(bug: Bug): string {
  return `[QA/${SEVERITY_WORD[bug.severity] ?? bug.severity}] ${bug.title}`.slice(0, 250);
}

/**
 * The issue body an engineer opens cold.
 *
 * The fingerprint in the footer is the recovery path: if `.lisa/state` is lost — a fresh
 * clone, a cleared CI cache — searching Linear for it still finds the issue this bug already
 * has. Without it, state loss means silent duplicates with no way to notice.
 */
export function issueDescription(bug: Bug, report: Report, projectName: string, fingerprint: string): string {
  const steps = bug.repro_steps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "_none recorded_";
  const lines = [
    `**Page:** ${bug.page}`,
    "",
    "**Steps to reproduce**",
    steps,
    "",
    `**Expected:** ${bug.expected}`,
    `**Actual:** ${bug.actual}`,
  ];
  if (bug.evidence) lines.push(`**Evidence:** ${bug.evidence}`);
  if (report.screenshots?.length) {
    lines.push("", "**Screenshots**", ...report.screenshots.map((s) => `- \`${s}\``));
  }
  lines.push(
    "",
    "---",
    `Filed by [lisa](https://github.com/JeffreyJoel/qa-agent-ts) from the \`${projectName}\` QA run` +
      (report.ran_at ? ` at ${report.ran_at}` : "") +
      `. Fingerprint \`${fingerprint}\`.`,
  );
  return lines.join("\n");
}

// ---------- mutations ----------

export async function createIssue(
  key: string,
  settings: LinearSettings,
  target: ResolvedTarget,
  bug: Bug,
  report: Report,
  projectName: string,
  fingerprint: string,
): Promise<LinearIssueRef> {
  const data = await gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null } }>(
    key,
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) {
       success issue { id identifier url }
     } }`,
    {
      input: {
        teamId: target.teamId,
        title: issueTitle(bug),
        description: issueDescription(bug, report, projectName, fingerprint),
        priority: settings.severity_priority[bug.severity],
        ...(target.projectId ? { projectId: target.projectId } : {}),
        ...(target.labelIds.length ? { labelIds: target.labelIds } : {}),
      },
    },
  );
  if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error("Linear refused the issue without saying why");
  const { id, identifier, url } = data.issueCreate.issue;
  return { issueId: id, identifier, url, filed_at: new Date().toISOString() };
}

export async function addComment(key: string, issueId: string, body: string): Promise<void> {
  const data = await gql<{ commentCreate: { success: boolean } }>(
    key,
    `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
    { input: { issueId, body } },
  );
  if (!data.commentCreate.success) throw new Error("Linear refused the comment without saying why");
}

// ---------- the run ----------

/**
 * File one run's findings. New bugs become issues; known bugs that already have one get a
 * "still present" comment.
 *
 * The map is written after **every** create, not once at the end, and that is the opposite of
 * the `commitSeen` discipline on purpose. There, state must not run ahead of the artifact —
 * being wrong means re-reporting, which is recoverable. Here, state must not lag a side effect
 * that already happened in someone else's system: an issue created and then forgotten is a
 * duplicate on the next run, and no later step can undo the create. So each one is recorded
 * the moment it exists.
 *
 * For the same reason this returns its error instead of throwing it — the one function here
 * that does. A throw halfway through would unwind past the issues already created, and the
 * report would then be the only place they *weren't* recorded. `filed` is always what actually
 * happened, error or not.
 */
export async function fileToLinear(
  key: string,
  settings: LinearSettings,
  ctx: RuntimeContext,
  projectName: string,
  report: Report,
  fresh: { bug: Bug; fingerprint: string }[],
  known: { bug: Bug; fingerprint: string }[],
): Promise<{ filed: FiledIssue[]; error?: string }> {
  const map = readIssueMap(ctx, projectName);
  const filed: FiledIssue[] = [];

  // The map decides what already has an issue — not the new/known split.
  //
  // Those two disagree exactly when it matters. A bug that failed to file during a Linear
  // outage is `known` by the next run, so keying off `fresh` would mean the outage silently
  // cost it its issue forever. Keying off the map instead makes the next run pick it up, and
  // costs nothing on the happy path: a filed bug is in the map either way. `lisa reset` clears
  // the map alongside the seen state, so anything still in it was genuinely filed before.
  const all = [...fresh, ...known];
  const toCreate = all.filter((f) => !map[f.fingerprint]);
  const toComment = all.filter((f) => map[f.fingerprint]);
  const overflow = Math.max(0, toCreate.length - MAX_ISSUES_PER_RUN);

  try {
    const target = await resolveTarget(key, settings);

    for (const { bug, fingerprint } of toCreate.slice(0, MAX_ISSUES_PER_RUN)) {
      const ref = await createIssue(key, settings, target, bug, report, projectName, fingerprint);
      map[fingerprint] = ref;
      writeIssueMap(ctx, projectName, map);
      filed.push({ fingerprint, identifier: ref.identifier, url: ref.url, action: "created" });
    }

    // Deduped by issue: two bugs whose fingerprints differ but which landed on the same issue
    // get one comment, not two.
    const commented = new Set<string>();
    const when = report.ran_at ?? new Date().toISOString();
    for (const { bug, fingerprint } of toComment) {
      const ref = map[fingerprint];
      if (commented.has(ref.issueId)) continue;
      commented.add(ref.issueId);
      await addComment(key, ref.issueId, `Still present as of ${when} — reproduced again on \`${bug.page}\` by the \`${projectName}\` QA run.`);
      filed.push({ fingerprint, identifier: ref.identifier, url: ref.url, action: "commented" });
    }
  } catch (e: any) {
    return { filed, error: String(e?.message ?? e).slice(0, 300) };
  }

  if (overflow) {
    return {
      filed,
      error:
        `${toCreate.length} new bugs exceeded the ${MAX_ISSUES_PER_RUN}-issue cap for one run — filed ${MAX_ISSUES_PER_RUN}, ` +
        `held back ${overflow}. They are in the report and will file on the next run.`,
    };
  }
  return { filed };
}
