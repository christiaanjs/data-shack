// Port of frontend/src/catalogWs.ts for the Node engine — connects to
// /catalog/ws and keeps DuckDB views in sync with catalog commits so SQL can
// reference catalog tables by name (SELECT * FROM my_table).
import type { TokenProvider } from "../auth/tokenProvider.js";
import type { DuckDBEngine } from "../duckdb/engine.js";
import { createLogger } from "../logger.js";
import { type PersistentWs, connectPersistentWs } from "../wsClient.js";
import { type CatalogSnapshot, refreshSingleView, registerCatalogViews } from "./views.js";

const logger = createLogger("catalog-ws");

export interface CatalogCommitEvent {
  table: string;
  snapshotId: string;
  uri: string;
  storage_backend: string;
  access_mode: string;
  format: string | null;
}

export interface CatalogConnection extends PersistentWs {
  /** Resolves once every view refresh in flight at call time has settled. */
  getCatalogReady(): Promise<void>;
}

export function connectCatalogWs(config: {
  workerBase: string;
  tokenProvider: TokenProvider;
  engine: DuckDBEngine;
  onCommit?: (event: CatalogCommitEvent) => void;
}): CatalogConnection {
  const { workerBase, tokenProvider, engine, onCommit } = config;
  const getAuthHeaders = () => tokenProvider.getAuthHeaders();

  // Chain-accumulates so concurrent commits never clobber each other's view refresh.
  let refreshChain: Promise<void> = Promise.resolve();

  async function fullResync(): Promise<void> {
    try {
      const { failed } = await registerCatalogViews(engine, workerBase, getAuthHeaders);
      if (failed.length > 0) logger.warn(`view registration failed for: ${failed.join(", ")}`);
      else logger.info("catalog views registered");
    } catch (err) {
      logger.error("catalog view registration failed", err);
    }
  }

  const persistent = connectPersistentWs(
    workerBase,
    "/catalog/ws",
    tokenProvider,
    {
      onOpen: (_ws, isReconnect) => {
        // On (re)connect, do a full resync: on first connect there are no
        // views yet; on reconnect, commits broadcast while the socket was
        // down were missed and views may be stale.
        refreshChain = refreshChain.then(fullResync);
        void isReconnect;
      },
      onMessage: (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.type !== "commit") return;

        const event: CatalogCommitEvent = {
          table: msg.table as string,
          snapshotId: msg.snapshotId as string,
          uri: msg.uri as string,
          storage_backend: msg.storage_backend as string,
          access_mode: msg.access_mode as string,
          format: (msg.format as string | null) ?? null,
        };
        const snapshot: CatalogSnapshot = {
          id: event.snapshotId,
          table_id: "",
          uri: event.uri,
          storage_backend: event.storage_backend,
          access_mode: event.access_mode,
          format: event.format,
          created_at: Date.now(),
        };

        const thisRefresh = refreshChain.then(async () => {
          try {
            await refreshSingleView(engine, event.table, snapshot, workerBase, getAuthHeaders);
          } catch {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              await refreshSingleView(engine, event.table, snapshot, workerBase, getAuthHeaders);
            } catch (err) {
              logger.error(`failed to refresh view for table "${event.table}"`, err);
            }
          }
        });
        refreshChain = thisRefresh;
        onCommit?.(event);
      },
    },
    "catalog-ws",
  );

  return {
    ...persistent,
    getCatalogReady: () => refreshChain,
  };
}
