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
