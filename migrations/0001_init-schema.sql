-- Migration number: 0001
-- All expires_at columns use Unix milliseconds (Date.now())

-- Users (no household — each user is their own tenant)
CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;

-- Provider-to-user identity mapping
CREATE TABLE oauth_identities (
  provider    TEXT NOT NULL,  -- 'google', etc.
  provider_id TEXT NOT NULL,  -- provider's user ID (string)
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_id)
);

CREATE INDEX idx_oauth_identities_user ON oauth_identities(user_id);

-- Pending OAuth states (created at /authorize, consumed at /oauth/callback)
CREATE TABLE oauth_states (
  state                  TEXT PRIMARY KEY,
  client_id              TEXT NOT NULL,
  provider               TEXT NOT NULL,
  code_challenge         TEXT NOT NULL,
  code_challenge_method  TEXT NOT NULL,
  redirect_uri           TEXT NOT NULL,
  original_state         TEXT,
  expires_at             INTEGER NOT NULL -- Unix milliseconds
);

-- DCR-registered OAuth clients (public clients; no client_secret)
CREATE TABLE oauth_clients (
  client_id    TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL, -- JSON array
  created_at   INTEGER NOT NULL
);

-- Short-lived MCP authorization codes (consumed once at /token)
CREATE TABLE oauth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  expires_at            INTEGER NOT NULL, -- Unix milliseconds
  used                  INTEGER NOT NULL DEFAULT 0
);

-- Refresh tokens (stored as SHA-256 hashes, rotated on each use)
CREATE TABLE oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL, -- Unix milliseconds
  revoked    INTEGER NOT NULL DEFAULT 0
);
