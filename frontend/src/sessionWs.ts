import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { registerCatalogViews } from "./catalogViews.ts";
import { runQuery } from "./duckdb.ts";
import { resolveStorageUris } from "./resolveQuery.ts";

export interface SessionConnection {
  close(): void;
  isConnected(): boolean;
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
    };

export function connectSession(config: {
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  getDb: () => Promise<AsyncDuckDB>;
  onStatusChange?: (connected: boolean) => void;
}): SessionConnection {
  const { workerBase, getAuthHeaders, getDb, onStatusChange } = config;

  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  async function connect() {
    if (closed) return;

    const headers = await getAuthHeaders();
    const token =
      headers["X-Dev-Token"] ??
      (headers.Authorization?.startsWith("Bearer ") ? headers.Authorization.slice(7) : null);

    if (!token) return; // No auth — skip connecting.

    // Build WebSocket URL from workerBase (http → ws, https → wss).
    const wsBase = workerBase.replace(/^http/, "ws");
    // Pass auth token as query param since WebSocket API can't set custom headers.
    const url = `${wsBase}/session/ws?token=${encodeURIComponent(token)}`;

    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = async () => {
      onStatusChange?.(true);
      // Register catalog views once on connect so they're ready before any query arrives.
      const db = await getDb();
      registerCatalogViews(db, workerBase, getAuthHeaders).catch(() => {});
    };

    socket.onmessage = async (event: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }

      if (msg.type === "query") {
        await handleQuery(socket, msg, workerBase, getAuthHeaders, getDb);
      } else if (msg.type === "transform_job") {
        await handleTransformJob(socket, msg, workerBase, getAuthHeaders, getDb);
      }
    };

    socket.onclose = () => {
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

  connect().catch(() => {});

  return {
    close() {
      closed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      ws?.close();
    },
    isConnected() {
      return ws?.readyState === WebSocket.OPEN;
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
  try {
    const db = await getDb();
    const { sql, preamble } = await resolveStorageUris(msg.sql, workerBase, getAuthHeaders);
    const result = await runQuery(db, sql, preamble.length > 0 ? preamble : undefined);
    ws.send(
      JSON.stringify({
        type: "result",
        queryId: msg.queryId,
        columns: result.columns,
        rows: result.rows,
      }),
    );
  } catch (err) {
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
  // Claim the job immediately so the Session DO tracks it as in-flight.
  ws.send(JSON.stringify({ type: "job_claimed", jobId: msg.jobId }));

  try {
    const db = await getDb();
    // Register catalog views so the transform SQL can reference catalog table names.
    await registerCatalogViews(db, workerBase, getAuthHeaders).catch(() => {});
    const { sql, preamble } = await resolveStorageUris(msg.sql, workerBase, getAuthHeaders);
    await runQuery(db, sql, preamble.length > 0 ? preamble : undefined);
    ws.send(JSON.stringify({ type: "job_complete", jobId: msg.jobId }));
  } catch (err) {
    ws.send(
      JSON.stringify({
        type: "job_error",
        jobId: msg.jobId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
