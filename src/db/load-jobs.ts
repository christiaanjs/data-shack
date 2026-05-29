import { Cron } from "croner";

export interface LoadJob {
  id: string;
  user_id: string;
  name: string;
  credential_id: string;
  storage_backend_id: string;
  table_name: string;
  table_path: string;
  http_path: string;
  http_method: string;
  format: string;
  cron_schedule: string;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
  date_range_config: string | null;
  pagination_config: string | null;
  source_type: string;
  source_config: string | null;
  http_request_body: string | null;
}

export async function listLoadJobs(db: D1Database, userId: string): Promise<LoadJob[]> {
  const result = await db
    .prepare("SELECT * FROM load_jobs WHERE user_id = ? ORDER BY created_at ASC")
    .bind(userId)
    .all<LoadJob>();
  return result.results;
}

export async function listDueLoadJobs(db: D1Database, now: number): Promise<LoadJob[]> {
  const result = await db
    .prepare(
      "SELECT * FROM load_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
    )
    .bind(now)
    .all<LoadJob>();
  return result.results;
}

export async function getLoadJob(
  db: D1Database,
  userId: string,
  id: string,
): Promise<LoadJob | null> {
  const result = await db
    .prepare("SELECT * FROM load_jobs WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<LoadJob>();
  return result ?? null;
}

export async function getLoadJobById(db: D1Database, id: string): Promise<LoadJob | null> {
  const result = await db.prepare("SELECT * FROM load_jobs WHERE id = ?").bind(id).first<LoadJob>();
  return result ?? null;
}

export async function insertLoadJob(
  db: D1Database,
  userId: string,
  data: {
    name: string;
    credential_id: string;
    storage_backend_id: string;
    table_name: string;
    table_path?: string;
    http_path?: string;
    http_method?: string;
    format?: string;
    cron_schedule?: string;
    date_range_config?: string | null;
    pagination_config?: string | null;
    source_type?: string;
    source_config?: string | null;
    http_request_body?: string | null;
  },
): Promise<LoadJob> {
  const id = `lj_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = Date.now();
  const cronSchedule = data.cron_schedule ?? "0 * * * *";
  const httpPath = data.http_path ?? "/";
  const httpMethod = data.http_method ?? "GET";
  const format = data.format ?? "ndjson";
  const tablePath = data.table_path ?? "";
  const dateRangeConfig = data.date_range_config ?? null;
  const paginationConfig = data.pagination_config ?? null;
  const sourceType = data.source_type ?? "http";
  const sourceConfig = data.source_config ?? null;
  const httpRequestBody = data.http_request_body ?? null;
  let cron: Cron;
  try {
    cron = new Cron(cronSchedule);
  } catch {
    throw new Error(`Invalid cron_schedule: ${cronSchedule}`);
  }
  const nextRunAt = cron.nextRun()?.getTime() ?? null;

  await db
    .prepare(
      `INSERT INTO load_jobs
        (id, user_id, name, credential_id, storage_backend_id, table_name, table_path,
         http_path, http_method, format, cron_schedule, next_run_at,
         last_run_at, last_error, enabled, created_at, updated_at,
         date_range_config, pagination_config, source_type, source_config, http_request_body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      userId,
      data.name,
      data.credential_id,
      data.storage_backend_id,
      data.table_name,
      tablePath,
      httpPath,
      httpMethod,
      format,
      cronSchedule,
      nextRunAt,
      now,
      now,
      dateRangeConfig,
      paginationConfig,
      sourceType,
      sourceConfig,
      httpRequestBody,
    )
    .run();

  return {
    id,
    user_id: userId,
    name: data.name,
    credential_id: data.credential_id,
    storage_backend_id: data.storage_backend_id,
    table_name: data.table_name,
    table_path: tablePath,
    http_path: httpPath,
    http_method: httpMethod,
    format,
    cron_schedule: cronSchedule,
    next_run_at: nextRunAt,
    last_run_at: null,
    last_error: null,
    enabled: 1,
    created_at: now,
    updated_at: now,
    date_range_config: dateRangeConfig,
    pagination_config: paginationConfig,
    source_type: sourceType,
    source_config: sourceConfig,
    http_request_body: httpRequestBody,
  };
}

export async function updateLoadJob(
  db: D1Database,
  userId: string,
  id: string,
  data: {
    name: string;
    credential_id: string;
    storage_backend_id: string;
    table_name: string;
    table_path: string;
    http_path: string;
    http_method: string;
    format: string;
    cron_schedule: string;
    date_range_config: string | null;
    pagination_config: string | null;
    source_type?: string;
    source_config?: string | null;
    http_request_body?: string | null;
  },
): Promise<LoadJob | null> {
  const now = Date.now();
  let cron: Cron;
  try {
    cron = new Cron(data.cron_schedule);
  } catch {
    throw new Error(`Invalid cron_schedule: ${data.cron_schedule}`);
  }
  const nextRunAt = cron.nextRun()?.getTime() ?? null;
  const result = await db
    .prepare(
      `UPDATE load_jobs
          SET name = ?, credential_id = ?, storage_backend_id = ?, table_name = ?,
              table_path = ?, http_path = ?, http_method = ?, format = ?,
              cron_schedule = ?, next_run_at = ?, updated_at = ?,
              date_range_config = ?, pagination_config = ?,
              source_type = ?, source_config = ?, http_request_body = ?
        WHERE id = ? AND user_id = ?`,
    )
    .bind(
      data.name,
      data.credential_id,
      data.storage_backend_id,
      data.table_name,
      data.table_path,
      data.http_path,
      data.http_method,
      data.format,
      data.cron_schedule,
      nextRunAt,
      now,
      data.date_range_config,
      data.pagination_config,
      data.source_type ?? "http",
      data.source_config ?? null,
      data.http_request_body ?? null,
      id,
      userId,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) return null;
  return db.prepare("SELECT * FROM load_jobs WHERE id = ?").bind(id).first<LoadJob>() ?? null;
}

export async function deleteLoadJob(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM load_jobs WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function advanceNextRunAt(
  db: D1Database,
  id: string,
  nextRunAt: number | null,
  updatedAt: number,
): Promise<void> {
  await db
    .prepare("UPDATE load_jobs SET next_run_at = ?, updated_at = ? WHERE id = ?")
    .bind(nextRunAt, updatedAt, id)
    .run();
}

export async function updateLoadJobOutcome(
  db: D1Database,
  id: string,
  lastRunAt: number,
  nextRunAt: number | null,
  lastError?: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE load_jobs SET last_run_at = ?, next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
    )
    .bind(lastRunAt, nextRunAt, lastError ?? null, lastRunAt, id)
    .run();
}
