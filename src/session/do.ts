import type { TransformJob } from "../catalog/do.ts";
import type { Env } from "../types.ts";

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

interface WsAttachment {
  userId: string;
  inflightJobIds: string[];
}

type IncomingMessage =
  | { type: "result"; queryId: string; columns: string[]; rows: unknown[][] }
  | { type: "error"; queryId: string; error: string }
  | { type: "job_claimed"; jobId: string }
  | { type: "job_complete"; jobId: string }
  | { type: "job_error"; jobId: string; error: string };

export class SessionDO implements DurableObject {
  // In-memory map of pending MCP queries. Safe because the DO never hibernates
  // while a fetch handler is awaiting — active fetch requests prevent hibernation.
  private pendingQueries = new Map<
    string,
    { resolve: (v: QueryResult) => void; reject: (e: Error) => void; ws: WebSocket }
  >();

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

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

    if (request.method === "GET" && pathname === "/status") {
      const userId = request.headers.get("X-User-ID") ?? "";
      const count = userId
        ? this.ctx.getWebSockets(userId).length
        : this.ctx.getWebSockets().length;
      return Response.json({ sessionCount: count });
    }

    return new Response("Not Found", { status: 404 });
  }

  private handleUpgrade(request: Request): Response {
    const userId = request.headers.get("X-User-ID") ?? "";
    if (!userId) return new Response("Missing X-User-ID", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.ctx.acceptWebSocket(server, [userId]);
    server.serializeAttachment({ userId, inflightJobIds: [] } satisfies WsAttachment);

    // Dispatch any pending jobs to this new connection (fire and forget).
    this.ctx.waitUntil(this.dispatchPendingJobs(server, userId));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleQuery(request: Request): Promise<Response> {
    const body = (await request.json()) as { sql: string; userId: string; queryId?: string };
    const { sql, userId, queryId: reqId } = body;

    if (!sql || !userId)
      return Response.json({ error: "sql and userId are required" }, { status: 400 });

    const sockets = this.ctx.getWebSockets(userId);
    if (sockets.length === 0) {
      return Response.json(
        {
          error: "no_session",
          message: "No active browser session. Open a browser tab to run queries.",
        },
        { status: 503 },
      );
    }

    const queryId = reqId ?? crypto.randomUUID();
    const ws = sockets[0]!;
    console.log(
      `[SessionDO] handleQuery: found ${sockets.length} socket(s) for userId=${userId}, queryId=${queryId}, readyState=${ws.readyState}`,
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
    const body = (await request.json()) as { userId: string; jobIds?: string[] };
    const { userId } = body;
    if (!userId) return Response.json({ error: "userId is required" }, { status: 400 });

    const sockets = this.ctx.getWebSockets(userId);
    if (sockets.length === 0) return Response.json({ dispatched: 0 });

    // Fetch pending jobs from Catalog DO.
    const catalogRes = await this.catalogStub(userId).fetch("http://do/jobs/pending");
    if (!catalogRes.ok) return Response.json({ dispatched: 0 });

    const { jobs } = (await catalogRes.json()) as { jobs: TransformJob[] };
    if (jobs.length === 0) return Response.json({ dispatched: 0 });

    const ws = sockets[0]!;
    let dispatched = 0;
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
      dispatched++;
    }

    return Response.json({ dispatched });
  }

  private async dispatchPendingJobs(ws: WebSocket, userId: string): Promise<void> {
    try {
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
        ws.serializeAttachment({ userId, inflightJobIds });
      }
      await this.catalogStub(userId).fetch(`http://do/jobs/${msg.jobId}/claim`, { method: "POST" });
      return;
    }

    if (msg.type === "job_complete") {
      const { userId, inflightJobIds } = attachment;
      const updated = inflightJobIds.filter((id) => id !== msg.jobId);
      ws.serializeAttachment({ userId, inflightJobIds: updated });

      // Mark job done in catalog DO, which may trigger further jobs.
      const job = await this.getJobSpec(userId, msg.jobId);
      if (job) {
        // Commit the transform output to the catalog.
        const commitRes = await this.catalogStub(userId).fetch("http://do/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            table: job.output_table,
            uri: job.output_uri,
            storageBackend: job.output_backend,
            format: job.format ?? undefined,
            message: `Transform job: ${job.name ?? job.id}`,
          }),
        });
        if (commitRes.ok) {
          const { triggeredJobIds } = (await commitRes.json()) as {
            triggeredJobIds?: string[];
          };
          // Dispatch any newly triggered jobs to connected browsers.
          if (triggeredJobIds && triggeredJobIds.length > 0) {
            await this.dispatchPendingJobs(ws, userId);
          }
        }
      }

      await this.catalogStub(userId).fetch(`http://do/jobs/${msg.jobId}/complete`, {
        method: "POST",
      });
      return;
    }

    if (msg.type === "job_error") {
      const { userId, inflightJobIds } = attachment;
      const updated = inflightJobIds.filter((id) => id !== msg.jobId);
      ws.serializeAttachment({ userId, inflightJobIds: updated });

      await this.catalogStub(userId).fetch(`http://do/jobs/${msg.jobId}/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: msg.error }),
      });
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
}
