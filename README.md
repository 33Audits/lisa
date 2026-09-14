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

Inside a harness, lisa defaults to **native mode**: your agent drives the browser itself
using the model access you already pay for, so there's no second API key. [More below.](#native-vs-oneshot)

```
src/core.ts          engine: browser primitives, agent loop, dedupe, Slack (no stdout)
src/cli.ts           terminal app (commander + live action stream)
src/mcp-server.ts    MCP stdio server (native primitives or oneshot run_qa)
src/session.ts       live browser sessions for native mode (mutex, idle sweep, shutdown)
src/paths.ts         config / state / artifact resolution
src/config.ts        config loading + validation
src/env.ts           .env loading (beside the config, never clobbers process.env)
src/templates.ts     template lookup + rendering
src/commands/init.ts `lisa init`
src/commands/install.ts `lisa install`
src/commands/doctor.ts `lisa doctor`
src/harness/         harness adapters: plan() what would change, then apply it
src/browser.ts        lazy Chromium install (on first `lisa run`, not on `npm install`)
src/banner.ts        wordmark
templates/           config, starter missions, and the agent briefs
lisa.config.yaml     your projects + missions
```

## Install

```bash
npm run setup      # installs deps, builds, and npm links — one command, one time
```

Or the three steps by hand, if you'd rather skip `npm link` (it puts `lisa` on your PATH globally):

```bash
npm install                      # deps only — Chromium is not downloaded here
npm run build                    # → dist/, makes `lisa` and `lisa-mcp` bins
npm link                         # optional: puts `lisa` on your PATH
```

Chromium downloads lazily on the first `lisa run` (~150MB, one time), not on `npm install` —
a global install shouldn't pull that unprompted for someone who only needs the terminal app
pointed at an already-wired MCP harness. Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` to opt out
entirely (e.g. a machine with its own Chromium already on the expected path); `lisa run` then
fails with instructions instead of downloading. Run `lisa doctor` any time to check whether
it's installed without triggering a download.

Then, from your app's repo:

```bash
lisa init
```

The first thing it asks — before anything about the app itself — is **how you're going
to run lisa**: inside an agent harness (Claude Code, Codex, Cursor, Windsurf), or
standalone (terminal, CI, a server). Pick a harness and it asks one follow-up — [native or
oneshot](#native-vs-oneshot) — then, once the config is written, chains straight into
`lisa install <harness>` for you: one command instead of two. Pick standalone and nothing
changes from here: same prompts, same `.env` / `ANTHROPIC_API_KEY` instructions as always.

Then it asks for a project name, a staging URL, whether the app needs a login, and
which starter mission to begin from — then writes `lisa.config.yaml`, adds the
credential env vars to `.env.example`, and makes sure `.gitignore` covers `.env` and
`.lisa/`. Run it again later to add another project.

Every prompt is also a flag, so it scripts:

```bash
lisa init --yes --url https://staging.acme.com --name acme-dashboard \
          --login --mission auth
```

`--yes` refuses a URL that doesn't look like a staging host unless you also pass
`--non-production`. lisa clicks buttons in a real browser; that gate is deliberate.

A non-interactive (`--yes`) run — the shape a server or a GitHub Actions job would
use — never sees the harness question at all: there's no coding agent on the other end
to wire into, so it defaults to standalone unless you pass `--harness <id>` explicitly
(or `--harness none` to say so on a TTY without being asked).

Other flags: `--global` (write to `~/.config/lisa/config.yaml`), `--force` (replace an
existing config instead of adding to it), `--name`, `--url`, `--no-login`,
`--username-env`, `--password-env`, `--mission smoke|auth|minimal`,
`--harness claude-code|codex|cursor|windsurf|none`, `--mode native|oneshot`.

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
lisa run acme-dashboard --json         # + the full report as JSON, for piping
lisa run acme-dashboard --mission "…"  # one focused run instead of the configured mission
lisa report acme-dashboard             # re-print the last report
lisa reset acme-dashboard              # forget seen bugs; next run reports all
lisa where                             # which config + directories are in use
lisa doctor                            # API key, Chromium, config, harness wiring — all in one
```

While it runs you'll see the agent's one-line reasoning in grey, each browser action (`▶ navigate …`, `▶ click …`), and `read_page` results flagged red when console errors or failed requests were captured. `lisa run` exits with code 2 if any **new critical** bug was found, so CI can gate on it.

`--mission` is the CLI half of the MCP server's `mission_override` — it's what makes
re-verifying one fix possible without editing the config, and it's what a CI job uses to
check one flow instead of the whole suite.

`lisa run` always uses lisa's own agent loop, so it always needs `ANTHROPIC_API_KEY`.
That's true whichever mode your harness is wired in — the modes below are about what the
*harness* does, not about the CLI.

## 2. Inside an agent harness

If you already answered "yes, a harness" during `lisa init`, this is done — skip ahead.
Otherwise, from your app's repo:

```bash
lisa install              # pick from a list
lisa install claude-code  # or name one
```

Four adapters. Each writes an MCP registration plus a brief telling the agent how to run
QA, triage, fix, and re-verify:

| Harness | MCP registration | Agent brief |
|---|---|---|
| `claude-code` | `.mcp.json` | `.claude/skills/lisa/SKILL.md` |
| `codex` | `~/.codex/config.toml` → `[mcp_servers.lisa]` | `AGENTS.md` section |
| `cursor` | `.cursor/mcp.json` | `.cursor/rules/lisa.mdc` |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `AGENTS.md` section |

Claude Code and Cursor are wired entirely inside the repo, so the wiring travels through
git. Codex and Windsurf keep MCP servers in one user-global file, so only the brief can
travel — a teammate who clones the repo runs `lisa install codex` once for the server.

Every registration carries an **absolute** `--config` path: the harness starts the server
with its own working directory, so config discovery can't be relied on.

Then:

> **you:** run QA on acme-dashboard and fix anything critical
> **agent:** *(opens a session, drives the login and the flows, screenshots what looks wrong, files a report — then locates the code, patches it, runs tests, and re-verifies with a focused mission)*

This is the interesting part: lisa finds it, the coding agent (which has your source) fixes it, then re-verifies against staging.

### Native vs oneshot

`lisa install` asks which of two tool surfaces to register, and they are a genuine
tradeoff rather than a default with a fallback:

| | `native` *(default)* | `oneshot` |
|---|---|---|
| Second API key | **not needed** | required — `ANTHROPIC_API_KEY` for the spawned server |
| Who reasons | your harness's model | lisa's own agent loop |
| Cost to your session's context | **~1.5–2k tokens per `qa_read_page`, ×N turns** | ~2k once (the report) |
| Tools | `qa_start_session`, `qa_navigate`, `qa_click`, `qa_fill`, `qa_read_page`, `qa_screenshot`, `qa_wait`, `qa_submit_report`, `qa_end_session` | `run_qa` |

Native moves the cost of reasoning off your API bill and onto your context window: a
40-turn mission can eat 80k+ tokens of the session you're working in. The brief tells the
agent to read pages sparingly, and `qa_read_page` truncates at 6000 characters and 120
elements, but the tradeoff is real — pick `oneshot` if your context is the scarce resource.

```bash
lisa install claude-code --mode oneshot   # or --mode native (the default)
```

Never both surfaces at once: a model that can see `run_qa` will sometimes reach for it,
silently spending the credits a native install was chosen to avoid. (`lisa-mcp --tools both`
exists for debugging and is not what `install` writes.)

Two different defaults, on purpose. `lisa install` writes `native` — what someone wiring
into a coding agent actually wants — while `lisa-mcp`'s own default stays `oneshot`, so
every registration written before this existed, none of which carry `--tools`, keeps
working untouched.

Switching modes changes both the server args and the brief, so `lisa install <harness> --status`
reports **out of date** until you re-install. `lisa doctor` names the mode each harness is
actually wired in.

In native mode the credentials never reach your agent: it passes a **role name**
(`username`, `password`) to `qa_fill` and lisa types the secret itself. lisa also scrubs its
own credential values out of every tool result, so an app that reflects a password into a
URL or a form field can't leak it into your transcript either. Page text comes back wrapped
in an explicit untrusted-content marker, applied server-side on every read — in native mode
that text is flowing into an agent holding your repo and a shell, so it is a structural
guarantee rather than a line of advice the page gets to argue against.

Everything `install` can do is a view of the same computed plan, so nothing drifts:

```bash
lisa install --list                    # supported harnesses, and which are on this machine
lisa install --status                  # detected + wired / out of date / not wired, per harness
lisa install claude-code --dry-run     # what would change
lisa install claude-code --print       # the file contents, to place by hand
lisa install claude-code --yes         # write, no prompts
```

Other flags: `--mode native|oneshot` (skip the question), `--dir <path>` (write harness
files somewhere other than the config's directory) and `--command "<cmd>"` (override how
the harness starts the MCP server — by default `lisa-mcp` if it's on PATH, otherwise the
`dist/mcp-server.js` in this checkout).

Re-running `install` is safe. Files lisa generates whole (`SKILL.md`, `lisa.mdc`) are
rewritten; everything else is a surgical edit of the part lisa owns:

- **JSON** (`.mcp.json`, `.cursor/mcp.json`, `mcp_config.json`) — one key under
  `mcpServers`, preserving the file's existing indent width and every other server.
- **TOML** (`~/.codex/config.toml`) — the `[mcp_servers.lisa]` table is swapped in place.
  Your comments, model settings, other servers, and even `[mcp_servers.lisa.env]` survive.
  It's text surgery, not a parse-and-re-dump, so the file still looks like the one you wrote.
- **Markdown** (`AGENTS.md`) — a `<!-- lisa:start -->` … `<!-- lisa:end -->` block. The rest
  of the file is untouchable text.

A file lisa can't confidently read is a **hard stop, never an overwrite**: unparseable JSON,
`mcpServers` that isn't an object, `[[mcp_servers]]` as an array of tables, a duplicate
`[mcp_servers.lisa]`, a half-deleted marker pair. Each exits 1 with one sentence saying what
to fix. The point of merging is to protect the config; guessing at a file we failed to parse
would defeat it.

> Codex and Windsurf share one `AGENTS.md` block rather than each claiming a private one —
> two lisa sections briefing the same agent differently would be worse than one. So
> installing `codex --mode oneshot` over a native `windsurf` rewrites the block, and
> `lisa install windsurf --status` then reports **out of date**. That's status being derived
> from the plan rather than self-reported: the conflict is visible instead of silent.

## 3. Scheduled / CI

`.github/workflows/lisa-cron.yml` runs `lisa run <project>` per project on weekday mornings, caches dedupe state between runs so Slack only gets **new** bugs, and uploads screenshots + `report-<project>.json` as artifacts. Set `SLACK_WEBHOOK_URL` and your creds as repo secrets. The `Dockerfile` does the same for Cloud Run / ECS / k8s CronJob.

## Config

`lisa.config.yaml` — written by `lisa init`, then hand-edited. One entry per project: `base_url`, `allowed_host` (optional; defaults to the base_url host, navigation outside it is blocked), `credentials_env` (env var *names*, never values), and a plain-English `mission`. The mission is the whole brief — the more specific it is, the better the report.

lisa finds it by walking up from the current directory to the repo root, then falling back to `~/.config/lisa/config.yaml`. State and artifacts anchor to wherever the config was found — never to your current directory. `.env` is read from that same directory. Run `lisa where` to see what resolved.

| Env var | Default | Purpose |
|---|---|---|
| `LISA_CONFIG` | *(search)* | explicit config path |
| `LISA_MODEL` | `claude-sonnet-5` | model for lisa's own agent loop — **no effect in native mode** |
| `LISA_MAX_TURNS` | `60` | hard per-run budget — **no effect in native mode** |
| `LISA_SESSION_IDLE_MS` | `600000` (10 min) | native mode: close an untouched browser session after this long |
| `LISA_STATE_DIR` | `.lisa/state` | seen-bug fingerprints |
| `LISA_ARTIFACTS_DIR` | `.lisa/artifacts` | reports + screenshots (namespaced per project) |
| `LISA_NO_BANNER` | — | suppress the wordmark |
| `ANTHROPIC_API_KEY` | — | required for `lisa run`, CI, and `oneshot` mode. **Not needed for a native harness.** |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | — | don't lazily download Chromium; fail instead if it's missing |

`LISA_MODEL` and `LISA_MAX_TURNS` doing nothing in native mode surprises people, so it's
worth saying plainly: in native mode there is no lisa agent loop to configure. Your
harness's model is the model, and its own turn limits are the budget.

Run `lisa doctor` to check all of the above (API key, Chromium, config, harness wiring and
mode) in one shot. With a native harness wired, a missing `ANTHROPIC_API_KEY` is a ⚠ rather
than a ✗ — nothing is broken, but `lisa run` and CI would still need one.

## Safety rails

Every rail below lives in the engine, not in a prompt, so it applies the same whether
lisa's own loop or your harness's model is doing the driving:

- Navigation outside `allowed_host` is refused by the tool itself.
- Page text comes back wrapped in an untrusted-content marker on every read.
- Credentials are typed by lisa from a role name, never handed to the model — and lisa's own credential values are scrubbed out of every tool result, so an app that reflects one back can't leak it either.
- Unset credential env vars are reported as such, so a missing secret produces "blocked (missing credentials)" rather than a bogus "login is broken" bug.

Destructive actions are forbidden by instruction rather than by code — the oneshot system
prompt and the native session briefing carry the same rules. Reinforce them per-mission
where it matters (e.g. "checkout up to but NOT including payment"). **Staging + dummy
accounts only.**
