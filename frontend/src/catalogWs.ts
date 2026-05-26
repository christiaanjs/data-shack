import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { type CatalogSnapshot, refreshSingleView } from "./catalogViews.ts";

export interface CatalogCommitEvent {
  table: string;
  snapshotId: string;
  uri: string;
  storage_backend: string;
  access_mode: string;
  format: string | null;
}

export interface CatalogConnection {
  close(): void;
  isConnected(): boolean;
  /** Resolves when the most recent view refresh triggered by a commit is complete. */
  getRefreshPromise(): Promise<void>;
}

export function connectCatalogWs(config: {
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  getDb: () => Promise<AsyncDuckDB>;
  onCommit: (event: CatalogCommitEvent) => void;
  onStatusChange?: (connected: boolean) => void;
}): CatalogConnection {
  const { workerBase, getAuthHeaders, getDb, onCommit, onStatusChange } = config;

  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Starts resolved; updated to a pending promise while a view refresh is in flight.
  let currentRefreshPromise: Promise<void> = Promise.resolve();

  async function connect() {
    if (closed) return;

    const headers = await getAuthHeaders();
    const token =
      headers["X-Dev-Token"] ??
      (headers.Authorization?.startsWith("Bearer ") ? headers.Authorization.slice(7) : null);

    if (!token) return;

    const wsBase = workerBase.replace(/^http/, "ws");
    const socket = new WebSocket(`${wsBase}/catalog/ws`, [token]);
    ws = socket;

    let pingInterval: ReturnType<typeof setInterval> | null = null;

    socket.onopen = () => {
      onStatusChange?.(true);
      pingInterval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "ping" }));
        }
      }, 25_000);
    };

    socket.onmessage = (event: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg.type !== "commit") return;

      const commitEvent: CatalogCommitEvent = {
        table: msg.table as string,
        snapshotId: msg.snapshotId as string,
        uri: msg.uri as string,
        storage_backend: msg.storage_backend as string,
        access_mode: msg.access_mode as string,
        format: (msg.format as string | null) ?? null,
      };

      // Notify App so it can update catalog state and flash the indicator.
      onCommit(commitEvent);

      // Refresh the DuckDB view for this table. Track the promise so transform
      // jobs dispatched by the same commit can await it before running their SQL.
      const snapshot: CatalogSnapshot = {
        id: commitEvent.snapshotId,
        table_id: "",
        uri: commitEvent.uri,
        storage_backend: commitEvent.storage_backend,
        access_mode: commitEvent.access_mode,
        format: commitEvent.format,
        created_at: Date.now(),
      };

      currentRefreshPromise = (async () => {
        try {
          const db = await getDb();
          await refreshSingleView(db, commitEvent.table, snapshot, workerBase, getAuthHeaders);
        } catch {
          // Non-fatal — the next full refresh will fix it.
        }
      })();
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

  // Reconnect when the tab becomes visible after being backgrounded.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !closed && ws?.readyState !== WebSocket.OPEN) {
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        connect().catch(() => {});
      }
    });
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
    getRefreshPromise() {
      return currentRefreshPromise;
    },
  };
}
