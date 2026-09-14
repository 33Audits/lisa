/**
 * A Slack outage must not swallow a QA run.
 *
 * `finishReport` used to commit the seen-bug state *before* writing the artifact, with a
 * throwing Slack post in between. One flaky webhook therefore marked every bug seen with no
 * report on disk — and the next run classified those same bugs as `known_bugs`, suppressing
 * them silently until someone ran `lisa reset`.
 *
 * These tests pin the ordering that fixes it (classify → notify → write → commit) from the
 * outside: what is on disk after the call, not which function called which.
 *
 *   npm test
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { finishReport, type Bug, type ProjectConfig, type Report } from "../src/core.js";
import { contextFor, type RuntimeContext } from "../src/paths.js";

// ---------- fixtures ----------

const PROJECT: ProjectConfig = {
  name: "acme",
  base_url: "https://staging.acme.test",
  allowed_host: "staging.acme.test",
  credentials_env: {},
  mission: "Click around.",
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

/** A throwaway ctx rooted in a temp dir, so state/artifacts can be inspected and torn down. */
function tempContext(): RuntimeContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-durability-"));
  const configPath = path.join(root, "lisa.config.yaml");
  fs.writeFileSync(configPath, "projects: []\n");
  return contextFor(configPath, "project");
}

function statePath(ctx: RuntimeContext): string {
  return path.join(ctx.stateDir, `${PROJECT.name}.json`);
}

function artifactPath(ctx: RuntimeContext): string {
  return path.join(ctx.artifactsDir, `report-${PROJECT.name}.json`);
}

function seenFingerprints(ctx: RuntimeContext): string[] {
  const f = statePath(ctx);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf-8")) as string[]) : [];
}

// ---------- a webhook we control ----------

/**
 * `LISA_STATE_DIR` / `LISA_ARTIFACTS_DIR` would override the temp ctx's directories and send
 * every assertion below at a developer's real state file, so they are cleared for the suite.
 */
const OVERRIDDEN = ["SLACK_WEBHOOK_URL", "LISA_STATE_DIR", "LISA_ARTIFACTS_DIR"] as const;
const saved: Record<string, string | undefined> = {};

let webhook: http.Server;
let webhookUrl: string;
let status = 500;
let hits = 0;

before(async () => {
  for (const key of OVERRIDDEN) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  webhook = http.createServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end(status >= 400 ? "no_service" : "ok");
    });
  });
  await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
  webhookUrl = `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/hook`;
});

after(async () => {
  await new Promise<void>((resolve) => webhook.close(() => resolve()));
  for (const key of OVERRIDDEN) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

// ---------- the regression ----------

describe("finishReport durability", () => {
  it("files the report and records the failure when the webhook 500s", async () => {
    const ctx = tempContext();
    status = 500;
    process.env.SLACK_WEBHOOK_URL = webhookUrl;
    const hitsBefore = hits;

    const report = await finishReport(PROJECT, ctx, draft([aBug()]));

    assert.equal(hits, hitsBefore + 1, "the webhook was actually called");
    assert.ok(fs.existsSync(artifactPath(ctx)), "report-<project>.json is on disk");
    assert.equal(report.new_bugs?.length, 1, "the bug is reported as new");
    assert.match(report.slack_error ?? "", /500/, "slack_error names the status code");

    const onDisk = JSON.parse(fs.readFileSync(artifactPath(ctx), "utf-8")) as Report;
    assert.equal(onDisk.slack_error, report.slack_error, "the artifact carries it too — one write, not two");
  });

  it("advances the seen state exactly once, and only after the artifact exists", async () => {
    const ctx = tempContext();
    status = 500;
    process.env.SLACK_WEBHOOK_URL = webhookUrl;

    await finishReport(PROJECT, ctx, draft([aBug()]));
    const afterFirst = seenFingerprints(ctx);
    assert.equal(afterFirst.length, 1, "one fingerprint committed");

    status = 200;
    const second = await finishReport(PROJECT, ctx, draft([aBug()]));
    assert.equal(second.new_bugs?.length, 0, "the same bug is no longer new");
    assert.equal(second.known_bugs?.length, 1, "it comes back as known");
    assert.equal(second.slack_error, undefined, "a healthy webhook leaves no slack_error");
    assert.deepEqual(seenFingerprints(ctx), afterFirst, "state did not grow on the second run");
  });

  it("leaves the seen state untouched when the artifact write fails", { skip: process.getuid?.() === 0 && "runs as root: a read-only dir wouldn't stop the write" }, async () => {
    const ctx = tempContext();
    delete process.env.SLACK_WEBHOOK_URL;
    fs.mkdirSync(ctx.artifactsDir, { recursive: true });
    fs.chmodSync(ctx.artifactsDir, 0o555);

    try {
      await assert.rejects(finishReport(PROJECT, ctx, draft([aBug()])), "an undeliverable report still throws");
      assert.deepEqual(seenFingerprints(ctx), [], "nothing was marked seen");
    } finally {
      fs.chmodSync(ctx.artifactsDir, 0o755);
    }

    // The whole point of decision 1: the next run re-reports rather than suppressing.
    const retry = await finishReport(PROJECT, ctx, draft([aBug()]));
    assert.equal(retry.new_bugs?.length, 1, "the bug is still new on the next run");
  });

  it("leaves the common path byte-identical when no webhook is configured", async () => {
    const ctx = tempContext();
    delete process.env.SLACK_WEBHOOK_URL;
    const hitsBefore = hits;

    const report = await finishReport(PROJECT, ctx, draft([aBug()]));

    assert.equal(hits, hitsBefore, "nothing was posted");
    assert.equal(report.slack_error, undefined);
    const onDisk = fs.readFileSync(artifactPath(ctx), "utf-8");
    assert.ok(!onDisk.includes("slack_error"), "the key is absent from the artifact, not null");
  });

  it("does not post at all when slack is opted out, even with a webhook set", async () => {
    const ctx = tempContext();
    status = 500;
    process.env.SLACK_WEBHOOK_URL = webhookUrl;
    const hitsBefore = hits;

    const report = await finishReport(PROJECT, ctx, draft([aBug()]), { slack: false });

    assert.equal(hits, hitsBefore, "--no-slack means no request");
    assert.equal(report.slack_error, undefined);
    assert.ok(fs.existsSync(artifactPath(ctx)));
  });
});
