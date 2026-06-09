export interface SavedQueryRow {
  id: string;
  user_id: string;
  name: string;
  sql: string;
  created_at: number;
}

export async function listSavedQueries(db: D1Database, userId: string): Promise<SavedQueryRow[]> {
  const result = await db
    .prepare(
      "SELECT id, user_id, name, sql, created_at FROM saved_queries WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<SavedQueryRow>();
  return result.results;
}

export async function insertSavedQuery(
  db: D1Database,
  opts: { userId: string; name: string; sql: string },
): Promise<SavedQueryRow> {
  const id = `sq_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO saved_queries (id, user_id, name, sql, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, opts.userId, opts.name, opts.sql, now)
    .run();
  return { id, user_id: opts.userId, name: opts.name, sql: opts.sql, created_at: now };
}

export async function deleteSavedQuery(
  db: D1Database,
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM saved_queries WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
