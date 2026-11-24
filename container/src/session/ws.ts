// Port of frontend/src/sessionWs.ts for the Node engine — connects to
// /session/ws and answers `query`/`transform_job` messages exactly as a
// browser tab would (src/session/do.ts does not distinguish client types).
import type WebSocket from "ws";
import type { TokenProvider } from "../auth/tokenProvider.js";
import { describeViewsUsedBy } from "../catalog/views.js";
import type { DuckDBEngine } from "../duckdb/engine.js";
import { createLogger } from "../logger.js";
import { resolveStorageUris } from "../resolveQuery.js";
import { type PersistentWs, connectPersistentWs } from "../wsClient.js";
import { copyWroteNothing, emptyOutputSql } from "./emptyOutput.js";

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
  | { type: "job_accepted"; jobId: string }
  | { type: "job_rejected"; jobId: string }
  | { type: "job_status"; jobId: string; status: "running" | "done" | "failed"; error?: string };

// Matches DuckDB errors from a catalog view that hasn't been (re)created yet.
function isStaleCatalogError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /catalog error|does not exist|not found/i.test(message);
}

// How long to wait for the Session DO to accept/reject a job claim before
// running anyway (an older DO never answers).
const CLAIM_ACK_TIMEOUT_MS = 10_000;

export function connectSession(config: {
  workerBase: string;
  tokenProvider: TokenProvider;
  engine: DuckDBEngine;
  /** Resolves once in-flight catalog view refreshes are done; no-op if catalog views are disabled. */
  getCatalogReady: () => Promise<void>;
}): PersistentWs {
  const { workerBase, tokenProvider, engine, getCatalogReady } = config;
  const getAuthHeaders = () => tokenProvider.getAuthHeaders();

  // Claim acks from the Session DO, keyed by jobId. Resolves true if the claim
  // was accepted (or never answered), false if another socket already owns it.
  const pendingClaims = new Map<string, (accepted: boolean) => void>();
  // Jobs this socket is currently claiming or running. The same job can be
  // dispatched to us more than once in quick succession (connect-time dispatch
  // plus a commit-triggered one); only the first may proceed, otherwise the
  // second claim would clobber the first's ack waiter in pendingClaims.
  const activeJobs = new Set<string>();

  function claimJob(ws: WebSocket, jobId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingClaims.delete(jobId);
        resolve(true);
      }, CLAIM_ACK_TIMEOUT_MS);
      pendingClaims.set(jobId, (accepted) => {
        clearTimeout(timer);
        pendingClaims.delete(jobId);
        resolve(accepted);
      });
      ws.send(JSON.stringify({ type: "job_claimed", jobId }));
    });
  }

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
    msg: { jobId: string; sql: string; outputUri?: string; format?: string | null },
  ): Promise<void> {
    if (activeJobs.has(msg.jobId)) {
      logger.info(`job ${msg.jobId} already running on this socket — skipping duplicate dispatch`);
      return;
    }
    activeJobs.add(msg.jobId);
    try {
      await runClaimedJob(ws, msg);
    } finally {
      activeJobs.delete(msg.jobId);
    }
  }

  // COPY ... TO writes no file for an empty result, so the previous output would
  // otherwise survive. Overwrite it with an explicitly empty one.
  async function clearStaleOutput(
    jobId: string,
    outputUri: string,
    format: string | null | undefined,
  ): Promise<void> {
    const emptySql = emptyOutputSql(outputUri, format);
    if (!emptySql) {
      logger.warn(
        `job ${jobId} produced 0 rows but ${outputUri} (format=${format ?? "?"}) can't be emptied automatically; the previous output is left in place`,
      );
      return;
    }
    const { sql, preamble } = await resolveStorageUris(emptySql, workerBase, getAuthHeaders);
    await engine.runQuery(sql, preamble.length > 0 ? preamble : undefined);
    logger.info(`job ${jobId} produced 0 rows — overwrote ${outputUri} with an empty result`);
  }

  async function runClaimedJob(
    ws: WebSocket,
    msg: { jobId: string; sql: string; outputUri?: string; format?: string | null },
  ): Promise<void> {
    if (!(await claimJob(ws, msg.jobId))) {
      logger.info(`job ${msg.jobId} already claimed elsewhere — skipping`);
      return;
    }

    const startedAt = Date.now();
    const runOnce = async () => {
      const { sql, preamble } = await resolveStorageUris(msg.sql, workerBase, getAuthHeaders);
      const inputs = describeViewsUsedBy(msg.sql)
        .map(
          (v) =>
            `${v.name}@${v.snapshotId} (registered ${Math.round((Date.now() - v.registeredAt) / 1000)}s ago)`,
        )
        .join(", ");
      logger.info(
        `job ${msg.jobId} running: inputs=[${inputs || "none"}] preamble=${preamble.length}`,
      );
      return engine.runQuery(sql, preamble.length > 0 ? preamble : undefined);
    };
    const describe = (r: { columns: string[]; rows: unknown[][] }) =>
      `columns=[${r.columns.join(",")}] firstRow=${JSON.stringify(r.rows[0] ?? null)}`;

    try {
      let result: Awaited<ReturnType<typeof runOnce>>;
      try {
        result = await runOnce();
      } catch (err) {
        // A job dispatched right after a reconnect can race the catalog
        // resync — retry once after giving it a chance to settle.
        if (!isStaleCatalogError(err)) throw err;
        logger.warn(`job ${msg.jobId} hit a stale-catalog error, retrying: ${String(err)}`);
        await new Promise((r) => setTimeout(r, 2000));
        await getCatalogReady();
        result = await runOnce();
      }
      if (msg.outputUri && copyWroteNothing(result)) {
        await clearStaleOutput(msg.jobId, msg.outputUri, msg.format);
      }
      ws.send(JSON.stringify({ type: "job_complete", jobId: msg.jobId }));
      logger.info(
        `transform job ${msg.jobId} complete in ${Date.now() - startedAt}ms -> ${msg.outputUri ?? "?"} ${describe(result)}`,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn(`transform job ${msg.jobId} failed after ${Date.now() - startedAt}ms: ${error}`);
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

          if (msg.type === "job_accepted" || msg.type === "job_rejected") {
            pendingClaims.get(msg.jobId)?.(msg.type === "job_accepted");
          } else if (msg.type === "query") {
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
