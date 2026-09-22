export interface PersonalAccessTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

export type PersonalAccessTokenSummary = Omit<PersonalAccessTokenRow, "token_hash" | "user_id">;

export async function listPersonalAccessTokens(
  db: D1Database,
  userId: string,
): Promise<PersonalAccessTokenSummary[]> {
  const result = await db
    .prepare(
      "SELECT id, name, created_at, last_used_at, expires_at FROM personal_access_tokens WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<PersonalAccessTokenSummary>();
  return result.results;
}

export async function insertPersonalAccessToken(
  db: D1Database,
  opts: { userId: string; name: string; tokenHash: string; expiresAt: number | null },
): Promise<{ id: string; created_at: number }> {
  const id = `pat_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO personal_access_tokens (id, user_id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id, opts.userId, opts.name, opts.tokenHash, now, opts.expiresAt)
    .run();
  return { id, created_at: now };
}

interface TokenAuthRow {
  id: string;
  user_id: string;
  expires_at: number | null;
  last_used_at: number | null;
}

export async function getPersonalAccessTokenByHash(
  db: D1Database,
  tokenHash: string,
): Promise<TokenAuthRow | null> {
  return db
    .prepare(
      "SELECT id, user_id, expires_at, last_used_at FROM personal_access_tokens WHERE token_hash = ?",
    )
    .bind(tokenHash)
    .first<TokenAuthRow>();
}

export async function touchPersonalAccessToken(
  db: D1Database,
  id: string,
  now: number,
): Promise<void> {
  await db
    .prepare("UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
}

export async function deletePersonalAccessToken(
  db: D1Database,
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM personal_access_tokens WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
