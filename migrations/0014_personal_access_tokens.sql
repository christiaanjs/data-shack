CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pat_token_hash ON personal_access_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_pat_user_id ON personal_access_tokens(user_id);
