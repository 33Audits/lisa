---
name: lisa
description: Run the autonomous QA agent against a project's staging environment, triage the bugs it finds, fix them in this codebase, and re-verify. Use when the user asks to "run QA", "QA this", "check staging for bugs", or "see if the fix worked".
---

# QA agent workflow

You have MCP tools from the `lisa` server: `list_qa_projects`, `run_qa`, `get_last_qa_report`, `reset_qa_state`.

## Running QA

1. If the user didn't name a project, call `list_qa_projects` and pick the one matching this repo (or ask).
2. Call `run_qa` with the project name. It takes a few minutes — tell the user it's running.
3. Present the results as a short triage table: severity, title, page. Lead with `new_bugs`; mention `known_bugs` only as a count unless asked.

## Fixing bugs

For each new bug the user wants fixed:
- Use the `repro_steps`, `evidence` (console errors, failed request URLs, screenshot paths under `.lisa/artifacts/screenshots/`), and `page` to locate the relevant code in this repo. Read the screenshot if one exists.
- Fix it, run the project's existing tests/linters.
- Do NOT mark a bug fixed based on reading code alone.

## Re-verifying

After fixes are deployed to staging, call `run_qa` again with a `mission_override` that targets just the fixed flows, e.g.:
"Log in, go to Settings > Profile, submit the form with an empty name, and verify a validation message appears. Report only issues with this flow."
Then compare against the previous report.

## If a tool returns a config error

lisa resolves `lisa.config.yaml` by walking up from its working directory, then falling back to `~/.config/lisa/config.yaml`. If a tool reports no config found, tell the user to run `lisa init` — don't try to hand-write the config file yourself.

## Guardrails

- QA only ever runs against staging with dummy credentials. Never point it at production.
- Only set `post_to_slack: true` if the user asks to notify the team.
- Don't call `reset_qa_state` unless the user explicitly wants old bugs re-reported.
