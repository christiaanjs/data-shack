export interface DashboardListRow {
  id: string;
  title: string;
  slug: string | null;
  created_at: number;
}

export interface DashboardRow extends DashboardListRow {
  user_id: string;
  artifact_source: string;
  queries: string; // raw JSON string — caller does JSON.parse
  updated_at: number;
}

export interface DashboardSnapshotRow {
  id: string;
  dashboard_id: string;
  user_id: string;
  title: string;
  artifact_source: string;
  queries: string; // raw JSON
  snapshot_reason: string;
  created_at: number;
}

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return s || "dashboard";
}

export async function resolveUniqueSlug(
  db: D1Database,
  userId: string,
  base: string,
  excludeId?: string,
): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 77)}-${i + 1}`;
    const row = await db
      .prepare(
        `SELECT id FROM dashboards WHERE user_id = ? AND slug = ?${excludeId ? " AND id != ?" : ""}`,
      )
      .bind(...(excludeId ? [userId, candidate, excludeId] : [userId, candidate]))
      .first<{ id: string }>();
    if (!row) return candidate;
  }
  // Fallback: suffix with a short random token
  return `${base.slice(0, 72)}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function insertDashboard(
  db: D1Database,
  opts: { userId: string; title: string; artifactSource: string; queries: string[]; slug?: string },
): Promise<{ id: string; slug: string | null }> {
  const id = `dash_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = Date.now();
  const slug = opts.slug ?? null;
  await db
    .prepare(
      "INSERT INTO dashboards (id, user_id, title, artifact_source, queries, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      opts.userId,
      opts.title,
      opts.artifactSource,
      JSON.stringify(opts.queries),
      slug,
      now,
      now,
    )
    .run();
  return { id, slug };
}

export async function getDashboard(
  db: D1Database,
  id: string,
  userId: string,
): Promise<DashboardRow | null> {
  return (
    (await db
      .prepare(
        "SELECT id, user_id, title, slug, artifact_source, queries, created_at, updated_at FROM dashboards WHERE id = ? AND user_id = ?",
      )
      .bind(id, userId)
      .first<DashboardRow>()) ?? null
  );
}

export async function getDashboardByIdOrSlug(
  db: D1Database,
  idOrSlug: string,
  userId: string,
): Promise<DashboardRow | null> {
  if (idOrSlug.startsWith("dash_")) {
    return getDashboard(db, idOrSlug, userId);
  }
  return (
    (await db
      .prepare(
        "SELECT id, user_id, title, slug, artifact_source, queries, created_at, updated_at FROM dashboards WHERE slug = ? AND user_id = ?",
      )
      .bind(idOrSlug, userId)
      .first<DashboardRow>()) ?? null
  );
}

export async function listDashboards(db: D1Database, userId: string): Promise<DashboardListRow[]> {
  const result = await db
    .prepare(
      "SELECT id, title, slug, created_at FROM dashboards WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<DashboardListRow>();
  return result.results;
}

export async function updateDashboard(
  db: D1Database,
  id: string,
  userId: string,
  updates: {
    title?: string;
    artifactSource?: string;
    queries?: string[];
    slug?: string | null;
  },
): Promise<boolean> {
  const parts: string[] = [];
  const vals: unknown[] = [];

  if (updates.title !== undefined) {
    parts.push("title = ?");
    vals.push(updates.title);
  }
  if (updates.artifactSource !== undefined) {
    parts.push("artifact_source = ?");
    vals.push(updates.artifactSource);
  }
  if (updates.queries !== undefined) {
    parts.push("queries = ?");
    vals.push(JSON.stringify(updates.queries));
  }
  if (updates.slug !== undefined) {
    parts.push("slug = ?");
    vals.push(updates.slug);
  }
  if (parts.length === 0) return false;

  parts.push("updated_at = ?");
  vals.push(Date.now(), id, userId);

  const { meta } = await db
    .prepare(`UPDATE dashboards SET ${parts.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...vals)
    .run();
  return (meta.changes ?? 0) > 0;
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

export async function snapshotDashboard(
  db: D1Database,
  row: DashboardRow,
  userId: string,
  reason: string,
): Promise<void> {
  const snapId = `dsnap_${crypto.randomUUID().replace(/-/g, "")}`;
  await db
    .prepare(
      "INSERT INTO dashboard_snapshots (id, dashboard_id, user_id, title, artifact_source, queries, snapshot_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(snapId, row.id, userId, row.title, row.artifact_source, row.queries, reason, Date.now())
    .run();
}

export async function listDashboardSnapshots(
  db: D1Database,
  dashboardId: string,
  userId: string,
): Promise<DashboardSnapshotRow[]> {
  const { results } = await db
    .prepare(
      "SELECT id, dashboard_id, user_id, title, artifact_source, queries, snapshot_reason, created_at FROM dashboard_snapshots WHERE dashboard_id = ? AND user_id = ? ORDER BY created_at DESC",
    )
    .bind(dashboardId, userId)
    .all<DashboardSnapshotRow>();
  return results;
}
