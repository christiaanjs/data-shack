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
  },
): Promise<LoadJob> {
  const id = `lj_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = Date.now();
  const cronSchedule = data.cron_schedule ?? "0 * * * *";
  const httpPath = data.http_path ?? "/";
  const httpMethod = data.http_method ?? "GET";
  const format = data.format ?? "ndjson";
  const tablePath = data.table_path ?? "";
  const nextRunAt = new Cron(cronSchedule).nextRun()?.getTime() ?? null;

  await db
    .prepare(
      `INSERT INTO load_jobs
        (id, user_id, name, credential_id, storage_backend_id, table_name, table_path,
         http_path, http_method, format, cron_schedule, next_run_at,
         last_run_at, last_error, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
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
  };
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
