import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { runQuery } from "./duckdb.ts";
import { resolveStorageUris } from "./resolveQuery.ts";

export type JobEvent =
  | { jobId: string; status: "running" }
  | { jobId: string; status: "done" }
  | { jobId: string; status: "failed"; error: string };

export interface SessionConnection {
  close(): void;
  isConnected(): boolean;
  setJobEventListener(listener: ((ev: JobEvent) => void) | null): void;
}

type ServerMessage =
  | { type: "query"; queryId: string; sql: string }
  | {
      type: "transform_job";
      jobId: string;
      sql: string;
      outputTable: string;
      outputUri: string;
      outputBackend: string;
      format?: string | null;
    }
  | { type: "job_status"; jobId: string; status: "running" | "done" | "failed"; error?: string };

export function connectSession(config: {
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  getDb: () => Promise<AsyncDuckDB>;
  /** Returns a promise that resolves when catalog views are current. */
  getCatalogReady: () => Promise<void>;
  onStatusChange?: (connected: boolean) => void;
}): SessionConnection {
  const { workerBase, getAuthHeaders, getDb, getCatalogReady, onStatusChange } = config;

  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let jobEventListener: ((ev: JobEvent) => void) | null = null;
  let visibilityHandler: (() => void) | null = null;

  // Prevent Chrome/Edge from throttling JS in background tabs.
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    (
      navigator.locks as {
        request: (name: string, opts: { mode: string }, cb: () => Promise<void>) => void;
      }
    ).request("data-shack-ws", { mode: "shared" }, () => new Promise<void>(() => {}));
  }

  async function connect() {
    if (closed) return;

    const headers = await getAuthHeaders();
    const token =
      headers["X-Dev-Token"] ??
      (headers.Authorization?.startsWith("Bearer ") ? headers.Authorization.slice(7) : null);

    if (!token) return; // No auth — skip connecting.

    // Build WebSocket URL from workerBase (http → ws, https → wss).
    const wsBase = workerBase.replace(/^http/, "ws");
    const url = `${wsBase}/session/ws`;
    // Pass auth token as Sec-WebSocket-Protocol (avoids token appearing in URL logs).
    const socket = new WebSocket(url, [token]);
    ws = socket;

    let pingInterval: ReturnType<typeof setInterval> | null = null;

    socket.onopen = () => {
      onStatusChange?.(true);
      // Heartbeat keeps the connection alive and lets the DO detect stale sockets.
      pingInterval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "ping" }));
        }
      }, 25_000);
    };

    socket.onmessage = async (event: MessageEvent) => {
      // Ensure catalog views are ready before processing any query or job.
      await getCatalogReady();

      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }

      console.log("[sessionWs] received message type:", msg.type);

      if (msg.type === "query") {
        await handleQuery(socket, msg, workerBase, getAuthHeaders, getDb);
      } else if (msg.type === "transform_job") {
        await handleTransformJob(socket, msg, workerBase, getAuthHeaders, getDb);
      } else if (msg.type === "job_status") {
        const ev: JobEvent =
          msg.status === "failed"
            ? { jobId: msg.jobId, status: "failed", error: msg.error ?? "Unknown error" }
            : { jobId: msg.jobId, status: msg.status };
        jobEventListener?.(ev);
      }
    };

    socket.onclose = () => {
      if (pingInterval !== null) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      ws = null;
      onStatusChange?.(false);
      if (!closed) {
        reconnectTimer = setTimeout(() => {
          connect().catch(() => {});
        }, 5000);
      }
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  // Reconnect immediately when the tab becomes visible, rather than waiting
  // for the 5s reconnect timer to fire after the browser may have throttled us.
  if (typeof document !== "undefined") {
    visibilityHandler = () => {
      if (document.visibilityState === "visible" && !closed && ws?.readyState !== WebSocket.OPEN) {
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        connect().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);
  }

  connect().catch(() => {});

  return {
    close() {
      closed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      ws?.close();
      if (visibilityHandler !== null) {
        document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
      }
    },
    isConnected() {
      return ws?.readyState === WebSocket.OPEN;
    },
    setJobEventListener(listener) {
      jobEventListener = listener;
    },
  };
}

async function handleQuery(
  ws: WebSocket,
  msg: { type: "query"; queryId: string; sql: string },
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
  getDb: () => Promise<AsyncDuckDB>,
) {
  console.log("[sessionWs] handleQuery start", msg.queryId);
  try {
    const db = await getDb();
    console.log("[sessionWs] handleQuery: db ready");
    const { sql, preamble } = await resolveStorageUris(msg.sql, workerBase, getAuthHeaders);
    console.log("[sessionWs] handleQuery: URIs resolved, running query");
    const result = await runQuery(db, sql, preamble.length > 0 ? preamble : undefined);
    console.log("[sessionWs] handleQuery: query done, sending result");
    ws.send(
      JSON.stringify({
        type: "result",
        queryId: msg.queryId,
        columns: result.columns,
        rows: result.rows,
      }),
    );
    console.log("[sessionWs] handleQuery: result sent");
  } catch (err) {
    console.error("[sessionWs] handleQuery error:", err);
    ws.send(
      JSON.stringify({
        type: "error",
        queryId: msg.queryId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

async function handleTransformJob(
  ws: WebSocket,
  msg: {
    type: "transform_job";
    jobId: string;
    sql: string;
    outputTable: string;
    outputUri: string;
    outputBackend: string;
    format?: string | null;
  },
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
  getDb: () => Promise<AsyncDuckDB>,
) {
  // Claim the job — Session DO will broadcast job_status: running to all connected sockets.
  ws.send(JSON.stringify({ type: "job_claimed", jobId: msg.jobId }));

  try {
    const db = await getDb();
    // Catalog views are kept current by the catalog WebSocket (getCatalogReady was awaited
    // before this handler was called in onmessage). No full re-registration needed here.
    const { sql, preamble } = await resolveStorageUris(msg.sql, workerBase, getAuthHeaders);
    await runQuery(db, sql, preamble.length > 0 ? preamble : undefined);
    ws.send(JSON.stringify({ type: "job_complete", jobId: msg.jobId }));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ws.send(JSON.stringify({ type: "job_error", jobId: msg.jobId, error }));
  }
}
