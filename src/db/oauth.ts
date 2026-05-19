export interface OAuthClientRow {
  client_id: string;
  redirect_uris: string; // JSON-encoded string[]
  created_at: number;
}

export interface OAuthStateRow {
  state: string;
  client_id: string;
  provider: string;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  original_state: string | null;
  expires_at: number; // Unix milliseconds
}

export interface OAuthCodeRow {
  code: string;
  client_id: string;
  user_id: string;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  expires_at: number; // Unix milliseconds
  used: number;
}

export interface OAuthRefreshTokenRow {
  token_hash: string;
  user_id: string;
  client_id: string;
  expires_at: number; // Unix milliseconds
  revoked: number;
}

export async function getOAuthClient(
  db: D1Database,
  clientId: string,
): Promise<OAuthClientRow | null> {
  return db
    .prepare("SELECT client_id, redirect_uris, created_at FROM oauth_clients WHERE client_id = ?")
    .bind(clientId)
    .first<OAuthClientRow>();
}

export async function insertOAuthClient(
  db: D1Database,
  clientId: string,
  redirectUris: string[],
  createdAt: number,
): Promise<void> {
  await db
    .prepare("INSERT INTO oauth_clients (client_id, redirect_uris, created_at) VALUES (?, ?, ?)")
    .bind(clientId, JSON.stringify(redirectUris), createdAt)
    .run();
}

export async function insertOAuthState(db: D1Database, row: OAuthStateRow): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_states (state, client_id, provider, code_challenge, code_challenge_method, redirect_uri, original_state, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      row.state,
      row.client_id,
      row.provider,
      row.code_challenge,
      row.code_challenge_method,
      row.redirect_uri,
      row.original_state,
      row.expires_at,
    )
    .run();
}

export async function getAndDeleteOAuthState(
  db: D1Database,
  state: string,
): Promise<OAuthStateRow | null> {
  const row = await db
    .prepare("SELECT * FROM oauth_states WHERE state = ?")
    .bind(state)
    .first<OAuthStateRow>();
  if (row) {
    await db.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();
  }
  return row ?? null;
}

export async function insertOAuthCode(db: D1Database, row: OAuthCodeRow): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_codes (code, client_id, user_id, code_challenge, code_challenge_method, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      row.code,
      row.client_id,
      row.user_id,
      row.code_challenge,
      row.code_challenge_method,
      row.redirect_uri,
      row.expires_at,
    )
    .run();
}

export async function claimOAuthCode(
  db: D1Database,
  code: string,
  now: number,
): Promise<OAuthCodeRow | null> {
  return db
    .prepare(
      "UPDATE oauth_codes SET used = 1 WHERE code = ? AND used = 0 AND expires_at > ? RETURNING *",
    )
    .bind(code, now)
    .first<OAuthCodeRow>();
}

export async function insertRefreshToken(db: D1Database, row: OAuthRefreshTokenRow): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_refresh_tokens (token_hash, user_id, client_id, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(row.token_hash, row.user_id, row.client_id, row.expires_at)
    .run();
}

export async function claimRefreshToken(
  db: D1Database,
  tokenHash: string,
  now: number,
): Promise<OAuthRefreshTokenRow | null> {
  return db
    .prepare(
      "UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ? AND revoked = 0 AND expires_at > ? RETURNING *",
    )
    .bind(tokenHash, now)
    .first<OAuthRefreshTokenRow>();
}
