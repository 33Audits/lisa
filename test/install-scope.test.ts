/**
 * Install scope: wire once per machine, or commit it to the repo.
 *
 * The bug that motivated the change is pinned first. Every registration used to carry an
 * absolute `--config /Users/whoever/app/lisa.config.yaml`, including the `.mcp.json` that
 * `lisa install claude-code` asked you to commit — so the file a teammate cloned pointed
 * at a path that existed on exactly one machine, and every tool call failed for them.
 * Discovery is what makes a portable registration possible, and these tests hold the two
 * halves together: the flag is omitted precisely when the server can find the config on
 * its own, and present again the moment it can't.
 *
 * The rest pins the properties a once-per-machine install has to have:
 *   - user scope writes nothing into the repo, project scope writes nothing into $HOME
 *   - a user-scope brief names no project, because it is read in repos that don't exist yet
 *   - `wiredMode` still recognises a project install after the default moved to user
 *
 * These go through `plan()` rather than `applyChanges`, which is the point of the adapter
 * contract: the complete desired contents are computable without touching the disk.
 *
 *   npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { contextFor, type RuntimeContext } from "../src/paths.js";
import { claudeCode, cursor, installTarget, statusOf, type FileChange, type InstallScope } from "../src/harness/index.js";

/** A real directory, because `configIsDiscoverableFrom` walks the filesystem for real. */
function fixture(): { ctx: RuntimeContext; home: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-scope-"));
  const repo = path.join(root, "app");
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const configPath = path.join(repo, "lisa.config.yaml");
  fs.writeFileSync(configPath, "projects: []\n");
  return { ctx: contextFor(configPath, "project"), home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** `installTarget` reads the real `os.homedir()`, so point the target at the fixture's. */
function planFor(harness: typeof claudeCode, ctx: RuntimeContext, home: string, scope: InstallScope): FileChange[] {
  return harness.plan({ ...installTarget(ctx, { scope }), home });
}

function serverArgs(changes: FileChange[]): string[] {
  const registration = changes.find((c) => c.label === "MCP server registration");
  assert.ok(registration, "expected an MCP registration in the plan");
  return JSON.parse(registration.contents).mcpServers.lisa.args;
}

describe("registration portability", () => {
  it("omits --config under user scope, so one registration serves every repo", () => {
    const { ctx, home, cleanup } = fixture();
    try {
      assert.deepEqual(serverArgs(planFor(claudeCode, ctx, home, "user")), ["--tools", "native"]);
    } finally {
      cleanup();
    }
  });

  it("omits --config from a committed .mcp.json too — the path was machine-specific", () => {
    const { ctx, home, cleanup } = fixture();
    try {
      // The regression: this file gets committed, so an absolute path here is wrong for
      // everyone but its author. Discovery from the repo root finds the same config.
      const args = serverArgs(planFor(claudeCode, ctx, home, "project"));
      assert.ok(!args.includes("--config"), `committed registration must not pin a path, got ${JSON.stringify(args)}`);
    } finally {
      cleanup();
    }
  });

  it("names --config again when discovery could not find the config", () => {
    const { ctx, home, cleanup } = fixture();
    try {
      // `--dir` somewhere with no config above it: discovery would come up empty, so the
      // flag has to carry the path. Omitting it here would be silently broken wiring.
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-elsewhere-"));
      try {
        const target = { ...installTarget(ctx, { scope: "project", dir: elsewhere }), home };
        const args = serverArgs(claudeCode.plan(target));
        assert.deepEqual(args, ["--config", ctx.configPath, "--tools", "native"]);
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    } finally {
      cleanup();
    }
  });
});

describe("scope separation", () => {
  it("user scope writes only under $HOME, never into the repo", () => {
    const { ctx, home, cleanup } = fixture();
    try {
      for (const c of planFor(claudeCode, ctx, home, "user")) {
        assert.ok(c.path.startsWith(home + path.sep), `${c.path} escaped $HOME`);
        assert.ok(!c.path.startsWith(ctx.root + path.sep), `${c.path} landed in the repo`);
      }
    } finally {
      cleanup();
    }
  });

  it("project scope writes only into the repo, never into $HOME", () => {
    const { ctx, home, cleanup } = fixture();
    try {
      for (const c of planFor(claudeCode, ctx, home, "project")) {
        assert.ok(c.path.startsWith(ctx.root + path.sep), `${c.path} escaped the repo`);
      }
    } finally {
      cleanup();
    }
  });

  it("Cursor admits in scopeNote that its rule stays in the repo", () => {
    const { ctx, home, cleanup } = fixture();
    try {
      const rule = planFor(cursor, ctx, home, "user").find((c) => c.path.endsWith(".mdc"));
      assert.ok(rule, "expected a cursor rule in the plan");
      // The honesty check: Cursor has no user-global rules file, so a `user` install is
      // partial. If that ever stops being true the note must go — a stale caveat is worse
      // than none. If it stays true, the note must stay.
      assert.ok(rule.path.startsWith(ctx.root + path.sep), "cursor rule is expected in the repo");
      assert.match(cursor.scopeNote?.("user") ?? "", /\.cursor\/rules/);
      assert.equal(cursor.scopeNote?.("project"), null);
    } finally {
      cleanup();
    }
  });
});

describe("briefs", () => {
  it("a user-scope brief names no specific project", () => {
    const { ctx, home, cleanup } = fixture();
    try {
      const skill = planFor(claudeCode, ctx, home, "user").find((c) => c.path.endsWith("SKILL.md"));
      assert.ok(skill, "expected a skill in the plan");
      // It is installed once and read in repos that do not exist yet, so any absolute path
      // from the machine that happened to run the install is a latent lie.
      assert.ok(!skill.contents.includes(ctx.root), "user brief leaked the install-time repo path");
      assert.ok(!skill.contents.includes(ctx.configPath), "user brief pinned one config file");
      assert.match(skill.contents, /whichever repo you're working in/);
      assert.match(skill.contents, /\.lisa\/artifacts\/screenshots/);
    } finally {
      cleanup();
    }
  });
});

describe("recognising an existing install", () => {
  it("statusOf reports a project install as wired, now that user is the default", () => {
    const { ctx, home, cleanup } = fixture();
    try {
      // Someone who installed before the default moved still has working wiring. Writing
      // their files to disk and re-planning must come back `wired`, not `not-wired` —
      // `lisa update` uses exactly this to refresh people where they actually installed.
      const changes = planFor(claudeCode, ctx, home, "project");
      for (const c of changes) {
        fs.mkdirSync(path.dirname(c.path), { recursive: true });
        fs.writeFileSync(c.path, c.contents);
      }
      assert.equal(statusOf(planFor(claudeCode, ctx, home, "project")), "wired");
      assert.equal(statusOf(planFor(claudeCode, ctx, home, "user")), "not-wired");
    } finally {
      cleanup();
    }
  });
});
