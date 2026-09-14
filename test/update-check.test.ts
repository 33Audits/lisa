/**
 * The update notice: what the user is told, and when.
 *
 * The properties worth pinning are the ones a wrong answer makes user-hostile:
 *
 *   - A delta is announced exactly once. `last_seen_version` advances on the run that
 *     prints it, so the next command is quiet.
 *   - A downgrade or a first run says nothing. There is no forward delta to narrate, and
 *     inventing one ("updated to 1.0.0") on a fresh install is noise.
 *   - `Actions required` survives the trim. Everything else in a release is capped, but the
 *     part that obliges the reader to do something is printed in full — that is the whole
 *     reason the changelog is read at all.
 *   - The pending-update line names the command that actually applies the update, which
 *     differs by install shape: `lisa update` for a checkout, `npm i -g` for a package.
 *
 *   npm test
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cmpVersion,
  hasActions,
  parseChangelog,
  pendingLine,
  readState,
  releasesBetween,
  renderReleases,
  reportUpgrade,
  statePath,
} from "../src/update-check.js";

const CHANGELOG = `# Changelog

## [1.2.0] - 2026-09-14

### Actions required

- Re-run \`lisa install claude-code\`, the brief names new tools.
- Rename \`credentials_env.user\` to \`username\`,
  which is what the schema now validates.

### Added

- Native mode.
- Slack threading.
- A fourth thing.
- A fifth thing.
- A sixth thing.

## [1.1.0] - 2026-08-01

### Fixed

- Slack no longer eats the report.

## [1.0.0] - 2026-07-01

### Added

- First release.
`;

/** Point the state file at a throwaway HOME so tests never touch the real cache. */
function sandbox(): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-update-"));
  const saved = { ...process.env };
  process.env.XDG_STATE_HOME = home;
  // The notice path is gated off in CI and behind an opt-out; clear both so the tests
  // exercise the real thing rather than the early return.
  delete process.env.CI;
  delete process.env.LISA_NO_UPDATE_CHECK;
  return {
    home,
    cleanup: () => {
      process.env = saved;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

describe("cmpVersion", () => {
  it("orders by numeric component, not lexically", () => {
    assert.equal(cmpVersion("1.10.0", "1.9.0"), 1);
    assert.equal(cmpVersion("2.0.0", "10.0.0"), -1);
    assert.equal(cmpVersion("1.0.0", "1.0.0"), 0);
    assert.equal(cmpVersion("v1.0.1", "1.0.0"), 1);
  });

  it("sorts a prerelease before its release", () => {
    assert.equal(cmpVersion("1.1.0-beta.1", "1.1.0"), -1);
    assert.equal(cmpVersion("1.1.0", "1.1.0-beta.1"), 1);
  });
});

describe("changelog", () => {
  const releases = parseChangelog(CHANGELOG);

  it("parses each release and its sections", () => {
    assert.deepEqual(releases.map((r) => r.version), ["1.2.0", "1.1.0", "1.0.0"]);
    assert.deepEqual(releases[0].sections.map((s) => s.heading), ["Actions required", "Added"]);
    assert.equal(releases[0].sections[0].bullets.length, 2);
  });

  it("takes the delta exclusive of the version you already ran, newest first", () => {
    const delta = releasesBetween(releases, "1.0.0", "1.2.0");
    assert.deepEqual(delta.map((r) => r.version), ["1.2.0", "1.1.0"]);
    assert.equal(hasActions(delta), true);
    assert.equal(hasActions(releasesBetween(releases, "1.0.0", "1.1.0")), false);
  });

  it("prints every action but trims the rest of the notes", () => {
    const out = renderReleases(releasesBetween(releases, "1.1.0", "1.2.0"), { restOfNotes: 2 }).join("\n");
    assert.match(out, /Re-run `lisa install claude-code`/);
    // The wrapped half of the bullet has to survive: a truncated action is worse than none.
    assert.match(out, /Rename `credentials_env.user` to `username`, which is what the schema now validates\./);
    assert.match(out, /…3 more/);
  });

  it("ignores a file it cannot parse rather than throwing", () => {
    assert.deepEqual(parseChangelog("nothing to see here"), []);
  });
});

describe("pendingLine", () => {
  it("tells a checkout to run lisa update", () => {
    const line = pendingLine({ kind: "git", behind: 3 }, "1.0.0");
    assert.match(String(line), /3 commits behind/);
    assert.match(String(line), /lisa update/);
  });

  it("tells a package install to upgrade through npm", () => {
    const line = pendingLine({ kind: "npm", latest: "1.2.0" }, "1.0.0");
    assert.match(String(line), /npm i -g lisa-cli@latest/);
  });

  it("says nothing when the install is current", () => {
    assert.equal(pendingLine({ kind: "git", behind: 0 }, "1.0.0"), null);
    assert.equal(pendingLine({ kind: "npm", latest: "1.0.0" }, "1.0.0"), null);
    assert.equal(pendingLine({}, "1.0.0"), null);
  });
});

describe("reportUpgrade", () => {
  let box: ReturnType<typeof sandbox>;
  const quiet = <T>(fn: () => T): T => {
    const err = console.error;
    console.error = () => {};
    try {
      return fn();
    } finally {
      console.error = err;
    }
  };

  beforeEach(() => {
    box = sandbox();
  });
  afterEach(() => box.cleanup());

  it("says nothing on a first run, but remembers the version", () => {
    assert.equal(quiet(() => reportUpgrade("1.0.0")), false);
    assert.equal(readState().last_seen_version, "1.0.0");
  });

  it("announces a newer version exactly once", () => {
    quiet(() => reportUpgrade("1.0.0"));
    assert.equal(quiet(() => reportUpgrade("1.2.0")), true);
    assert.equal(quiet(() => reportUpgrade("1.2.0")), false, "a second run must stay quiet");
    assert.equal(readState().last_seen_version, "1.2.0");
  });

  it("clears the pending flag, because the update it referred to has landed", () => {
    quiet(() => reportUpgrade("1.0.0"));
    fs.writeFileSync(statePath(), JSON.stringify({ last_seen_version: "1.0.0", kind: "git", behind: 7 }));
    quiet(() => reportUpgrade("1.2.0"));
    assert.equal(readState().behind, 0);
  });

  it("stays quiet on a downgrade", () => {
    quiet(() => reportUpgrade("1.2.0"));
    assert.equal(quiet(() => reportUpgrade("1.0.0")), false);
    assert.equal(readState().last_seen_version, "1.0.0", "the running version is still what's recorded");
  });

  it("honours the opt-out without losing track of the version", () => {
    quiet(() => reportUpgrade("1.0.0"));
    process.env.LISA_NO_UPDATE_CHECK = "1";
    assert.equal(quiet(() => reportUpgrade("1.2.0")), false);
    assert.equal(readState().last_seen_version, "1.2.0");
  });
});
