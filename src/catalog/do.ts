import type { Env } from "../types.ts";

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function parseWatches(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [raw];
  } catch {
    return [raw];
  }
}

// Safe SQL identifier: must start with a letter or underscore, then alphanumeric/underscore only.
const SAFE_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

interface CommitBody {
  table: string;
  uri: string;
  storageBackend: string;
  accessMode?: string;
  format?: string;
  message?: string;
}

export interface TransformJob {
  id: string;
  name: string | null;
  sql: string;
  output_table: string;
  output_uri: string;
  output_backend: string;
  format: string | null;
  status: string;
  requires_browser: number;
  created_at: number;
  updated_at: number;
  last_completed_at: number | null;
  error: string | null;
}

export class CatalogDO implements DurableObject {
  constructor(
    private ctx: DurableObjectState,
    private _env: Env,
  ) {
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tables (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id              TEXT PRIMARY KEY,
        table_id        TEXT NOT NULL REFERENCES tables(id),
        uri             TEXT NOT NULL,
        storage_backend TEXT NOT NULL,
        access_mode     TEXT NOT NULL DEFAULT 'signed',
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commits (
        id           TEXT PRIMARY KEY,
        table_id     TEXT NOT NULL REFERENCES tables(id),
        snapshot_id  TEXT NOT NULL REFERENCES snapshots(id),
        committed_at INTEGER NOT NULL,
        message      TEXT
      );

      CREATE TABLE IF NOT EXISTS transform_jobs (
        id               TEXT PRIMARY KEY,
        name             TEXT,
        sql              TEXT NOT NULL,
        output_table     TEXT NOT NULL,
        output_uri       TEXT NOT NULL,
        output_backend   TEXT NOT NULL,
        format           TEXT,
        status           TEXT NOT NULL DEFAULT 'idle',
        requires_browser INTEGER NOT NULL DEFAULT 1,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        error            TEXT
      );

      CREATE TABLE IF NOT EXISTS triggers (
        id         TEXT PRIMARY KEY,
        watches    TEXT NOT NULL,
        job_id     TEXT NOT NULL REFERENCES transform_jobs(id),
        created_at INTEGER NOT NULL
      );
    `);

    // Add format column to existing instances that predate this field.
    try {
      ctx.storage.sql.exec("ALTER TABLE snapshots ADD COLUMN format TEXT");
    } catch {
      // Column already exists — nothing to do.
    }

    // Add deleted_at for soft-delete support.
    try {
      ctx.storage.sql.exec("ALTER TABLE tables ADD COLUMN deleted_at INTEGER");
    } catch {
      // Column already exists — nothing to do.
    }

    // Migrate watches to JSON array format (e.g. "transactions" → '["transactions"]').
    ctx.storage.sql.exec(
      "UPDATE triggers SET watches = json_array(watches) WHERE watches NOT LIKE '[%'",
    );

    // Add policy column (multi-table trigger coordination).
    try {
      ctx.storage.sql.exec("ALTER TABLE triggers ADD COLUMN policy TEXT NOT NULL DEFAULT 'any'");
    } catch {
      // Column already exists — nothing to do.
    }

    // Add last_completed_at for 'all' policy freshness tracking.
    try {
      ctx.storage.sql.exec("ALTER TABLE transform_jobs ADD COLUMN last_completed_at INTEGER");
    } catch {
      // Column already exists — nothing to do.
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/tables") {
      return this.getTables();
    }

    if (request.method === "GET" && pathname.startsWith("/snapshots/")) {
      const tableRef = decodeURIComponent(pathname.slice("/snapshots/".length));
      return this.getSnapshots(tableRef);
    }

    if (request.method === "POST" && pathname === "/commit") {
      const body = (await request.json()) as CommitBody;
      return this.commit(body);
    }

    if (request.method === "PATCH" && pathname.startsWith("/snapshots/")) {
      const snapshotId = decodeURIComponent(pathname.slice("/snapshots/".length));
      const body = (await request.json()) as Record<string, unknown>;
      return this.patchSnapshot(snapshotId, body);
    }

    if (request.method === "DELETE" && pathname.startsWith("/tables/")) {
      const tableRef = decodeURIComponent(pathname.slice("/tables/".length));
      return this.deleteTable(tableRef);
    }

    // ── Transform job endpoints ───────────────────────────────────────────

    if (request.method === "GET" && pathname === "/jobs") {
      return this.listJobs();
    }

    if (request.method === "GET" && pathname === "/jobs/pending") {
      return this.listPendingJobs();
    }

    if (request.method === "POST" && pathname === "/jobs") {
      const body = (await request.json()) as Record<string, unknown>;
      return this.createJob(body);
    }

    if (
      request.method === "DELETE" &&
      pathname.startsWith("/jobs/") &&
      !pathname.includes("/jobs/reset")
    ) {
      const jobId = pathname.slice("/jobs/".length);
      if (!jobId.includes("/")) return this.deleteJob(jobId);
    }

    if (
      request.method === "PATCH" &&
      pathname.startsWith("/jobs/") &&
      !pathname.includes("/claim") &&
      !pathname.includes("/complete") &&
      !pathname.includes("/fail") &&
      !pathname.includes("/trigger") &&
      !pathname.includes("/reset") &&
      pathname !== "/jobs/pending"
    ) {
      const jobId = pathname.slice("/jobs/".length);
      const body = (await request.json()) as Record<string, unknown>;
      return this.patchJob(jobId, body);
    }

    if (
      request.method === "POST" &&
      pathname.startsWith("/jobs/") &&
      pathname.endsWith("/trigger")
    ) {
      const jobId = pathname.slice("/jobs/".length, -"/trigger".length);
      return this.triggerJob(jobId);
    }

    if (request.method === "POST" && pathname.startsWith("/jobs/") && pathname.endsWith("/claim")) {
      const jobId = pathname.slice("/jobs/".length, -"/claim".length);
      return this.claimJob(jobId);
    }

    if (
      request.method === "POST" &&
      pathname.startsWith("/jobs/") &&
      pathname.endsWith("/complete")
    ) {
      const jobId = pathname.slice("/jobs/".length, -"/complete".length);
      return this.completeJob(jobId);
    }

    if (request.method === "POST" && pathname.startsWith("/jobs/") && pathname.endsWith("/fail")) {
      const jobId = pathname.slice("/jobs/".length, -"/fail".length);
      const body = (await request.json()) as Record<string, unknown>;
      return this.failJob(jobId, typeof body.error === "string" ? body.error : "unknown error");
    }

    if (request.method === "POST" && pathname === "/jobs/reset-pending") {
      const body = (await request.json()) as Record<string, unknown>;
      return this.resetJobsPending(body);
    }

    if (request.method === "POST" && pathname === "/jobs/reset-orphaned") {
      const body = (await request.json()) as Record<string, unknown>;
      return this.resetOrphanedJobs(body);
    }

    // ── Trigger endpoints ─────────────────────────────────────────────────

    if (request.method === "GET" && pathname === "/triggers") {
      return this.listTriggers();
    }

    if (request.method === "POST" && pathname === "/triggers") {
      const body = (await request.json()) as Record<string, unknown>;
      return this.createTrigger(body);
    }

    if (request.method === "DELETE" && pathname.startsWith("/triggers/")) {
      const triggerId = pathname.slice("/triggers/".length);
      return this.deleteTrigger(triggerId);
    }

    return new Response("Not Found", { status: 404 });
  }

  private getTables(): Response {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT id, name, description, created_at FROM tables WHERE deleted_at IS NULL ORDER BY name",
      )
      .toArray();
    return Response.json({ tables: rows });
  }

  private getSnapshots(tableRef: string): Response {
    // Prefer an exact name match; fall back to id lookup so callers can use either.
    let tableRows = this.ctx.storage.sql
      .exec("SELECT id FROM tables WHERE name = ? AND deleted_at IS NULL", tableRef)
      .toArray();
    if (tableRows.length === 0) {
      tableRows = this.ctx.storage.sql
        .exec("SELECT id FROM tables WHERE id = ? AND deleted_at IS NULL", tableRef)
        .toArray();
    }
    const table = tableRows[0];
    if (!table) return new Response("Not Found", { status: 404 });

    const snapshots = this.ctx.storage.sql
      .exec(
        `SELECT id, table_id, uri, storage_backend, access_mode, format, created_at
         FROM snapshots WHERE table_id = ? ORDER BY created_at DESC`,
        table.id,
      )
      .toArray();
    return Response.json({ snapshots });
  }

  private commit(body: CommitBody): Response {
    const { table, uri, storageBackend, accessMode = "signed", format, message } = body;

    if (
      typeof table !== "string" ||
      typeof uri !== "string" ||
      typeof storageBackend !== "string"
    ) {
      return new Response("Bad Request: table, uri, storageBackend required", { status: 400 });
    }

    if (!SAFE_TABLE_NAME.test(table)) {
      return new Response("Bad Request: table name must match [a-zA-Z_][a-zA-Z0-9_]*", {
        status: 400,
      });
    }

    const now = Date.now();
    const snapshotId = genId("snap");
    const commitId = genId("commit");

    const { tableId, triggeredJobIds } = this.ctx.storage.transactionSync(() => {
      // Include soft-deleted rows so we can restore them on re-commit.
      const tableRows = this.ctx.storage.sql
        .exec("SELECT id, deleted_at FROM tables WHERE name = ?", table)
        .toArray();

      let resolvedId: string;
      if (tableRows.length > 0) {
        resolvedId = tableRows[0]!.id as string;
        if (tableRows[0]!.deleted_at !== null) {
          // Restore soft-deleted table on re-commit.
          this.ctx.storage.sql.exec("UPDATE tables SET deleted_at = NULL WHERE id = ?", resolvedId);
        }
      } else {
        resolvedId = genId("tbl");
        this.ctx.storage.sql.exec(
          "INSERT INTO tables (id, name, created_at) VALUES (?, ?, ?)",
          resolvedId,
          table,
          now,
        );
      }

      this.ctx.storage.sql.exec(
        "INSERT INTO snapshots (id, table_id, uri, storage_backend, access_mode, format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        snapshotId,
        resolvedId,
        uri,
        storageBackend,
        accessMode,
        typeof format === "string" ? format : null,
        now,
      );

      this.ctx.storage.sql.exec(
        "INSERT INTO commits (id, table_id, snapshot_id, committed_at, message) VALUES (?, ?, ?, ?, ?)",
        commitId,
        resolvedId,
        snapshotId,
        now,
        typeof message === "string" ? message : null,
      );

      // Check for transform job triggers watching this table.
      const fired: string[] = [];

      // 'any' policy: fire whenever any watched table commits.
      const anyRows = this.ctx.storage.sql
        .exec(
          `SELECT t.job_id FROM triggers t
           JOIN transform_jobs tj ON t.job_id = tj.id
           WHERE t.policy = 'any'
             AND EXISTS (SELECT 1 FROM json_each(t.watches) WHERE value = ?)
             AND tj.status IN ('idle', 'done', 'failed')`,
          table,
        )
        .toArray();
      for (const row of anyRows) {
        const result = this.ctx.storage.sql.exec(
          "UPDATE transform_jobs SET status = 'pending', updated_at = ? WHERE id = ? AND status IN ('idle', 'done', 'failed')",
          now,
          row.job_id,
        );
        if (result.rowsWritten > 0) fired.push(row.job_id as string);
      }

      // 'all' policy: fire only when ALL watched tables have snapshots newer than last completion.
      const allRows = this.ctx.storage.sql
        .exec(
          `SELECT t.job_id, t.watches, tj.last_completed_at FROM triggers t
           JOIN transform_jobs tj ON t.job_id = tj.id
           WHERE t.policy = 'all'
             AND EXISTS (SELECT 1 FROM json_each(t.watches) WHERE value = ?)
             AND tj.status IN ('idle', 'done', 'failed')`,
          table,
        )
        .toArray();
      for (const row of allRows) {
        const baseline = (row.last_completed_at as number | null) ?? 0;
        const missingRow = this.ctx.storage.sql
          .exec(
            `SELECT COUNT(*) as cnt FROM json_each(?)
             WHERE value NOT IN (
               SELECT tbl.name FROM snapshots s
               JOIN tables tbl ON s.table_id = tbl.id
               WHERE s.created_at > ?
             )`,
            row.watches,
            baseline,
          )
          .toArray()[0];
        if ((missingRow?.cnt as number) === 0) {
          const result = this.ctx.storage.sql.exec(
            "UPDATE transform_jobs SET status = 'pending', updated_at = ? WHERE id = ? AND status IN ('idle', 'done', 'failed')",
            now,
            row.job_id,
          );
          if (result.rowsWritten > 0) fired.push(row.job_id as string);
        }
      }

      return { tableId: resolvedId, triggeredJobIds: fired };
    });

    return Response.json({ tableId, snapshotId, commitId, triggeredJobIds }, { status: 201 });
  }

  private deleteTable(tableRef: string): Response {
    // Prefer name match; fall back to id.
    let tableRows = this.ctx.storage.sql
      .exec("SELECT id FROM tables WHERE name = ? AND deleted_at IS NULL", tableRef)
      .toArray();
    if (tableRows.length === 0) {
      tableRows = this.ctx.storage.sql
        .exec("SELECT id FROM tables WHERE id = ? AND deleted_at IS NULL", tableRef)
        .toArray();
    }
    if (tableRows.length === 0) return new Response("Not Found", { status: 404 });

    this.ctx.storage.sql.exec(
      "UPDATE tables SET deleted_at = ? WHERE id = ?",
      Date.now(),
      tableRows[0]!.id as string,
    );
    return new Response(null, { status: 204 });
  }

  private patchSnapshot(snapshotId: string, body: Record<string, unknown>): Response {
    const rows = this.ctx.storage.sql
      .exec("SELECT id FROM snapshots WHERE id = ?", snapshotId)
      .toArray();
    if (rows.length === 0) return new Response("Not Found", { status: 404 });

    if ("uri" in body) {
      if (typeof body.uri !== "string")
        return new Response("uri must be a string", { status: 400 });
      this.ctx.storage.sql.exec("UPDATE snapshots SET uri = ? WHERE id = ?", body.uri, snapshotId);
    }

    if ("format" in body) {
      const format =
        body.format === null ? null : typeof body.format === "string" ? body.format : undefined;
      if (format === undefined) {
        return new Response("format must be a string or null", { status: 400 });
      }
      this.ctx.storage.sql.exec("UPDATE snapshots SET format = ? WHERE id = ?", format, snapshotId);
    }

    return new Response(null, { status: 204 });
  }

  // ── Transform jobs ────────────────────────────────────────────────────────

  private listJobs(): Response {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT id, name, sql, output_table, output_uri, output_backend, format, status, requires_browser, created_at, updated_at, last_completed_at, error FROM transform_jobs ORDER BY created_at DESC",
      )
      .toArray();
    return Response.json({ jobs: rows });
  }

  private listPendingJobs(): Response {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT id, name, sql, output_table, output_uri, output_backend, format, status, requires_browser, created_at, updated_at, last_completed_at, error FROM transform_jobs WHERE status = 'pending' ORDER BY updated_at ASC",
      )
      .toArray();
    return Response.json({ jobs: rows });
  }

  private createJob(body: Record<string, unknown>): Response {
    if (typeof body.sql !== "string" || !body.sql) {
      return new Response("sql is required", { status: 400 });
    }
    if (typeof body.output_table !== "string" || !SAFE_TABLE_NAME.test(body.output_table)) {
      return new Response("output_table must match [a-zA-Z_][a-zA-Z0-9_]*", { status: 400 });
    }
    if (typeof body.output_uri !== "string" || !body.output_uri) {
      return new Response("output_uri is required", { status: 400 });
    }
    if (typeof body.output_backend !== "string" || !body.output_backend) {
      return new Response("output_backend is required", { status: 400 });
    }

    const now = Date.now();
    const id = genId("tj");
    this.ctx.storage.sql.exec(
      "INSERT INTO transform_jobs (id, name, sql, output_table, output_uri, output_backend, format, status, requires_browser, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', 1, ?, ?)",
      id,
      typeof body.name === "string" ? body.name : null,
      body.sql,
      body.output_table,
      body.output_uri,
      body.output_backend,
      typeof body.format === "string" ? body.format : null,
      now,
      now,
    );

    const row = this.ctx.storage.sql
      .exec("SELECT * FROM transform_jobs WHERE id = ?", id)
      .toArray()[0];
    return Response.json(row, { status: 201 });
  }

  private deleteJob(jobId: string): Response {
    const rows = this.ctx.storage.sql
      .exec("SELECT status FROM transform_jobs WHERE id = ?", jobId)
      .toArray();
    if (rows.length === 0) return new Response("Not Found", { status: 404 });
    if (rows[0]!.status === "running") {
      return new Response("Cannot delete a running job", { status: 409 });
    }
    this.ctx.storage.sql.exec("DELETE FROM triggers WHERE job_id = ?", jobId);
    this.ctx.storage.sql.exec("DELETE FROM transform_jobs WHERE id = ?", jobId);
    return new Response(null, { status: 204 });
  }

  private patchJob(jobId: string, body: Record<string, unknown>): Response {
    const rows = this.ctx.storage.sql
      .exec("SELECT status FROM transform_jobs WHERE id = ?", jobId)
      .toArray();
    if (rows.length === 0) return new Response("Not Found", { status: 404 });
    if (rows[0]!.status === "running") {
      return new Response("Cannot edit a running job", { status: 409 });
    }
    const setParts: string[] = [];
    const bindValues: unknown[] = [];
    if (typeof body.name === "string") {
      setParts.push("name = ?");
      bindValues.push(body.name || null);
    }
    if (typeof body.sql === "string" && body.sql) {
      setParts.push("sql = ?");
      bindValues.push(body.sql);
    }
    if (typeof body.output_table === "string" && SAFE_TABLE_NAME.test(body.output_table)) {
      setParts.push("output_table = ?");
      bindValues.push(body.output_table);
    }
    if (typeof body.output_uri === "string" && body.output_uri) {
      setParts.push("output_uri = ?");
      bindValues.push(body.output_uri);
    }
    if (typeof body.output_backend === "string" && body.output_backend) {
      setParts.push("output_backend = ?");
      bindValues.push(body.output_backend);
    }
    if ("format" in body) {
      setParts.push("format = ?");
      bindValues.push(typeof body.format === "string" ? body.format || null : null);
    }
    if (setParts.length === 0) return new Response("Nothing to update", { status: 400 });
    setParts.push("updated_at = ?");
    bindValues.push(Date.now(), jobId);
    this.ctx.storage.sql.exec(
      `UPDATE transform_jobs SET ${setParts.join(", ")} WHERE id = ?`,
      ...bindValues,
    );
    const row = this.ctx.storage.sql
      .exec("SELECT * FROM transform_jobs WHERE id = ?", jobId)
      .toArray()[0];
    return Response.json(row);
  }

  private triggerJob(jobId: string): Response {
    const rows = this.ctx.storage.sql
      .exec("SELECT status FROM transform_jobs WHERE id = ?", jobId)
      .toArray();
    if (rows.length === 0) return new Response("Not Found", { status: 404 });
    if (rows[0]!.status === "running") {
      return new Response("Job is currently running", { status: 409 });
    }
    this.ctx.storage.sql.exec(
      "UPDATE transform_jobs SET status = 'pending', updated_at = ? WHERE id = ?",
      Date.now(),
      jobId,
    );
    return new Response(null, { status: 204 });
  }

  private claimJob(jobId: string): Response {
    const rows = this.ctx.storage.sql
      .exec("SELECT status FROM transform_jobs WHERE id = ?", jobId)
      .toArray();
    if (rows.length === 0) return new Response("Not Found", { status: 404 });
    const result = this.ctx.storage.sql.exec(
      "UPDATE transform_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'",
      Date.now(),
      jobId,
    );
    if (result.rowsWritten === 0) return new Response("Conflict", { status: 409 });
    return new Response(null, { status: 204 });
  }

  private completeJob(jobId: string): Response {
    const rows = this.ctx.storage.sql
      .exec("SELECT status FROM transform_jobs WHERE id = ?", jobId)
      .toArray();
    if (rows.length === 0) return new Response("Not Found", { status: 404 });
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE transform_jobs SET status = 'done', updated_at = ?, last_completed_at = ?, error = NULL WHERE id = ?",
      now,
      now,
      jobId,
    );
    return new Response(null, { status: 204 });
  }

  private failJob(jobId: string, error: string): Response {
    const rows = this.ctx.storage.sql
      .exec("SELECT status FROM transform_jobs WHERE id = ?", jobId)
      .toArray();
    if (rows.length === 0) return new Response("Not Found", { status: 404 });
    this.ctx.storage.sql.exec(
      "UPDATE transform_jobs SET status = 'failed', updated_at = ?, error = ? WHERE id = ?",
      Date.now(),
      error,
      jobId,
    );
    return new Response(null, { status: 204 });
  }

  private resetOrphanedJobs(body: Record<string, unknown>): Response {
    const claimedJobIds = Array.isArray(body.claimedJobIds)
      ? (body.claimedJobIds as unknown[]).filter((id): id is string => typeof id === "string")
      : [];
    const now = Date.now();
    if (claimedJobIds.length === 0) {
      this.ctx.storage.sql.exec(
        "UPDATE transform_jobs SET status = 'pending', updated_at = ? WHERE status = 'running'",
        now,
      );
    } else {
      const placeholders = claimedJobIds.map(() => "?").join(", ");
      this.ctx.storage.sql.exec(
        `UPDATE transform_jobs SET status = 'pending', updated_at = ? WHERE status = 'running' AND id NOT IN (${placeholders})`,
        now,
        ...claimedJobIds,
      );
    }
    return new Response(null, { status: 204 });
  }

  private resetJobsPending(body: Record<string, unknown>): Response {
    const jobIds = body.jobIds;
    if (!Array.isArray(jobIds) || jobIds.length === 0) {
      return new Response("jobIds must be a non-empty array", { status: 400 });
    }
    const now = Date.now();
    for (const id of jobIds) {
      if (typeof id !== "string") continue;
      this.ctx.storage.sql.exec(
        "UPDATE transform_jobs SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'running'",
        now,
        id,
      );
    }
    return new Response(null, { status: 204 });
  }

  // ── Triggers ──────────────────────────────────────────────────────────────

  private listTriggers(): Response {
    const rows = this.ctx.storage.sql
      .exec("SELECT id, watches, policy, job_id, created_at FROM triggers ORDER BY created_at DESC")
      .toArray();
    const triggers = rows.map((r) => ({
      ...r,
      watches: parseWatches(r.watches as string),
    }));
    return Response.json({ triggers });
  }

  private createTrigger(body: Record<string, unknown>): Response {
    // watches accepts a single table name string or an array of table names.
    const rawWatches = Array.isArray(body.watches)
      ? body.watches
      : typeof body.watches === "string"
        ? [body.watches]
        : null;
    if (!rawWatches || rawWatches.length === 0) {
      return new Response("watches must be a table name or array of table names", { status: 400 });
    }
    for (const w of rawWatches) {
      if (typeof w !== "string" || !SAFE_TABLE_NAME.test(w)) {
        return new Response(`watches contains invalid table name: ${w}`, { status: 400 });
      }
    }
    const watchesJson = JSON.stringify(rawWatches);

    const policy = body.policy ?? "any";
    if (policy !== "any" && policy !== "all") {
      return new Response("policy must be 'any' or 'all'", { status: 400 });
    }

    if (typeof body.job_id !== "string" || !body.job_id) {
      return new Response("job_id is required", { status: 400 });
    }

    const jobRows = this.ctx.storage.sql
      .exec("SELECT id FROM transform_jobs WHERE id = ?", body.job_id)
      .toArray();
    if (jobRows.length === 0) return new Response("Transform job not found", { status: 404 });

    const id = genId("trg");
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO triggers (id, watches, policy, job_id, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      watchesJson,
      policy,
      body.job_id,
      now,
    );

    const row = this.ctx.storage.sql
      .exec("SELECT id, watches, policy, job_id, created_at FROM triggers WHERE id = ?", id)
      .toArray()[0];
    return Response.json(
      { ...row, watches: parseWatches(row!.watches as string) },
      { status: 201 },
    );
  }

  private deleteTrigger(triggerId: string): Response {
    const rows = this.ctx.storage.sql
      .exec("SELECT id FROM triggers WHERE id = ?", triggerId)
      .toArray();
    if (rows.length === 0) return new Response("Not Found", { status: 404 });
    this.ctx.storage.sql.exec("DELETE FROM triggers WHERE id = ?", triggerId);
    return new Response(null, { status: 204 });
  }
}
