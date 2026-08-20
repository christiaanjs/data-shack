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
  /**
   * Re-syncs the full catalog (metadata + views). Called after a RECONNECT —
   * commits broadcast while the socket was down were never received, so a
   * full refresh is the only way to recover them.
   */
  resync?: () => Promise<void>;
  /**
   * Receives the accumulated refresh promise when a reconnect resync starts,
   * so the caller can fold it into its catalog-ready tracking.
   */
  onResync?: (refreshPromise: Promise<void>) => void;
  /** Called when a single-view refresh has failed after retrying. */
  onRefreshFailed?: (table: string) => void;
  /**
   * Returns a promise that resolves when all catalog work in flight at call
   * time (initial view registration, prior refreshes) is done. Commit-driven
   * view refreshes wait on it so they never race the initial
   * registerCatalogViews pass — without this, a commit arriving during page
   * load could be clobbered by the init pass re-creating the view from the
   * older snapshot list it fetched before the commit.
   */
  getCatalogReady?: () => Promise<void>;
  onStatusChange?: (connected: boolean) => void;
}): CatalogConnection {
  const { workerBase, getAuthHeaders, getDb, onCommit, resync, onResync, onRefreshFailed } = config;
  const { getCatalogReady, onStatusChange } = config;

  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let visibilityHandler: (() => void) | null = null;
  let hasConnectedBefore = false;
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
      // On reconnect, re-sync the full catalog: any commits broadcast while
      // the socket was down were lost, leaving views stale or missing.
      if (hasConnectedBefore && resync) {
        const resyncPromise = (async () => {
          try {
            await resync();
          } catch {
            // Resync failure is surfaced by the caller's own error state.
          }
        })();
        currentRefreshPromise = Promise.all([currentRefreshPromise, resyncPromise]).then(() => {});
        onResync?.(currentRefreshPromise);
      }
      hasConnectedBefore = true;
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

      // Capture the catalog-ready barrier NOW, before the caller folds this
      // refresh into it — awaiting the ref's later value would deadlock on
      // this very refresh.
      const barrier = getCatalogReady?.() ?? Promise.resolve();

      // Create the refresh promise BEFORE notifying the caller so they can
      // immediately track it. Chain with any existing in-flight refresh so
      // getRefreshPromise() covers ALL pending catalog updates, not just the last.
      const thisRefresh = (async () => {
        try {
          // Wait for the initial registration (and prior refreshes) to finish
          // so this commit's fresher snapshot is applied last, never clobbered.
          await barrier;
          const db = await getDb();
          try {
            await refreshSingleView(db, commitEvent.table, snapshot, workerBase, getAuthHeaders);
          } catch {
            // Transient failures (expiring proxy cred, flaky network) usually
            // clear on a second attempt.
            await new Promise((r) => setTimeout(r, 2000));
            await refreshSingleView(db, commitEvent.table, snapshot, workerBase, getAuthHeaders);
          }
        } catch {
          // Both attempts failed (or the DuckDB session is disabled) — let the
          // caller mark the table as failed instead of pretending it's fresh.
          onRefreshFailed?.(commitEvent.table);
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
