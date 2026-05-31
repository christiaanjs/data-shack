CREATE TABLE IF NOT EXISTS saved_queries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sql TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
