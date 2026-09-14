/**
 * Live browser sessions for native mode.
 *
 * MCP tool calls are independent; a browser is not. `qa_navigate` and the `qa_click` that
 * follows it are two unrelated requests as far as the protocol is concerned, but they have
 * to land on the same Chromium page or nothing works. This module is the piece of state
 * `mcp-server.ts` deliberately refuses to hold, kept in one place with an explicit
 * lifecycle instead of smeared across the tool handlers.
 *
 * Four hazards the obvious implementation gets wrong, each handled below:
 *
 *   1. **Stdin close is the real orphan path.** The MCP SDK's StdioServerTransport listens
 *      for `'data'` and `'error'` on stdin and nothing else, so `transport.close()` and
 *      `server.onclose` never fire when the host disconnects. Today the process just exits
 *      on EOF; with a live Chromium, Playwright's pipe fds keep the loop alive and you get
 *      a wedged node process plus a browser forever. We wire stdin ourselves.
 *   2. **Playwright owns our signals unless told otherwise.** Its SIGINT handler calls
 *      `process.exit(130)`, truncating an async `closeAll()`. `BrowserSession.launch()`
 *      passes `handleSIGINT/TERM/HUP: false`; shutdown is ours.
 *   3. **MCP does not serialise requests.** A harness can issue parallel tool calls, and
 *      two concurrent Playwright operations on one Page interleave badly. Every call runs
 *      through a per-session promise chain.
 *   4. **Config is snapshotted, not re-resolved.** A session keeps the ProjectConfig and
 *      RuntimeContext it started with, so an edit to lisa.config.yaml mid-run can't move
 *      the target out from under a half-finished mission.
 *
 * Sessions are keyed by project name rather than an opaque id: the model already has the
 * name from `list_qa_projects`, and threading a returned uuid through a dozen calls is a
 * failure mode in exchange for nothing.
 */

import { BrowserSession, briefingFor, type ProjectConfig, type RunOptions } from "./core.js";
import { UserError, type RuntimeContext } from "./paths.js";

/** Live browsers at once. Each is a Chromium; three is already a lot on a laptop. */
export const MAX_SESSIONS = 3;

/** A session nobody has touched for this long is closed by the sweeper. */
export function idleMs(): number {
  const raw = Number(process.env.LISA_SESSION_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
}

const SWEEP_INTERVAL_MS = 30_000;

/** "45s" / "10 min" — minutes alone round a short LISA_SESSION_IDLE_MS down to a flat lie. */
export function humanDuration(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
}

export interface LiveSession {
  project: ProjectConfig;
  ctx: RuntimeContext;
  browser: BrowserSession;
  /** Credential roles the driver may name — the values stay inside `browser`. */
  roles: string[];
  missing: string[];
  lastUsedAt: number;
  /** Calls queued or running. The sweeper never closes a session with work in flight. */
  pending: number;
  /** Tail of the per-session mutex; see `run()`. */
  queue: Promise<unknown>;
}

export class SessionRegistry {
  private sessions = new Map<string, LiveSession>();
  /**
   * Why a session that used to exist doesn't any more. Without this, a primitive arriving
   * after the idle sweep is indistinguishable from one that never started a session, and
   * "call qa_start_session first" is a confusing thing to read mid-mission.
   */
  private closedBecause = new Map<string, string>();
  private sweeper: NodeJS.Timeout | null = null;

  list(): LiveSession[] {
    return [...this.sessions.values()];
  }

  /** Launch a browser for `project`. Throws a UserError the agent can act on. */
  async start(project: ProjectConfig, ctx: RuntimeContext, opts: RunOptions = {}): Promise<LiveSession> {
    if (this.sessions.has(project.name)) {
      throw new UserError(
        `A QA session for "${project.name}" is already open. Keep using it, or call qa_end_session to discard it.`,
      );
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new UserError(
        `Already running ${MAX_SESSIONS} QA sessions (${[...this.sessions.keys()].join(", ")}). ` +
          `Finish one with qa_submit_report, or drop it with qa_end_session, before starting another.`,
      );
    }

    const { creds, roles, missing } = briefingFor(project);
    const browser = new BrowserSession(project.allowed_host, ctx.shotsDir, project.name, opts, creds);
    await browser.launch();

    const now = Date.now();
    const live: LiveSession = {
      project,
      ctx,
      browser,
      roles,
      missing,
      lastUsedAt: now,
      pending: 0,
      queue: Promise.resolve(),
    };
    this.sessions.set(project.name, live);
    this.closedBecause.delete(project.name);
    this.startSweeper();
    return live;
  }

  /**
   * The live session for `project`, or a UserError explaining what to do instead.
   * Deliberately never auto-starts: a session that skipped `qa_start_session` skipped the
   * briefing too, and a model that never saw the mission will invent one.
   */
  require(project: string): LiveSession {
    const found = this.sessions.get(project);
    if (found) return found;
    const why = this.closedBecause.get(project);
    throw new UserError(
      why
        ? `The QA session for "${project}" ${why} Call qa_start_session to begin a new one — anything the old browser had on screen is gone.`
        : `No QA session is open for "${project}". Call qa_start_session first — it launches the browser and returns the mission.`,
    );
  }

  /**
   * Run `fn` against a session, serialised behind every other call on that session.
   *
   * `pending` is incremented on *enqueue*, not on start, so a call waiting its turn still
   * protects the session from the idle sweeper.
   */
  async run<T>(project: string, fn: (s: LiveSession) => Promise<T>): Promise<T> {
    const live = this.require(project);
    live.pending++;
    const result = live.queue.then(
      () => fn(live),
      () => fn(live), // a previous call's failure must not poison the queue
    );
    // The chain itself must never reject, or every later call inherits the rejection.
    live.queue = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } finally {
      live.pending--;
      live.lastUsedAt = Date.now();
    }
  }

  /** Close one session. `reason` is what a later primitive on that name will be told. */
  async close(project: string, reason = "was closed."): Promise<boolean> {
    const live = this.sessions.get(project);
    if (!live) return false;
    this.sessions.delete(project);
    this.closedBecause.set(project, reason);
    try {
      await live.browser.close();
    } catch (e) {
      console.error(`[lisa] error closing session ${project}: ${(e as Error)?.message ?? e}`);
    }
    if (!this.sessions.size) this.stopSweeper();
    return true;
  }

  /** Close everything, in parallel. Safe to call twice. */
  async closeAll(reason = "was closed when the server shut down."): Promise<void> {
    this.stopSweeper();
    await Promise.all([...this.sessions.keys()].map((name) => this.close(name, reason)));
  }

  // ---------- idle sweep ----------

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    // Never hold the event loop open on our own account.
    this.sweeper.unref?.();
  }

  private stopSweeper(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private async sweep(): Promise<void> {
    const limit = idleMs();
    const now = Date.now();
    for (const [name, live] of [...this.sessions]) {
      if (live.pending > 0) continue;
      const idle = now - live.lastUsedAt;
      if (idle < limit) continue;
      await this.close(name, `was closed after ${humanDuration(idle)} with no activity.`);
    }
  }
}

/**
 * Shut the process down cleanly, once, from any of the ways a host can leave.
 *
 * Stdin EOF is the one that matters and the one nothing else covers — see the header.
 * SIGINT/SIGTERM are ours only because `launch()` told Playwright to keep its hands off.
 */
export function installShutdownHooks(registry: SessionRegistry): void {
  let shuttingDown = false;

  const shutdown = async (why: string, code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await registry.closeAll(`was closed (${why}).`);
    process.exit(code);
  };

  process.stdin.on("end", () => void shutdown("the harness disconnected", 0));
  process.stdin.on("close", () => void shutdown("the harness disconnected", 0));
  process.on("SIGINT", () => void shutdown("interrupted", 130));
  process.on("SIGTERM", () => void shutdown("terminated", 143));
  process.on("SIGHUP", () => void shutdown("hung up", 129));
}
