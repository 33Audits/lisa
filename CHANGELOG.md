# Changelog

What changed in each release, and what a user has to do about it.

`lisa` reads this file: after an upgrade lands, the next command prints the sections
between the version you were on and the version you're now running. So the entries here
are user-facing text, not commit subjects — write them for someone who just typed `lisa run`
and wants to know whether anything they own needs to change.

Rules for entries:

- One `## [version] - YYYY-MM-DD` heading per release, newest first. The version must match
  `package.json` exactly, or the release is skipped when computing the delta.
- Put anything the user must do under `### Actions required`. That section is printed in
  full and in colour; everything else is trimmed. If a release needs nothing, omit it.
- Other sections (`### Added`, `### Changed`, `### Fixed`) are one-line bullets.

## [Unreleased]

### Actions required

- Nothing, unless you want bugs filed as Linear issues. To turn it on: add a `linear:` block
  to `lisa.config.yaml` with a `team` (key or UUID), and put a Linear personal API key in
  `.env` as `LINEAR_API_KEY`. Without both, nothing is ever filed and everything behaves as
  it did. Run `lisa doctor` to check the key and team resolve.
- In CI, add `LINEAR_API_KEY` to the workflow's `env:` block alongside `SLACK_WEBHOOK_URL`.
  The existing `.lisa/state` cache already carries the issue map — without that cache, cron
  runs will file duplicates.
- Harness users: re-run `lisa install <harness>`. The brief now covers `file_linear_issues`,
  and `lisa install --status` reports **out of date** until you do.

### Added

- Linear filing. A new bug becomes an issue with repro steps, expected/actual, evidence and
  screenshot paths; a re-sighting comments "still present" on the issue it already has
  instead of duplicating it. Off unless configured.
- `file_linear_issues` MCP tool — file from the last report after triage, optionally narrowed
  to specific bug titles. This is the one to use inside a harness: the bugs the agent just
  fixed don't need tickets.
- `file_to_linear` on `run_qa` and `qa_submit_report` (default false) for filing up front.
- `lisa run --no-linear`, mirroring `--no-slack`.
- `lisa doctor` reports whether Linear's key and team actually resolve.
- `linear_issues` and `linear_error` on the report, shown by `lisa run` and `lisa report`.

### Changed

- `lisa reset <project>` now also forgets which bugs have Linear issues, so the next run
  files them fresh. That is what "re-report everything" has to mean.

## [1.0.0] - 2026-09-14

### Actions required

- Run `lisa install <harness>` once per machine if you haven't. Wiring now defaults to user
  scope (`~/.claude`, `~/.codex`, …), so a per-repo `.mcp.json` from an older install is no
  longer needed — `lisa update` rewrites whatever scope you're actually wired in.

### Added

- `lisa doctor` — checks the API key, Chromium, the config, and which harnesses are wired.
- `lisa update` — pulls, rebuilds, and refreshes the harness wiring in place.
- Native mode: your harness's own model drives the browser, so no second `ANTHROPIC_API_KEY`
  is needed for MCP-driven runs.
- `--mission` / `mission_override` — scope a run to one flow instead of the configured brief.

### Fixed

- A failing Slack webhook no longer suppresses a run's findings.
- `credentials_env` rejects a pasted secret; it takes the *name* of an env var.
