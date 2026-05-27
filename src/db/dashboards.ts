export interface DashboardListRow {
  id: string;
  title: string;
  created_at: number;
}

export interface DashboardRow {
  id: string;
  user_id: string;
  title: string;
  artifact_source: string;
  queries: string; // raw JSON string — caller does JSON.parse
  created_at: number;
  updated_at: number;
}

export async function insertDashboard(
  db: D1Database,
  opts: { userId: string; title: string; artifactSource: string; queries: string[] },
): Promise<{ id: string }> {
  const id = `dash_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO dashboards (id, user_id, title, artifact_source, queries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, opts.userId, opts.title, opts.artifactSource, JSON.stringify(opts.queries), now, now)
    .run();
  return { id };
}

export async function getDashboard(
  db: D1Database,
  id: string,
  userId: string,
): Promise<DashboardRow | null> {
  return (
    (await db
      .prepare(
        "SELECT id, user_id, title, artifact_source, queries, created_at, updated_at FROM dashboards WHERE id = ? AND user_id = ?",
      )
      .bind(id, userId)
      .first<DashboardRow>()) ?? null
  );
}

export async function listDashboards(db: D1Database, userId: string): Promise<DashboardListRow[]> {
  const result = await db
    .prepare(
      "SELECT id, title, created_at FROM dashboards WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<DashboardListRow>();
  return result.results;
}

export async function deleteDashboard(
  db: D1Database,
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM dashboards WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
