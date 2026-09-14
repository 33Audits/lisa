```
 ██╗      ██╗ ███████╗  █████╗
 ██║      ██║ ██╔════╝ ██╔══██╗
 ██║      ██║ ███████╗ ███████║
 ██║      ██║ ╚════██║ ██╔══██║
 ███████╗ ██║ ███████║ ██║  ██║
 ╚══════╝ ╚═╝ ╚══════╝ ╚═╝  ╚═╝
```

An autonomous "QA person": Claude drives a real browser through your staging app, finds bugs, and reports them. One engine, three surfaces:

| Surface | Entry point | Use it for |
|---|---|---|
| **Terminal** | `lisa run <project>` | Watch it work, iterate on missions, one-off checks |
| **Your agent harness** | MCP server (`lisa-mcp`) | "Run QA and fix what it finds" — QA → fix → re-verify loop |
| **Scheduled / CI** | GitHub Actions cron (included) or Docker | Unattended runs, new bugs → Slack |

```
src/core.ts        engine: agent loop, Playwright tools, dedupe, Slack (no stdout)
src/cli.ts         terminal app (commander + live action stream)
src/mcp-server.ts  MCP stdio server
src/paths.ts       config / state / artifact resolution
src/config.ts      config loading + validation
src/banner.ts      wordmark
lisa.config.yaml   your projects + missions
```

## Install

```bash
npm install                      # also downloads Playwright's Chromium (postinstall)
npm run build                    # → dist/, makes `lisa` and `lisa-mcp` bins
npm link                         # optional: puts `lisa` on your PATH

export ANTHROPIC_API_KEY=sk-ant-...
export ACME_QA_USERNAME=qa-test-user ACME_QA_PASSWORD=hunter2
```

## 1. Terminal

```bash
lisa list                              # configured projects (flags unset credentials)
lisa run acme-dashboard                # headless run, streams every action live
lisa run acme-dashboard --headed       # opens a Chromium window so you can watch
lisa run --all --no-slack              # everything, print only
lisa report acme-dashboard             # re-print the last report
lisa reset acme-dashboard              # forget seen bugs; next run reports all
lisa where                             # which config + directories are in use
```

While it runs you'll see the agent's one-line reasoning in grey, each browser action (`▶ navigate …`, `▶ click …`), and `read_page` results flagged red when console errors or failed requests were captured. `lisa run` exits with code 2 if any **new critical** bug was found, so CI can gate on it.

## 2. Inside an agent harness

Register the MCP server from your app's repo:

```bash
claude mcp add --scope project --transport stdio lisa \
  --env ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -- node /abs/path/to/lisa/dist/mcp-server.js --config /abs/path/to/lisa.config.yaml
```

Copy `.claude/skills/lisa/` into your app repo's `.claude/skills/` so the harness knows the workflow. Then:

> **you:** run QA on acme-dashboard and fix anything critical
> **agent:** *(calls `run_qa`, reads the bug list + screenshots, locates the code, patches it, runs tests, then calls `run_qa` again with a `mission_override` focused on the fixed flow)*

Tools exposed: `list_qa_projects`, `run_qa` (with optional `post_to_slack` and `mission_override`), `get_last_qa_report`, `reset_qa_state`.

This is the interesting mode: lisa finds it, the coding agent (which has your source) fixes it, then re-verifies against staging.

> A `lisa install` command that writes this registration for you — for Claude Code, Codex, Cursor, Windsurf, or any harness via a printed snippet — is the next milestone. Today it's the manual command above.

## 3. Scheduled / CI

`.github/workflows/lisa-cron.yml` runs `lisa run <project>` per project on weekday mornings, caches dedupe state between runs so Slack only gets **new** bugs, and uploads screenshots + `report-<project>.json` as artifacts. Set `SLACK_WEBHOOK_URL` and your creds as repo secrets. The `Dockerfile` does the same for Cloud Run / ECS / k8s CronJob.

## Config

`lisa.config.yaml` — one entry per project: `base_url`, `allowed_host` (optional; defaults to the base_url host, navigation outside it is blocked), `credentials_env` (env var *names*, never values), and a plain-English `mission`.

lisa finds it by walking up from the current directory to the repo root, then falling back to `~/.config/lisa/config.yaml`. State and artifacts anchor to wherever the config was found — never to your current directory. Run `lisa where` to see what resolved.

| Env var | Default | Purpose |
|---|---|---|
| `LISA_CONFIG` | *(search)* | explicit config path |
| `LISA_MODEL` | `claude-sonnet-5` | model for the agent loop |
| `LISA_MAX_TURNS` | `60` | hard per-run budget |
| `LISA_STATE_DIR` | `.lisa/state` | seen-bug fingerprints |
| `LISA_ARTIFACTS_DIR` | `.lisa/artifacts` | reports + screenshots |
| `LISA_NO_BANNER` | — | suppress the wordmark |

## Safety rails

Navigation hard-blocked outside `allowed_host`; system prompt forbids destructive actions (reinforce per-mission — e.g. "checkout up to but NOT including payment"); page text is treated as data, not instructions. Unset credential env vars are reported to the agent as such, so a missing secret produces "blocked (missing credentials)" rather than a bogus "login is broken" bug. **Staging + dummy accounts only.**
