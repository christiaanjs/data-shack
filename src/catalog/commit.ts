import type { Env } from "../types.ts";

export interface CatalogCommitBody {
  table: string;
  uri: string;
  storageBackend?: string | null;
  format?: string;
  message?: string;
}

export interface CatalogCommitResult {
  ok: boolean;
  status: number;
  /** Response body text on failure, for error messages. */
  error?: string;
  triggeredJobIds: string[];
  /** Parsed success body (snapshotId etc.), for routes that relay it. */
  data?: Record<string, unknown>;
}

/**
 * The one place that commits a snapshot to a user's catalog DO. Load jobs
 * (queue consumer), transform job completion (session DO) and the
 * `POST /catalog/commit` route all go through here, so trigger evaluation and
 * the `triggeredJobIds` contract live in a single code path.
 */
export async function commitToCatalog(
  catalogStub: { fetch(input: string, init?: RequestInit): Promise<Response> },
  body: CatalogCommitBody | Record<string, unknown>,
): Promise<CatalogCommitResult> {
  const res = await catalogStub.fetch("http://do/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await res.text(), triggeredJobIds: [] };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    triggeredJobIds?: string[];
  };
  return { ok: true, status: res.status, triggeredJobIds: data.triggeredJobIds ?? [], data };
}

/**
 * Tells the user's session DO that these jobs are pending, so it can hand them
 * to a live socket or wake the container. Best-effort: jobs stay `pending` in
 * the catalog DO either way and are picked up on the next connect.
 * `workerOrigin` is optional — the session DO remembers the last one it saw,
 * which is what lets the queue consumer (no request, no origin) wake a container.
 */
export async function dispatchTriggeredJobs(
  env: Pick<Env, "SESSION_DO">,
  userId: string,
  jobIds: string[],
  workerOrigin?: string,
): Promise<void> {
  if (jobIds.length === 0) return;
  try {
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(userId));
    await stub.fetch("http://do/dispatch-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, jobIds, workerOrigin }),
    });
  } catch (err) {
    console.warn(`[dispatch] /dispatch-jobs failed for userId=${userId}:`, err);
  }
}
