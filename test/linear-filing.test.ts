/**
 * A bug gets exactly one Linear issue, however many times lisa sees it.
 *
 * lisa runs on a cron, so a bug that takes a week to fix is found five times. Without the
 * fingerprint→issue map that is five identical issues, and a tracker that duplicates is worse
 * than no tracker at all. These tests pin the map's behaviour from the outside — what was
 * asked of Linear, and what is on disk afterwards — plus the guarantee that borrows its shape
 * from the Slack contract: a tracker outage costs you the tickets, never the QA run.
 *
 *   npm test
 */

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { finishReport, fileReportToLinear, resetState, type Bug, type ProjectConfig, type Report } from "../src/core.js";
import { DEFAULT_SEVERITY_PRIORITY, type LinearSettings } from "../src/config.js";
import { issueDescription, issueTitle, readIssueMap, MAX_ISSUES_PER_RUN } from "../src/linear.js";
import { contextFor, type RuntimeContext } from "../src/paths.js";

// ---------- fixtures ----------

const LINEAR: LinearSettings = {
  api_key_env: "LISA_TEST_LINEAR_KEY",
  team: "ENG",
  labels: [],
  severity_priority: DEFAULT_SEVERITY_PRIORITY,
};

const PROJECT: ProjectConfig = {
  name: "acme",
  base_url: "https://staging.acme.test",
  allowed_host: "staging.acme.test",
  credentials_env: {},
  mission: "Click around.",
  linear: LINEAR,
};

function aBug(title = "Checkout button does nothing"): Bug {
  return {
    title,
    severity: "critical",
    page: "/checkout",
    repro_steps: ["Add an item", "Click Checkout"],
    expected: "Order confirmation",
    actual: "Nothing happens",
  };
}

function draft(bugs: Bug[]): Report {
  return { summary: "One run.", coverage: ["/checkout"], bugs };
}

function tempContext(): RuntimeContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-linear-"));
  const configPath = path.join(root, "lisa.config.yaml");
  fs.writeFileSync(configPath, "projects: []\n");
  return contextFor(configPath, "project");
}

// ---------- a Linear we control ----------

/** Every GraphQL operation the server was asked for, in order, as `issueCreate` / `teams` / … */
let ops: string[] = [];
let created: { title: string; description: string; priority: number; labelIds?: string[] }[] = [];
let comments: { issueId: string; body: string }[] = [];
let failWith: number | null = null;
/** Start failing once this many issues have been created. `null` never does. */
let failAfterCreates: number | null = null;
let issueSeq = 0;

const TEAM = { id: "team-uuid-1", key: "ENG", name: "Engineering" };
const LABELS = [{ id: "label-uuid-1", name: "qa-agent" }];
const PROJECTS = [{ id: "project-uuid-1", name: "QA Bugs" }];

function respond(query: string, variables: any): unknown {
  if (query.includes("teams(")) return { teams: { nodes: [TEAM] } };
  if (query.includes("team(id:")) return { team: { projects: { nodes: PROJECTS }, labels: { nodes: LABELS } } };
  if (query.includes("issueCreate")) {
    if (failAfterCreates !== null && created.length >= failAfterCreates) throw new Error("rate limited");
    created.push(variables.input);
    issueSeq++;
    return { issueCreate: { success: true, issue: { id: `issue-${issueSeq}`, identifier: `ENG-${issueSeq}`, url: `https://linear.app/acme/issue/ENG-${issueSeq}` } } };
  }
  if (query.includes("commentCreate")) {
    comments.push(variables.input);
    return { commentCreate: { success: true } };
  }
  throw new Error(`fake Linear got an unexpected query: ${query.slice(0, 60)}`);
}

function opName(query: string): string {
  for (const name of ["teams(", "team(id:", "issueCreate", "commentCreate"]) {
    if (query.includes(name)) return name.replace(/[(:]/g, "");
  }
  return "unknown";
}

let api: http.Server;

/**
 * `LISA_STATE_DIR` / `LISA_ARTIFACTS_DIR` would override the temp ctx and send every assertion
 * below at a developer's real state; `SLACK_WEBHOOK_URL` would make these tests post to a real
 * channel. All cleared for the suite, restored after.
 */
const OVERRIDDEN = ["SLACK_WEBHOOK_URL", "LISA_STATE_DIR", "LISA_ARTIFACTS_DIR", "LISA_LINEAR_ENDPOINT", "LISA_TEST_LINEAR_KEY"] as const;
const saved: Record<string, string | undefined> = {};

before(async () => {
  for (const key of OVERRIDDEN) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  api = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (failWith) {
        res.writeHead(failWith, { "Content-Type": "text/plain" });
        res.end("upstream is having a moment");
        return;
      }
      const { query, variables } = JSON.parse(body);
      ops.push(opName(query));
      // Build the payload first: Linear answers a refused operation with HTTP 200 and an
      // `errors` array, and writing the header before we know which one it is would leave a
      // thrown refusal with the headers already sent.
      let payload: string;
      try {
        payload = JSON.stringify({ data: respond(query, variables) });
      } catch (e: any) {
        payload = JSON.stringify({ errors: [{ message: e.message }] });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  process.env.LISA_LINEAR_ENDPOINT = `http://127.0.0.1:${(api.address() as AddressInfo).port}/graphql`;
  process.env.LISA_TEST_LINEAR_KEY = "lin_api_test";
});

after(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  for (const key of OVERRIDDEN) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

beforeEach(() => {
  ops = [];
  created = [];
  comments = [];
  failWith = null;
  failAfterCreates = null;
  issueSeq = 0;
});

// ---------- the point of the whole thing ----------

describe("Linear filing", () => {
  it("files a new bug as one issue and records which issue it became", async () => {
    const ctx = tempContext();

    const report = await finishReport(PROJECT, ctx, draft([aBug()]));

    assert.equal(created.length, 1, "exactly one issue was created");
    assert.equal(report.linear_issues?.length, 1);
    assert.equal(report.linear_issues?.[0].action, "created");
    assert.equal(report.linear_issues?.[0].identifier, "ENG-1");
    assert.equal(report.linear_error, undefined, "a healthy Linear leaves no error");

    const map = readIssueMap(ctx, PROJECT.name);
    const refs = Object.values(map);
    assert.equal(refs.length, 1, "the fingerprint→issue map is on disk");
    assert.equal(refs[0].identifier, "ENG-1");
  });

  it("comments on the second sighting instead of filing a duplicate", async () => {
    const ctx = tempContext();

    await finishReport(PROJECT, ctx, draft([aBug()]));
    const second = await finishReport(PROJECT, ctx, draft([aBug()]));

    assert.equal(created.length, 1, "still exactly one issue across both runs");
    assert.equal(comments.length, 1, "the re-sighting became a comment");
    assert.equal(comments[0].issueId, "issue-1", "on the issue it already had");
    assert.match(comments[0].body, /Still present/);
    assert.equal(second.new_bugs?.length, 0, "and the bug is known, not new");
    assert.equal(second.linear_issues?.[0].action, "commented");
  });

  it("keeps the run alive when Linear is down, and re-files that bug next time", async () => {
    const ctx = tempContext();
    failWith = 503;

    const report = await finishReport(PROJECT, ctx, draft([aBug()]));

    assert.match(report.linear_error ?? "", /503/, "the failure is named on the report");
    assert.equal(report.new_bugs?.length, 1, "the finding survived");
    assert.ok(fs.existsSync(path.join(ctx.artifactsDir, `report-${PROJECT.name}.json`)), "the artifact was still written");
    assert.deepEqual(readIssueMap(ctx, PROJECT.name), {}, "nothing was recorded as filed");

    // The bug is `known` by now, so only the map can get it filed — which is exactly what it
    // is for. A tracker outage must not mean the issue never exists.
    failWith = null;
    await finishReport(PROJECT, ctx, draft([aBug()]));
    assert.equal(created.length, 1, "the retry filed it");
    assert.equal(comments.length, 0, "and did not comment on an issue that never existed");
  });

  it("keeps the issues it filed before the failure, and doesn't duplicate them later", async () => {
    const ctx = tempContext();
    // Linear accepts the first issue then starts refusing. The one that exists must be on the
    // report and in the map — an issue created and then forgotten is a duplicate next run, and
    // no later step can un-create it.
    failAfterCreates = 1;

    const report = await finishReport(PROJECT, ctx, draft([aBug("First"), aBug("Second")]));

    assert.equal(created.length, 1, "one got through");
    assert.equal(report.linear_issues?.length, 1, "and it is on the report, not lost to the throw");
    assert.match(report.linear_error ?? "", /rate limited/, "the failure is named too");
    assert.equal(Object.keys(readIssueMap(ctx, PROJECT.name)).length, 1, "the map knows about it");

    failAfterCreates = null;
    await finishReport(PROJECT, ctx, draft([aBug("First"), aBug("Second")]));
    assert.equal(created.length, 2, "the retry filed only the one that was missing");
    assert.equal(comments.length, 1, "and commented on the one that already existed");
  });

  it("does not touch Linear at all when filing is opted out", async () => {
    const ctx = tempContext();

    const report = await finishReport(PROJECT, ctx, draft([aBug()]), { linear: false });

    assert.deepEqual(ops, [], "not a single request");
    assert.equal(report.linear_issues, undefined);
    assert.equal(report.linear_error, undefined);
  });

  it("does nothing when the project has no linear: block", async () => {
    const ctx = tempContext();
    const { linear, ...bare } = PROJECT;

    const report = await finishReport(bare as ProjectConfig, ctx, draft([aBug()]));

    assert.deepEqual(ops, [], "an unconfigured project is silent, not an error");
    assert.equal(report.linear_error, undefined);
    assert.equal(report.new_bugs?.length, 1);
  });

  it("does nothing when the API key env var is unset", async () => {
    const ctx = tempContext();
    delete process.env.LISA_TEST_LINEAR_KEY;
    try {
      const report = await finishReport(PROJECT, ctx, draft([aBug()]));
      assert.deepEqual(ops, [], "no key, no requests");
      assert.equal(report.linear_error, undefined, "a machine without the secret isn't a failure");
    } finally {
      process.env.LISA_TEST_LINEAR_KEY = "lin_api_test";
    }
  });

  it("re-files from scratch after a reset", async () => {
    const ctx = tempContext();
    await finishReport(PROJECT, ctx, draft([aBug()]));

    resetState(ctx, PROJECT.name);
    assert.deepEqual(readIssueMap(ctx, PROJECT.name), {}, "reset clears the issue map too");

    await finishReport(PROJECT, ctx, draft([aBug()]));
    assert.equal(created.length, 2, "a second issue — which is what reset asked for");
    assert.equal(comments.length, 0);
  });

  it("names an unknown team rather than filing into the wrong one", async () => {
    const ctx = tempContext();
    const wrongTeam = { ...PROJECT, linear: { ...LINEAR, team: "DESIGN" } };

    const report = await finishReport(wrongTeam, ctx, draft([aBug()]));

    assert.match(report.linear_error ?? "", /no Linear team "DESIGN"/);
    assert.match(report.linear_error ?? "", /ENG/, "and says which teams exist");
    assert.equal(created.length, 0);
  });

  it("resolves a label name to its id, and refuses to silently drop a typo", async () => {
    const ctx = tempContext();

    const ok = await finishReport({ ...PROJECT, linear: { ...LINEAR, labels: ["qa-agent"] } }, ctx, draft([aBug()]));
    assert.equal(ok.linear_error, undefined);
    assert.deepEqual(created[0].labelIds, ["label-uuid-1"]);

    const typo = await finishReport({ ...PROJECT, name: "acme2", linear: { ...LINEAR, labels: ["qa-agnet"] } }, ctx, draft([aBug()]));
    assert.match(typo.linear_error ?? "", /no Linear label "qa-agnet"/);
  });

  it("holds back the overflow past the per-run cap and says so", async () => {
    const ctx = tempContext();
    const many = Array.from({ length: MAX_ISSUES_PER_RUN + 3 }, (_, i) => aBug(`Bug ${i}`));

    const report = await finishReport(PROJECT, ctx, draft(many));

    assert.equal(created.length, MAX_ISSUES_PER_RUN, "the cap held");
    assert.match(report.linear_error ?? "", /held back 3/);
    assert.equal(report.linear_issues?.length, MAX_ISSUES_PER_RUN, "what did file is still recorded");
    assert.equal(report.new_bugs?.length, MAX_ISSUES_PER_RUN + 3, "every finding is in the report regardless");
  });
});

// ---------- the triage path ----------

describe("fileReportToLinear", () => {
  it("files only the titles it was given", async () => {
    const ctx = tempContext();
    const report = await finishReport(PROJECT, ctx, draft([aBug("Fixed it already"), aBug("Not fixing this one")]), { linear: false });

    const updated = await fileReportToLinear(PROJECT, ctx, report, ["Not fixing this one"]);

    assert.equal(created.length, 1);
    assert.match(created[0].title, /Not fixing this one/);
    assert.equal(updated.linear_issues?.length, 1);
  });

  it("writes the issues back onto the stored report", async () => {
    const ctx = tempContext();
    const report = await finishReport(PROJECT, ctx, draft([aBug()]), { linear: false });

    await fileReportToLinear(PROJECT, ctx, report);

    const onDisk = JSON.parse(fs.readFileSync(path.join(ctx.artifactsDir, `report-${PROJECT.name}.json`), "utf-8")) as Report;
    assert.equal(onDisk.linear_issues?.length, 1, "`lisa report` will show it too");
  });

  it("refuses a title that isn't in the report instead of filing nothing quietly", async () => {
    const ctx = tempContext();
    const report = await finishReport(PROJECT, ctx, draft([aBug()]), { linear: false });

    await assert.rejects(() => fileReportToLinear(PROJECT, ctx, report, ["A bug nobody found"]), /Filed nothing/);
    assert.equal(created.length, 0);
  });

  it("explains the missing key rather than failing obscurely", async () => {
    const ctx = tempContext();
    const report = await finishReport(PROJECT, ctx, draft([aBug()]), { linear: false });
    delete process.env.LISA_TEST_LINEAR_KEY;
    try {
      await assert.rejects(() => fileReportToLinear(PROJECT, ctx, report), /LISA_TEST_LINEAR_KEY is not set/);
    } finally {
      process.env.LISA_TEST_LINEAR_KEY = "lin_api_test";
    }
  });
});

// ---------- the body an engineer opens cold ----------

describe("issue body", () => {
  it("leads with the severity so a triage list reads at a glance", () => {
    assert.equal(issueTitle(aBug("Cart total is wrong")), "[QA/Critical] Cart total is wrong");
  });

  it("carries repro steps, the verdict, and the fingerprint that survives state loss", () => {
    const body = issueDescription(aBug(), { ...draft([]), ran_at: "2026-09-14T10:00:00Z", screenshots: ["/tmp/shot.png"] }, "acme", "abc123");

    assert.match(body, /1\. Add an item/);
    assert.match(body, /\*\*Expected:\*\* Order confirmation/);
    assert.match(body, /\*\*Actual:\*\* Nothing happens/);
    assert.match(body, /\/tmp\/shot\.png/);
    assert.match(body, /Fingerprint `abc123`/, "searchable even if .lisa/state is gone");
  });
});
