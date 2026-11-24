import { commitToCatalog } from "../catalog/commit.ts";
import type { TransformJob } from "../catalog/do.ts";
import { apiTokenExists, insertApiToken } from "../db/api-tokens.ts";
import type { Env } from "../types.ts";
import { isContainerOwner } from "./container-owner.ts";

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

interface WsAttachment {
  userId: string;
  inflightJobIds: string[];
  lastPingAt: number;
}

interface StoredContainerToken {
  id: string;
  token: string;
}

// Sockets that haven't pinged within this window are considered stale.
const PING_INTERVAL_MS = 25_000;
const STALE_AFTER_MS = PING_INTERVAL_MS * 3; // 75s — 3 missed pings

// How long /query and /warm wait for a woken container to connect its WS
// before giving up — covers process boot + DuckDB/httpfs init + catalog view
// registration + the WS handshake itself. Generous because a cold start is
// the whole point of this path; a query to an already-live session returns
// long before this ever matters.
const CONTAINER_WAKE_TIMEOUT_MS = 45_000;

// How long an auto-started container is kept alive after the DO stops seeing
// activity, via the platform's own setInactivityTimeout — not a custom alarm
// loop. This is what makes waking-on-demand cheaper than staying up 24/7:
// memory/disk are billed only while the container is actually running.
const CONTAINER_IDLE_TIMEOUT_MS = 10 * 60_000;

// Circuit breaker for AUTOMATIC wakes (queued/committed jobs, re-wake after an
// exit). After this many consecutive failed wakes — start() failing, no socket
// within the wake timeout, or a container dying within CONTAINER_SHORT_LIVED_MS
// of starting — automatic wakes are suppressed for the cooldown, so a broken
// container isn't restarted (and billed) over and over for the same pending
// jobs. Explicit /query and /warm calls bypass the breaker (a person is
// waiting and asked for it); a success closes it again.
const WAKE_FAILURE_THRESHOLD = 3;
const WAKE_COOLDOWN_MS = 15 * 60_000;
const CONTAINER_SHORT_LIVED_MS = 60_000;

interface WakeBreakerState {
  failures: number;
  openUntil: number;
  lastError: string;
}

type IncomingMessage =
  | { type: "result"; queryId: string; columns: string[]; rows: unknown[][] }
  | { type: "error"; queryId: string; error: string }
  | { type: "job_claimed"; jobId: string }
  | { type: "job_complete"; jobId: string }
  | { type: "job_error"; jobId: string; error: string }
  | { type: "ping" };

export class SessionDO implements DurableObject {
  // In-memory map of pending MCP queries. Safe because the DO never hibernates
  // while a fetch handler is awaiting — active fetch requests prevent hibernation.
  private pendingQueries = new Map<
    string,
    { resolve: (v: QueryResult) => void; reject: (e: Error) => void; ws: WebSocket }
  >();

  // Resolved as soon as ANY socket (browser or container) registers, so
  // whichever of /query or /warm is waiting on a cold start notices the
  // instant it's over rather than polling.
  private containerWakeWaiters: Array<() => void> = [];
  // Coalesces concurrent wake attempts for the same user onto one start() call.
  private containerStarting: Promise<boolean> | null = null;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {
    // A DO can be evicted and reconstructed while its container keeps running
    // (setInactivityTimeout doesn't survive that) — re-arm it so an
    // already-running container isn't stopped by Cloudflare's default
    // idle-timeout before our own longer one would have applied.
    if (this.ctx.container?.running) {
      this.ctx.container.setInactivityTimeout(CONTAINER_IDLE_TIMEOUT_MS).catch(() => {});
    }
  }

  private catalogStub(userId: string) {
    return this.env.CATALOG.get(this.env.CATALOG.idFromName(userId));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleUpgrade(request);
    }

    if (request.method === "POST" && pathname === "/query") {
      return this.handleQuery(request);
    }

    if (request.method === "POST" && pathname === "/dispatch-jobs") {
      return this.handleDispatchJobs(request);
    }

    if (request.method === "POST" && pathname === "/warm") {
      return this.handleWarmSession(request);
    }

    if (request.method === "GET" && pathname === "/status") {
      const userId = request.headers.get("X-User-ID") ?? "";
      const count = userId
        ? this.ctx.getWebSockets(userId).length
        : this.ctx.getWebSockets().length;
      return Response.json({
        sessionCount: count,
        // Whether a query with nothing connected would wake a container for this user.
        containerWakeable: !!userId && this.containerWakeEnabled(userId),
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  private handleUpgrade(request: Request): Response {
    const userId = request.headers.get("X-User-ID") ?? "";
    if (!userId) return new Response("Missing X-User-ID", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.ctx.acceptWebSocket(server, [userId]);
    server.serializeAttachment({
      userId,
      inflightJobIds: [],
      lastPingAt: Date.now(),
    } satisfies WsAttachment);

    // Dispatch any pending jobs to this new connection (fire and forget).
    this.ctx.waitUntil(this.dispatchPendingJobs(server, userId));

    // Wake up anyone in /query or /warm waiting on a cold start — this is a
    // live socket now, whether it's a browser tab or a container that just
    // finished booting.
    this.resolveContainerWakeWaiters();

    // Echo Sec-WebSocket-Protocol so browsers that pass the token as a subprotocol don't fail handshake.
    const protocol = request.headers.get("Sec-WebSocket-Protocol");
    const headers = protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  private liveSocketsFor(userId: string): WebSocket[] {
    const now = Date.now();
    return this.ctx.getWebSockets(userId).filter((s) => {
      const att = s.deserializeAttachment() as WsAttachment | null;
      return att && now - att.lastPingAt < STALE_AFTER_MS;
    });
  }

  private async handleQuery(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      sql: string;
      userId: string;
      queryId?: string;
      workerOrigin?: string;
    };
    const { sql, userId, queryId: reqId, workerOrigin } = body;

    if (!sql || !userId)
      return Response.json({ error: "sql and userId are required" }, { status: 400 });

    let liveSockets = this.liveSocketsFor(userId);
    if (liveSockets.length === 0) {
      // No browser tab, no already-running container — try to wake one
      // before giving up. No-ops immediately if no container is configured
      // for this environment, or no workerOrigin was supplied to start one.
      const woke = await this.ensureContainerStarted(userId, workerOrigin, "query");
      if (woke) liveSockets = this.liveSocketsFor(userId);
    }
    if (liveSockets.length === 0) {
      return Response.json(
        {
          error: "no_session",
          message: this.containerWakeEnabled(userId)
            ? "No active session, and the container didn't come up in time. Try again, or check its logs."
            : "No active browser session. Open a browser tab to run queries.",
        },
        { status: 503 },
      );
    }

    const queryId = reqId ?? crypto.randomUUID();
    const ws = liveSockets[0]!;
    console.log(
      `[SessionDO] handleQuery: found ${liveSockets.length} live socket(s) for userId=${userId}, queryId=${queryId}, readyState=${ws.readyState}`,
    );

    let result: QueryResult;
    try {
      result = await new Promise<QueryResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingQueries.delete(queryId);
          console.log(`[SessionDO] handleQuery: TIMED OUT queryId=${queryId}`);
          reject(new Error("Query timed out after 30s"));
        }, 30_000);

        this.pendingQueries.set(queryId, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
          ws,
        });

        try {
          ws.send(JSON.stringify({ type: "query", queryId, sql }));
          console.log(`[SessionDO] handleQuery: ws.send() succeeded for queryId=${queryId}`);
        } catch (sendErr) {
          console.error(
            `[SessionDO] handleQuery: ws.send() threw for queryId=${queryId}:`,
            sendErr,
          );
          clearTimeout(timer);
          this.pendingQueries.delete(queryId);
          reject(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
        }
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Query failed";
      return Response.json({ error: "query_failed", message }, { status: 500 });
    }

    return Response.json(result);
  }

  private async handleDispatchJobs(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      userId: string;
      jobIds?: string[];
      workerOrigin?: string;
    };
    const { userId, jobIds, workerOrigin } = body;
    if (!userId) return Response.json({ error: "userId is required" }, { status: 400 });
    if (this.containerWakeEnabled(userId)) await this.rememberWorkerOrigin(workerOrigin);

    const liveSockets = this.liveSocketsFor(userId);
    if (liveSockets.length === 0) {
      // Nothing connected to dispatch to right now. If a container is
      // configured, try to wake one in the background — once it connects,
      // handleUpgrade's own dispatchPendingJobs call picks up this same job,
      // so there's nothing further to do here. Fire-and-forget: the caller
      // (the commit relay / load-job queue consumer) doesn't wait on this,
      // and the job stays safely 'pending' in the Catalog DO either way.
      this.ctx.waitUntil(this.ensureContainerStarted(userId, workerOrigin, "dispatch-jobs", true));
      return Response.json({ dispatched: 0 });
    }

    // Fetch pending jobs from Catalog DO, optionally filtered to a specific subset.
    const catalogRes = await this.catalogStub(userId).fetch("http://do/jobs/pending");
    if (!catalogRes.ok) return Response.json({ dispatched: 0 });

    const { jobs } = (await catalogRes.json()) as { jobs: TransformJob[] };
    const toDispatch = jobIds ? jobs.filter((j) => jobIds.includes(j.id)) : jobs;
    if (toDispatch.length === 0) return Response.json({ dispatched: 0 });

    const ws = liveSockets[0]!;
    for (const job of toDispatch) {
      ws.send(
        JSON.stringify({
          type: "transform_job",
          jobId: job.id,
          sql: job.sql,
          outputTable: job.output_table,
          outputUri: job.output_uri,
          outputBackend: job.output_backend,
          format: job.format,
        }),
      );
    }

    return Response.json({ dispatched: toDispatch.length });
  }

  /**
   * Pre-warms the query backend without running anything — lets an MCP
   * client or a browser tab with no local DuckDB session kick off a
   * container cold start ahead of its first real query, so that latency
   * overlaps with whatever the caller does next instead of landing on
   * run_query. Never blocks on the full cold start; always responds fast.
   */
  private async handleWarmSession(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      userId?: string;
      workerOrigin?: string;
    };
    const { userId, workerOrigin } = body;
    if (!userId) return Response.json({ error: "userId is required" }, { status: 400 });

    if (this.liveSocketsFor(userId).length > 0) {
      return Response.json({ status: "already-active" });
    }
    if (!this.containerWakeEnabled(userId)) {
      return Response.json({ status: "unavailable" });
    }
    if (!workerOrigin) {
      return Response.json(
        { error: "workerOrigin is required to start a container" },
        { status: 400 },
      );
    }

    // Fire-and-forget: the whole point is NOT to make the caller wait out
    // the cold start here.
    this.ctx.waitUntil(this.ensureContainerStarted(userId, workerOrigin, "warm"));
    return Response.json({ status: "starting" });
  }

  // ── Container lifecycle ────────────────────────────────────────────────
  // Only reachable when this environment actually has a container bound to
  // this DO class (see wrangler.toml) — ctx.container is undefined otherwise
  // (including in this project's test suite, confirmed empirically against
  // @cloudflare/vitest-pool-workers), so every caller above already checks
  // or no-ops before reaching here. None of this has been exercised against
  // real Cloudflare infra yet — see container/deploy/README.md.

  /** True only when a container is bound AND this user is the configured owner. */
  private containerWakeEnabled(userId: string): boolean {
    return !!this.ctx.container && isContainerOwner(this.env, userId);
  }

  private resolveContainerWakeWaiters(): void {
    const waiters = this.containerWakeWaiters;
    this.containerWakeWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private waitForLiveSocket(userId: string, timeoutMs: number): Promise<boolean> {
    if (this.liveSocketsFor(userId).length > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(this.liveSocketsFor(userId).length > 0), timeoutMs);
      this.containerWakeWaiters.push(() => {
        clearTimeout(timer);
        finish(this.liveSocketsFor(userId).length > 0);
      });
    });
  }

  /** Mints (once) or re-mints (if revoked) the API token this user's own container
   * authenticates with. Stored in this DO's own durable storage — never in D1 as
   * plaintext, and scoped to exactly the one container instance this DO owns. */
  private async ensureContainerApiToken(userId: string): Promise<string | null> {
    const existing = await this.ctx.storage.get<StoredContainerToken>("containerApiToken");
    if (existing && (await apiTokenExists(this.env.DB, existing.id))) {
      return existing.token;
    }
    try {
      const { token, row } = await insertApiToken(this.env.DB, {
        userId,
        name: "container (auto)",
        expiresAt: null,
      });
      await this.ctx.storage.put<StoredContainerToken>("containerApiToken", {
        id: row.id,
        token,
      });
      return token;
    } catch (err) {
      console.error(`[SessionDO] failed to mint container API token for userId=${userId}:`, err);
      return null;
    }
  }

  private async rememberWorkerOrigin(workerOrigin: string | undefined): Promise<void> {
    if (!workerOrigin) return;
    const known = await this.ctx.storage.get<string>("workerOrigin");
    if (known !== workerOrigin) await this.ctx.storage.put("workerOrigin", workerOrigin);
  }

  private async getBreaker(): Promise<WakeBreakerState> {
    return (
      (await this.ctx.storage.get<WakeBreakerState>("wakeBreaker")) ?? {
        failures: 0,
        openUntil: 0,
        lastError: "",
      }
    );
  }

  private async recordWakeResult(userId: string, ok: boolean, detail: string): Promise<void> {
    const state = await this.getBreaker();
    if (ok) {
      if (state.failures > 0) {
        console.log(
          `[SessionDO] wake breaker closed for userId=${userId} after success: ${detail}`,
        );
      }
      await this.ctx.storage.put<WakeBreakerState>("wakeBreaker", {
        failures: 0,
        openUntil: 0,
        lastError: "",
      });
      return;
    }
    const failures = state.failures + 1;
    const openUntil =
      failures >= WAKE_FAILURE_THRESHOLD ? Date.now() + WAKE_COOLDOWN_MS : state.openUntil;
    console.warn(
      `[SessionDO] wake failure ${failures}/${WAKE_FAILURE_THRESHOLD} for userId=${userId}: ${detail}${
        failures >= WAKE_FAILURE_THRESHOLD
          ? ` — breaker OPEN, automatic wakes suppressed until ${new Date(openUntil).toISOString()}`
          : ""
      }`,
    );
    await this.ctx.storage.put<WakeBreakerState>("wakeBreaker", {
      failures,
      openUntil,
      lastError: detail,
    });
  }

  /** Starts (if not already running) this user's container and waits for its
   * own outbound WS to register, up to CONTAINER_WAKE_TIMEOUT_MS. Coalesces
   * concurrent callers (e.g. a /warm call racing a /query call) onto one
   * attempt. Never throws — returns false for "no live session resulted",
   * whatever the reason (unconfigured, start() failed, timed out, breaker open).
   *
   * `reason` is only for logs. `automatic` wakes (job dispatch, re-wake after
   * an exit) honor the circuit breaker; explicit ones (query/warm) don't.
   * `workerOrigin` falls back to the last one this DO saw, so callers with no
   * request in hand (the load-job queue consumer) can still wake a container. */
  private async ensureContainerStarted(
    userId: string,
    workerOrigin: string | undefined,
    reason: string,
    automatic = false,
  ): Promise<boolean> {
    const container = this.ctx.container;
    if (!container || !isContainerOwner(this.env, userId)) return false;
    await this.rememberWorkerOrigin(workerOrigin);
    if (this.liveSocketsFor(userId).length > 0) return true;

    const origin = workerOrigin ?? (await this.ctx.storage.get<string>("workerOrigin"));
    if (!origin) {
      console.warn(
        `[SessionDO] wake (${reason}) skipped for userId=${userId}: no workerOrigin known`,
      );
      return false;
    }

    if (automatic) {
      const breaker = await this.getBreaker();
      if (breaker.openUntil > Date.now()) {
        console.warn(
          `[SessionDO] wake (${reason}) suppressed for userId=${userId}: breaker open until ${new Date(breaker.openUntil).toISOString()} (last error: ${breaker.lastError})`,
        );
        return false;
      }
    }

    if (!this.containerStarting) {
      console.log(
        `[SessionDO] wake (${reason}) starting for userId=${userId}, container.running=${container.running}`,
      );
      this.containerStarting = this.startContainerAndWait(userId, origin, container).finally(() => {
        this.containerStarting = null;
      });
    }
    return this.containerStarting;
  }

  private async startContainerAndWait(
    userId: string,
    workerOrigin: string,
    container: NonNullable<DurableObjectState["container"]>,
  ): Promise<boolean> {
    const t0 = Date.now();
    if (!container.running) {
      const token = await this.ensureContainerApiToken(userId);
      if (!token) {
        await this.recordWakeResult(userId, false, "could not mint container API token");
        return false;
      }

      try {
        container.start({
          enableInternet: true,
          env: { WORKER_URL: workerOrigin, AUTH_MODE: "token", API_TOKEN: token },
        });
      } catch (err) {
        console.error(`[SessionDO] container.start() failed for userId=${userId}:`, err);
        await this.recordWakeResult(userId, false, `container.start() threw: ${String(err)}`);
        return false;
      }
      await this.ctx.storage.put("containerStartedAt", Date.now());

      this.ctx.waitUntil(
        container
          .monitor()
          .then(
            () => this.onContainerExit(userId, undefined),
            (err: unknown) => this.onContainerExit(userId, err),
          )
          .catch((err: unknown) => {
            console.error(`[SessionDO] onContainerExit failed for userId=${userId}:`, err);
          }),
      );
    }

    // Best-effort — a failure here just means it falls back to the
    // platform's own default idle timeout instead of ours.
    container.setInactivityTimeout(CONTAINER_IDLE_TIMEOUT_MS).catch(() => {});

    const connected = await this.waitForLiveSocket(userId, CONTAINER_WAKE_TIMEOUT_MS);
    const elapsed = Date.now() - t0;
    if (connected) {
      console.log(
        `[SessionDO] wake succeeded for userId=${userId}: socket live after ${elapsed}ms`,
      );
      await this.recordWakeResult(userId, true, `socket live after ${elapsed}ms`);
    } else {
      await this.recordWakeResult(
        userId,
        false,
        `no socket within ${CONTAINER_WAKE_TIMEOUT_MS}ms (container.running=${container.running})`,
      );
    }
    return connected;
  }

  /** Called when the container's process ends (idle timeout, rollout, crash).
   * If transform jobs are still waiting (e.g. the exit orphaned running ones),
   * wake it again — subject to the circuit breaker, and a container that
   * died right after starting counts as a failed wake, so a crash loop can't
   * restart forever. */
  private async onContainerExit(userId: string, err: unknown): Promise<void> {
    const startedAt = (await this.ctx.storage.get<number>("containerStartedAt")) ?? 0;
    const uptimeMs = startedAt ? Date.now() - startedAt : -1;
    console.warn(
      `[SessionDO] container exited for userId=${userId} after ${uptimeMs >= 0 ? `${Math.round(uptimeMs / 1000)}s` : "unknown uptime"}${err ? `: ${String(err)}` : ""}`,
    );
    if (uptimeMs >= 0 && uptimeMs < CONTAINER_SHORT_LIVED_MS) {
      await this.recordWakeResult(
        userId,
        false,
        `container exited ${Math.round(uptimeMs / 1000)}s after starting`,
      );
    }
    await this.rewakeForPendingJobs(userId, "container-exit");
  }

  private async rewakeForPendingJobs(userId: string, reason: string): Promise<void> {
    try {
      // Jobs a dead socket left 'running' go back to 'pending' first.
      const now = Date.now();
      const claimedJobIds = this.ctx.getWebSockets(userId).flatMap((s) => {
        const att = s.deserializeAttachment() as WsAttachment | null;
        if (!att || now - att.lastPingAt >= STALE_AFTER_MS) return [];
        return att.inflightJobIds;
      });
      await this.catalogStub(userId).fetch("http://do/jobs/reset-orphaned", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimedJobIds }),
      });

      const res = await this.catalogStub(userId).fetch("http://do/jobs/pending");
      if (!res.ok) return;
      const { jobs } = (await res.json()) as { jobs: TransformJob[] };
      if (jobs.length === 0) {
        console.log(`[SessionDO] ${reason}: no pending jobs, not re-waking userId=${userId}`);
        return;
      }
      console.log(
        `[SessionDO] ${reason}: ${jobs.length} pending job(s) (${jobs.map((j) => j.name ?? j.id).join(", ")}), re-waking userId=${userId}`,
      );
      // handleUpgrade's dispatchPendingJobs hands them over once it connects.
      await this.ensureContainerStarted(userId, undefined, reason, true);
    } catch (err) {
      console.error(`[SessionDO] ${reason}: re-wake check failed for userId=${userId}:`, err);
    }
  }

  private async dispatchPendingJobs(ws: WebSocket, userId: string): Promise<void> {
    try {
      // Collect job IDs actively claimed by live (non-stale) sockets for this user.
      // Stale socket attachments are excluded so their abandoned jobs get reset below.
      const now = Date.now();
      const claimedJobIds = this.ctx.getWebSockets(userId).flatMap((s) => {
        const att = s.deserializeAttachment() as WsAttachment | null;
        if (!att || now - att.lastPingAt >= STALE_AFTER_MS) return [];
        return att.inflightJobIds;
      });
      await this.catalogStub(userId).fetch("http://do/jobs/reset-orphaned", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimedJobIds }),
      });

      const catalogRes = await this.catalogStub(userId).fetch("http://do/jobs/pending");
      if (!catalogRes.ok) return;

      const { jobs } = (await catalogRes.json()) as { jobs: TransformJob[] };
      for (const job of jobs) {
        ws.send(
          JSON.stringify({
            type: "transform_job",
            jobId: job.id,
            sql: job.sql,
            outputTable: job.output_table,
            outputUri: job.output_uri,
            outputBackend: job.output_backend,
            format: job.format,
          }),
        );
      }
    } catch {
      // Non-fatal — browser will retry on next connect.
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: IncomingMessage;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      msg = JSON.parse(text) as IncomingMessage;
    } catch {
      return;
    }

    const attachment = ws.deserializeAttachment() as WsAttachment;

    if (msg.type === "ping") {
      ws.serializeAttachment({ ...attachment, lastPingAt: Date.now() });
      return;
    }

    if (msg.type === "result" || msg.type === "error") {
      console.log(
        `[SessionDO] webSocketMessage: type=${msg.type}, queryId=${msg.queryId}, pendingCount=${this.pendingQueries.size}`,
      );
      const pending = this.pendingQueries.get(msg.queryId);
      if (!pending) {
        console.warn(`[SessionDO] webSocketMessage: no pending query for queryId=${msg.queryId}`);
        return;
      }
      this.pendingQueries.delete(msg.queryId);
      if (msg.type === "result") {
        pending.resolve({ columns: msg.columns, rows: msg.rows });
      } else {
        pending.reject(new Error(msg.error));
      }
      return;
    }

    if (msg.type === "job_claimed") {
      const { userId, inflightJobIds } = attachment;
      if (!inflightJobIds.includes(msg.jobId)) {
        inflightJobIds.push(msg.jobId);
        ws.serializeAttachment({ ...attachment, inflightJobIds });
      }
      const claimRes = await this.catalogStub(userId).fetch(`http://do/jobs/${msg.jobId}/claim`, {
        method: "POST",
      });
      if (!claimRes.ok) {
        // Another socket won the race — remove from inflightJobIds so socket close
        // doesn't reset the legitimate owner's job back to pending.
        const cleaned = inflightJobIds.filter((id) => id !== msg.jobId);
        ws.serializeAttachment({ ...attachment, inflightJobIds: cleaned });
        // Tell the claimant it lost, so it doesn't run a duplicate of a job
        // that is already running (or gone). Older clients ignore this.
        console.log(
          `[SessionDO] job_claimed: REJECTED jobId=${msg.jobId} (status=${claimRes.status})`,
        );
        ws.send(JSON.stringify({ type: "job_rejected", jobId: msg.jobId }));
        return;
      }
      console.log(`[SessionDO] job_claimed: accepted jobId=${msg.jobId} userId=${userId}`);
      ws.send(JSON.stringify({ type: "job_accepted", jobId: msg.jobId }));
      this.broadcastJobStatus(userId, msg.jobId, "running");
      return;
    }

    if (msg.type === "job_complete") {
      const { userId, inflightJobIds } = attachment;
      const updated = inflightJobIds.filter((id) => id !== msg.jobId);
      ws.serializeAttachment({ ...attachment, inflightJobIds: updated });

      // Mark job done in catalog DO, which may trigger further jobs.
      const job = await this.getJobSpec(userId, msg.jobId);
      console.log(
        `[SessionDO] job_complete: jobId=${msg.jobId} table=${job?.output_table ?? "?"} uri=${job?.output_uri ?? "?"}`,
      );
      if (job) {
        // Commit the transform output to the catalog.
        const commit = await commitToCatalog(this.catalogStub(userId), {
          table: job.output_table,
          uri: job.output_uri,
          storageBackend: job.output_backend,
          format: job.format ?? undefined,
          message: `Transform job: ${job.name ?? job.id}`,
        });
        console.log(
          `[SessionDO] job_complete: commit of ${job.output_table} -> ${commit.status} jobId=${msg.jobId}`,
        );
        // Dispatch any newly triggered jobs to connected sockets.
        if (commit.ok && commit.triggeredJobIds.length > 0) {
          await this.dispatchPendingJobs(ws, userId);
        }
      }

      await this.catalogStub(userId).fetch(`http://do/jobs/${msg.jobId}/complete`, {
        method: "POST",
      });
      this.broadcastJobStatus(userId, msg.jobId, "done");
      return;
    }

    if (msg.type === "job_error") {
      const { userId, inflightJobIds } = attachment;
      console.warn(`[SessionDO] job_error: jobId=${msg.jobId} error=${msg.error}`);
      const updated = inflightJobIds.filter((id) => id !== msg.jobId);
      ws.serializeAttachment({ ...attachment, inflightJobIds: updated });

      await this.catalogStub(userId).fetch(`http://do/jobs/${msg.jobId}/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: msg.error }),
      });
      this.broadcastJobStatus(userId, msg.jobId, "failed", msg.error);
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    this.rejectPendingForSocket(ws, new Error("Browser session disconnected"));
    await this.resetInflightJobs(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.rejectPendingForSocket(ws, new Error("WebSocket error"));
    await this.resetInflightJobs(ws);
  }

  private rejectPendingForSocket(ws: WebSocket, error: Error): void {
    for (const [queryId, pending] of this.pendingQueries) {
      if (pending.ws === ws) {
        this.pendingQueries.delete(queryId);
        pending.reject(error);
      }
    }
  }

  private async resetInflightJobs(ws: WebSocket): Promise<void> {
    let attachment: WsAttachment | null = null;
    try {
      attachment = ws.deserializeAttachment() as WsAttachment;
    } catch {
      return;
    }
    if (!attachment?.inflightJobIds.length) return;

    try {
      await this.catalogStub(attachment.userId).fetch("http://do/jobs/reset-pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobIds: attachment.inflightJobIds }),
      });
    } catch {
      // Best-effort; jobs will remain in 'running' state until the scheduled cleanup.
    }
  }

  private async getJobSpec(userId: string, jobId: string): Promise<TransformJob | null> {
    try {
      const res = await this.catalogStub(userId).fetch("http://do/jobs");
      if (!res.ok) return null;
      const { jobs } = (await res.json()) as { jobs: TransformJob[] };
      return jobs.find((j) => j.id === jobId) ?? null;
    } catch {
      return null;
    }
  }

  private broadcastJobStatus(
    userId: string,
    jobId: string,
    status: "running" | "done" | "failed",
    error?: string,
  ): void {
    const msg = JSON.stringify({ type: "job_status", jobId, status, ...(error ? { error } : {}) });
    for (const s of this.ctx.getWebSockets(userId)) {
      try {
        s.send(msg);
      } catch {
        // Ignore closed sockets.
      }
    }
  }
}
