ALTER TABLE dashboards ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX idx_dashboards_user_slug ON dashboards (user_id, slug) WHERE slug IS NOT NULL;

CREATE TABLE dashboard_snapshots (
  id              TEXT PRIMARY KEY,
  dashboard_id    TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  artifact_source TEXT NOT NULL,
  queries         TEXT NOT NULL,
  snapshot_reason TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_dashboard_snapshots_did ON dashboard_snapshots (dashboard_id, created_at DESC);
