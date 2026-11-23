import { hashToken } from "../auth/jwt.ts";

export const API_TOKEN_PREFIX = "dsk_";

export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
}

function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${API_TOKEN_PREFIX}${hex}`;
}

/** Creates a token. The plaintext secret is returned once and never stored. */
export async function insertApiToken(
  db: D1Database,
  opts: { userId: string; name: string; expiresAt: number | null },
): Promise<{ token: string; row: ApiTokenRow }> {
  const id = `tok_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const token = generateSecret();
  const now = Date.now();
  const row: ApiTokenRow = {
    id,
    user_id: opts.userId,
    name: opts.name,
    token_prefix: token.slice(0, API_TOKEN_PREFIX.length + 6),
    created_at: now,
    expires_at: opts.expiresAt,
    last_used_at: null,
  };
  await db
    .prepare(
      "INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, row.user_id, row.name, await hashToken(token), row.token_prefix, now, row.expires_at)
    .run();
  return { token, row };
}

export async function listApiTokens(db: D1Database, userId: string): Promise<ApiTokenRow[]> {
  const result = await db
    .prepare(
      "SELECT id, user_id, name, token_prefix, created_at, expires_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<ApiTokenRow>();
  return result.results;
}

export async function deleteApiToken(db: D1Database, id: string, userId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Used by SessionDO to check whether its self-provisioned container token (stored in its own
 * durable storage, not D1) has since been revoked via the normal Settings UI, so it knows to
 * mint a fresh one rather than handing a dead token to a container that will just fail to connect. */
export async function apiTokenExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM api_tokens WHERE id = ?").bind(id).first();
  return row !== null;
}

/** Returns the owning userId if the token is valid and unexpired, else null. */
export async function verifyApiToken(db: D1Database, token: string): Promise<string | null> {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  const row = await db
    .prepare("SELECT id, user_id, expires_at, last_used_at FROM api_tokens WHERE token_hash = ?")
    .bind(await hashToken(token))
    .first<{
      id: string;
      user_id: string;
      expires_at: number | null;
      last_used_at: number | null;
    }>();
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at !== null && row.expires_at <= now) return null;
  // Throttle last_used_at writes to at most once a minute.
  if (row.last_used_at === null || now - row.last_used_at > 60_000) {
    await db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
  }
  return row.user_id;
}
