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
  /**
   * Resolves when ALL view refreshes triggered by catalog commits are complete.
   * Chain-accumulates across concurrent commits so no in-flight refresh is lost.
   */
  getRefreshPromise(): Promise<void>;
}

export function connectCatalogWs(config: {
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  getDb: () => Promise<AsyncDuckDB>;
  /**
   * Called when a commit message arrives, before the view refresh starts.
   * Receives the refresh promise so the caller can track it immediately.
   */
  onCommit: (event: CatalogCommitEvent, refreshPromise: Promise<void>) => void;
  onStatusChange?: (connected: boolean) => void;
}): CatalogConnection {
  const { workerBase, getAuthHeaders, getDb, onCommit, onStatusChange } = config;

  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let visibilityHandler: (() => void) | null = null;
  // Accumulates across commits: resolves when every in-flight view refresh is done.
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

      const snapshot: CatalogSnapshot = {
        id: commitEvent.snapshotId,
        table_id: "",
        uri: commitEvent.uri,
        storage_backend: commitEvent.storage_backend,
        access_mode: commitEvent.access_mode,
        format: commitEvent.format,
        created_at: Date.now(),
      };

      // Create the refresh promise BEFORE notifying the caller so they can
      // immediately track it. Chain with any existing in-flight refresh so
      // getRefreshPromise() covers ALL pending catalog updates, not just the last.
      const thisRefresh = (async () => {
        try {
          const db = await getDb();
          await refreshSingleView(db, commitEvent.table, snapshot, workerBase, getAuthHeaders);
        } catch {
          // Non-fatal — the next full refresh will fix it.
        }
      })();

      currentRefreshPromise = Promise.all([currentRefreshPromise, thisRefresh]).then(() => {});

      // Notify App with the accumulated promise so catalogReadyRef is always current.
      onCommit(commitEvent, currentRefreshPromise);
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
    getRefreshPromise() {
      return currentRefreshPromise;
    },
  };
}
