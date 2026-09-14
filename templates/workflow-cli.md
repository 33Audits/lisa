You have no lisa-specific tools. lisa is a command-line program — drive it with your
shell tool. Every command below is non-interactive and safe to run unattended.

| What you want | Command |
|---|---|
| the configured projects | `lisa list` |
| run a QA session | `lisa run <project> --json` |
| re-print the last report | `lisa report <project>` |
| re-report bugs already seen | `lisa reset <project>` |

`--json` prints the full report as JSON after the human-readable summary. Parse that
block, not the coloured output above it.

## Running QA

1. If the user didn't name a project, run `lisa list` and pick the one matching this repo (or ask).
2. Run `lisa run <project> --json`. It drives a real browser and takes a few minutes — tell the user it's running, and don't set a short timeout.
3. Present the results as a short triage table: severity, title, page. Lead with `new_bugs`; mention `known_bugs` only as a count unless asked.

Exit codes: `0` clean, `2` at least one **new critical** bug (the run still succeeded —
read the report), `1` lisa itself failed. On `1`, read the error message and act on it;
don't retry the same command.

## Fixing bugs

For each new bug the user wants fixed:

- Use the `repro_steps`, `evidence` (console errors, failed request URLs, screenshot paths under `{{artifacts}}`), and `page` to locate the relevant code in this repo. Read the screenshot if one exists.
- Fix it, then run the project's existing tests and linters.
- Do NOT mark a bug fixed based on reading code alone.

## Re-verifying

After fixes are deployed to staging, re-run with `--mission` targeting just the fixed
flows instead of the whole configured mission:

```bash
lisa run <project> --json --mission "Log in, go to Settings > Profile, submit the form with an empty name, and verify a validation message appears. Report only issues with this flow."
```

Then compare against the previous report.

## If a command fails with a config error

lisa is wired to `{{config}}`. If it reports that no config was found, or that a project
is unknown, tell the user to run `lisa init` — don't hand-write the config file yourself.

## Guardrails

- QA only ever runs against staging with dummy credentials. Never point it at production.
- lisa posts to Slack by itself when a webhook is configured. Pass `--no-slack` if the user doesn't want the team notified.
- Don't run `lisa reset` unless the user explicitly wants old bugs re-reported.
