/**
 * Chromium lifecycle.
 *
 * Installed lazily on first launch instead of via a `postinstall` hook — a global
 * `npm install -g lisa-cli` (or any install where you already have a browser wired up
 * some other way) shouldn't pull ~150MB unprompted. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`
 * opts out of the auto-download; `chromiumInstalled()` alone (no download) is what
 * `lisa doctor` uses to report status without side effects.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import pc from "picocolors";
import { UserError } from "./paths.js";

const require = createRequire(import.meta.url);

/** Read-only: does playwright's own cache already have Chromium? No download attempted. */
export function chromiumInstalled(): boolean {
  try {
    const exe = chromium.executablePath();
    return Boolean(exe) && fs.existsSync(exe);
  } catch {
    return false;
  }
}

function playwrightCli(): string {
  // Resolve against *our* dependency, not whatever `playwright` happens to be on PATH —
  // a version mismatch between the CLI and the library downloads the wrong browser build.
  const pkg = require.resolve("playwright/package.json");
  return path.join(path.dirname(pkg), "cli.js");
}

/**
 * Called right before the first `chromium.launch()` of a process. Installs on the spot
 * if missing; a no-op (one `existsSync` check) every time after that.
 */
export function ensureChromium(): void {
  if (chromiumInstalled()) return;

  if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
    throw new UserError(
      "Chromium isn't installed, and PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set so lisa won't download it.\n" +
        "  Install it yourself: npx playwright install chromium",
    );
  }

  // stderr, never stdout: `lisa-mcp` uses stdout as the JSON-RPC transport, and the first
  // browser launch on a fresh machine happens *inside* a tool call. A download notice or a
  // progress bar on stdout is not noise there — it corrupts the protocol stream. The CLI
  // renders progress on stderr just as well, so there is no reason to ever write stdout here.
  console.error(pc.dim("First run: downloading Chromium (one-time, ~150MB)…"));
  let cli: string;
  try {
    cli = playwrightCli();
  } catch {
    throw new UserError("Couldn't locate playwright's CLI to install Chromium. Run `npx playwright install chromium` yourself.");
  }
  // ["ignore", "ignore", 2]: the installer's own stdout is discarded rather than inherited.
  const result = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: ["ignore", "ignore", 2] });
  if (result.status !== 0 || !chromiumInstalled()) {
    throw new UserError("Failed to install Chromium. Run `npx playwright install chromium` yourself and try again.");
  }
}
