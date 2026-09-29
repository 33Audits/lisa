/**
 * Real-browser deterministic-harness evidence — no LLM, no Anthropic API key, no simulation.
 *
 * `bench/lib/simulate.ts` models mission outcomes with pure math; this module is the other
 * half of "deterministic harness evidence" the benchmark is required to produce: it drives
 * Lisa's actual `BrowserSession` (real Playwright, real Chromium) against a tiny local fixture
 * app with two seeded, deterministic defects, and asserts — with plain string checks, not an
 * LLM's judgment — that Lisa's primitives detect them. If this ever fails, it means Lisa's own
 * `navigate`/`click`/`read_page` primitives broke, independent of anything routing- or
 * model-related.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { BrowserSession } from "../../src/core.js";
import { startFixtureServer } from "./fixture-server.js";

export interface BrowserSmokeResult {
  evidence: "deterministic-harness";
  method: "real-playwright-browser-no-llm";
  ranAt: string;
  passed: boolean;
  checks: {
    navigateOk: boolean;
    clickOk: boolean;
    consoleErrorDetected: boolean;
    failedRequestDetected: boolean;
  };
  detail: string[];
  error?: string;
}

export async function runBrowserSmoke(): Promise<BrowserSmokeResult> {
  const ranAt = new Date().toISOString();
  const detail: string[] = [];
  const checks = { navigateOk: false, clickOk: false, consoleErrorDetected: false, failedRequestDetected: false };
  const fixture = await startFixtureServer();
  const shotsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-bench-smoke-"));
  const session = new BrowserSession(fixture.host, shotsDir, "bench-smoke", {});

  try {
    await session.launch();

    const nav = await session.handle("navigate", { url: fixture.url });
    checks.navigateOk = Boolean(nav.ok);
    detail.push(`navigate -> ${JSON.stringify(nav)}`);

    // Give the fixture page's background fetch("/api/data") time to actually fail before we
    // read the page — it fires on load but resolves asynchronously.
    await session.handle("wait", { seconds: 1 });

    const click = await session.handle("click", { selector: "#broken-btn" });
    checks.clickOk = Boolean(click.ok);
    detail.push(`click -> ${JSON.stringify(click)}`);

    const read = await session.handle("read_page", {});
    const consoleErrors: string[] = read.console_errors ?? [];
    const failedRequests: string[] = read.failed_requests ?? [];
    checks.consoleErrorDetected = consoleErrors.some((e) => e.includes("BROKEN_BUTTON_BUG"));
    checks.failedRequestDetected = failedRequests.some((f) => f.includes("/api/data") && f.includes("500"));
    detail.push(`console_errors -> ${JSON.stringify(consoleErrors)}`);
    detail.push(`failed_requests -> ${JSON.stringify(failedRequests)}`);

    const passed = Object.values(checks).every(Boolean);
    return { evidence: "deterministic-harness", method: "real-playwright-browser-no-llm", ranAt, passed, checks, detail };
  } catch (e: any) {
    detail.push(`error -> ${String(e?.message ?? e)}`);
    return { evidence: "deterministic-harness", method: "real-playwright-browser-no-llm", ranAt, passed: false, checks, detail, error: String(e?.message ?? e).slice(0, 500) };
  } finally {
    await session.close().catch(() => {});
    await fixture.close();
    fs.rmSync(shotsDir, { recursive: true, force: true });
  }
}
