// Port of frontend/src/sessionWs.ts for the Node engine — connects to
// /session/ws and answers `query`/`transform_job` messages exactly as a
// browser tab would (src/session/do.ts does not distinguish client types).
import type WebSocket from "ws";
import type { TokenProvider } from "../auth/tokenProvider.js";
import type { DuckDBEngine } from "../duckdb/engine.js";
import { createLogger } from "../logger.js";
import { resolveStorageUris } from "../resolveQuery.js";
import { type PersistentWs, connectPersistentWs } from "../wsClient.js";

const logger = createLogger("session-ws");

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

// Matches DuckDB errors from a catalog view that hasn't been (re)created yet.
function isStaleCatalogError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /catalog error|does not exist|not found/i.test(message);
}

export function connectSession(config: {
  workerBase: string;
  tokenProvider: TokenProvider;
  engine: DuckDBEngine;
  /** Resolves once in-flight catalog view refreshes are done; no-op if catalog views are disabled. */
  getCatalogReady: () => Promise<void>;
}): PersistentWs {
  const { workerBase, tokenProvider, engine, getCatalogReady } = config;
  const getAuthHeaders = () => tokenProvider.getAuthHeaders();

  async function handleQuery(ws: WebSocket, msg: { queryId: string; sql: string }): Promise<void> {
    logger.info(`query ${msg.queryId} start`);
    try {
      const { sql, preamble } = await resolveStorageUris(msg.sql, workerBase, getAuthHeaders);
      const result = await engine.runQuery(sql, preamble.length > 0 ? preamble : undefined);
      ws.send(
        JSON.stringify({
          type: "result",
          queryId: msg.queryId,
          columns: result.columns,
          rows: result.rows,
        }),
      );
      logger.info(`query ${msg.queryId} done (${result.rows.length} rows)`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn(`query ${msg.queryId} failed: ${error}`);
      ws.send(JSON.stringify({ type: "error", queryId: msg.queryId, error }));
    }
  }

  async function handleTransformJob(
    ws: WebSocket,
    msg: { jobId: string; sql: string },
  ): Promise<void> {
    ws.send(JSON.stringify({ type: "job_claimed", jobId: msg.jobId }));

    const runOnce = async () => {
      const { sql, preamble } = await resolveStorageUris(msg.sql, workerBase, getAuthHeaders);
      await engine.runQuery(sql, preamble.length > 0 ? preamble : undefined);
    };

    try {
      try {
        await runOnce();
      } catch (err) {
        // A job dispatched right after a reconnect can race the catalog
        // resync — retry once after giving it a chance to settle.
        if (!isStaleCatalogError(err)) throw err;
        await new Promise((r) => setTimeout(r, 2000));
        await getCatalogReady();
        await runOnce();
      }
      ws.send(JSON.stringify({ type: "job_complete", jobId: msg.jobId }));
      logger.info(`transform job ${msg.jobId} complete`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn(`transform job ${msg.jobId} failed: ${error}`);
      ws.send(JSON.stringify({ type: "job_error", jobId: msg.jobId, error }));
    }
  }

  return connectPersistentWs(
    workerBase,
    "/session/ws",
    tokenProvider,
    {
      onMessage: (raw, ws) => {
        void (async () => {
          await getCatalogReady();

          let msg: ServerMessage;
          try {
            msg = JSON.parse(raw) as ServerMessage;
          } catch {
            return;
          }

          if (msg.type === "query") {
            await handleQuery(ws, msg);
          } else if (msg.type === "transform_job") {
            await handleTransformJob(ws, msg);
          } else if (msg.type === "job_status") {
            logger.info(
              `job ${msg.jobId} status: ${msg.status}${msg.error ? ` (${msg.error})` : ""}`,
            );
          }
        })();
      },
    },
    "session-ws",
  );
}
