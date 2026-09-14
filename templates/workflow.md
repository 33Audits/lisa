You have MCP tools from the `lisa` server: `list_qa_projects`, `run_qa`, `get_last_qa_report`, `file_linear_issues`, `reset_qa_state`.

## Running QA

1. If the user didn't name a project, call `list_qa_projects` and pick the one matching this repo (or ask).
2. Call `run_qa` with the project name. It takes a few minutes — tell the user it's running.
   - **If the user asked for something specific, pass it as `mission_override`.** The configured mission is the default brief, not the only one. "Test the matter creation flow", "QA the checkout", "check the feature we just shipped" — turn that into a concrete numbered mission and override with it. Running the generic mission when the user asked for one flow wastes a run and answers the wrong question.
   - **"The recent feature" is something you work out, not something you ask about.** Read `git log`/`git diff` for the recent work, find the routes and components it touched, and write the mission from that — then say in one line which flow you derived and are about to test. Ask only if the diff is genuinely ambiguous.
   - Keep an override in the same shape as a configured mission: numbered steps, concrete pages, and what "correct" looks like at each one. End it with "Report only issues with this flow." when the user scoped you to one.
3. Present the results as a short triage table: severity, title, page. Lead with `new_bugs`; mention `known_bugs` only as a count unless asked.

## Fixing bugs

For each new bug the user wants fixed:

- Use the `repro_steps`, `evidence` (console errors, failed request URLs, screenshot paths under `{{artifacts}}`), and `page` to locate the relevant code in this repo. Read the screenshot if one exists.
- Fix it, then run the project's existing tests and linters.
- Do NOT mark a bug fixed based on reading code alone.

## Filing what you're not fixing

Bugs you fix in this session don't need a ticket. Bugs you're leaving do — otherwise they
exist only in a report nobody will open again.

- After triage, call `file_linear_issues` with `only` set to the titles you are NOT fixing.
- Leave `file_to_linear` false on `run_qa` unless the user asked to file everything up front.
  Filing before triage tickets the bugs you're about to close yourself.
- A bug that already has an issue gets a "still present" comment, not a duplicate — so
  re-running QA on an unfixed bug is safe.
- If the tool reports Linear isn't configured, say so once and move on. Don't edit
  `lisa.config.yaml` to add a `linear:` block unless the user asks for it.

## Re-verifying

After fixes are deployed to staging, call `run_qa` again with a `mission_override` that targets just the fixed flows, e.g.:

> "Log in, go to Settings > Profile, submit the form with an empty name, and verify a validation message appears. Report only issues with this flow."

Then compare against the previous report.

## If a tool returns a config error

{{wiring}} If a tool reports that no config was found, or that a
project is unknown, tell the user to run `lisa init` — don't hand-write the config
file yourself.

## Guardrails

- QA only ever runs against staging with dummy credentials. Never point it at production.
- Only set `post_to_slack: true` if the user asks to notify the team.
- Don't call `reset_qa_state` unless the user explicitly wants old bugs re-reported — it also
  forgets which bugs already have Linear issues, so the next run files them again.
