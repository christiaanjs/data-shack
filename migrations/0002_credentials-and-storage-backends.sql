-- Migration number: 0002
-- All expires_at/created_at/updated_at columns use Unix milliseconds (Date.now())

CREATE TABLE credentials (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,
  encrypted_config TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX idx_credentials_user ON credentials(user_id);

CREATE TABLE storage_backends (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,
  encrypted_config TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX idx_storage_backends_user ON storage_backends(user_id);
