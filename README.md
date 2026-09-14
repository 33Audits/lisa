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
src/core.ts          engine: agent loop, Playwright tools, dedupe, Slack (no stdout)
src/cli.ts           terminal app (commander + live action stream)
src/mcp-server.ts    MCP stdio server
src/paths.ts         config / state / artifact resolution
src/config.ts        config loading + validation
src/env.ts           .env loading (beside the config, never clobbers process.env)
src/templates.ts     template lookup + rendering
src/commands/init.ts `lisa init`
src/commands/install.ts `lisa install`
src/harness/         harness adapters: plan() what would change, then apply it
src/banner.ts        wordmark
templates/           config, starter missions, and the agent workflow
lisa.config.yaml     your projects + missions
```

## Install

```bash
npm install                      # also downloads Playwright's Chromium (postinstall)
npm run build                    # → dist/, makes `lisa` and `lisa-mcp` bins
npm link                         # optional: puts `lisa` on your PATH
```

Then, from your app's repo:

```bash
lisa init
```

It asks for a project name, a staging URL, whether the app needs a login, and which
starter mission to begin from — then writes `lisa.config.yaml`, adds the credential
env vars to `.env.example`, and makes sure `.gitignore` covers `.env` and `.lisa/`.
Run it again later to add another project.

Every prompt is also a flag, so it scripts:

```bash
lisa init --yes --url https://staging.acme.com --name acme-dashboard \
          --login --mission auth
```

`--yes` refuses a URL that doesn't look like a staging host unless you also pass
`--non-production`. lisa clicks buttons in a real browser; that gate is deliberate.

Other flags: `--global` (write to `~/.config/lisa/config.yaml`), `--force` (replace an
existing config instead of adding to it), `--name`, `--url`, `--no-login`,
`--username-env`, `--password-env`, `--mission smoke|auth|minimal`.

Finally fill in `.env`:

```bash
cp .env.example .env    # then edit
```

lisa reads `.env` from the directory its config lives in. Anything already set in the
environment wins, so CI secrets are never overwritten by a checked-out file.

## 1. Terminal

```bash
lisa init                              # scaffold a config (see above)
lisa install claude-code               # wire it into your agent harness
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

From your app's repo:

```bash
lisa install claude-code
```

That writes two files and leaves everything else alone:

| File | What it is |
|---|---|
| `.mcp.json` | the MCP server registration, merged in beside your other servers |
| `.claude/skills/lisa/SKILL.md` | the workflow — how to run QA, triage, fix, and re-verify |

Both are project-scoped, so they travel with the repo and your team gets the wiring
through git. The registration carries an **absolute** `--config` path: the harness starts
the server with its own working directory, so config discovery can't be relied on.

Then:

> **you:** run QA on acme-dashboard and fix anything critical
> **agent:** *(calls `run_qa`, reads the bug list + screenshots, locates the code, patches it, runs tests, then calls `run_qa` again with a `mission_override` focused on the fixed flow)*

Tools exposed: `list_qa_projects`, `run_qa` (with optional `post_to_slack` and `mission_override`), `get_last_qa_report`, `reset_qa_state`.

This is the interesting mode: lisa finds it, the coding agent (which has your source) fixes it, then re-verifies against staging.

Everything `install` can do is a view of the same computed plan, so nothing drifts:

```bash
lisa install --list                    # supported harnesses, and which are on this machine
lisa install --status                  # detected + wired / out of date / not wired, per harness
lisa install claude-code --dry-run     # what would change
lisa install claude-code --print       # the file contents, to place by hand
lisa install claude-code --yes         # write, no prompts
```

Other flags: `--dir <path>` (write harness files somewhere other than the config's
directory) and `--command "<cmd>"` (override how the harness starts the MCP server —
by default `lisa-mcp` if it's on PATH, otherwise the `dist/mcp-server.js` in this checkout).

Re-running `install` is safe: files lisa owns are regenerated, `.mcp.json` is merged one
key at a time, and a `.mcp.json` it can't parse is a hard stop rather than an overwrite.

> Codex, Cursor, Windsurf, and a generic `AGENTS.md` adapter are next; they plug into the
> same registry. Today `claude-code` is the one that ships.

## 3. Scheduled / CI

`.github/workflows/lisa-cron.yml` runs `lisa run <project>` per project on weekday mornings, caches dedupe state between runs so Slack only gets **new** bugs, and uploads screenshots + `report-<project>.json` as artifacts. Set `SLACK_WEBHOOK_URL` and your creds as repo secrets. The `Dockerfile` does the same for Cloud Run / ECS / k8s CronJob.

## Config

`lisa.config.yaml` — written by `lisa init`, then hand-edited. One entry per project: `base_url`, `allowed_host` (optional; defaults to the base_url host, navigation outside it is blocked), `credentials_env` (env var *names*, never values), and a plain-English `mission`. The mission is the whole brief — the more specific it is, the better the report.

lisa finds it by walking up from the current directory to the repo root, then falling back to `~/.config/lisa/config.yaml`. State and artifacts anchor to wherever the config was found — never to your current directory. `.env` is read from that same directory. Run `lisa where` to see what resolved.

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
