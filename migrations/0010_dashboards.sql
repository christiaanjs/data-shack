CREATE TABLE dashboards (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  artifact_source TEXT NOT NULL,
  queries         TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_dashboards_user_created ON dashboards (user_id, created_at DESC);
