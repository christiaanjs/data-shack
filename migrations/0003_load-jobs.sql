CREATE TABLE load_jobs (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  name                TEXT NOT NULL,
  credential_id       TEXT NOT NULL,
  storage_backend_id  TEXT NOT NULL,
  table_name          TEXT NOT NULL,
  http_path           TEXT NOT NULL DEFAULT '/',
  http_method         TEXT NOT NULL DEFAULT 'GET',
  format              TEXT NOT NULL DEFAULT 'ndjson',
  cron_schedule       TEXT NOT NULL DEFAULT '0 * * * *',
  next_run_at         INTEGER,
  last_run_at         INTEGER,
  last_error          TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX idx_load_jobs_user ON load_jobs(user_id);
CREATE INDEX idx_load_jobs_due  ON load_jobs(enabled, next_run_at);
