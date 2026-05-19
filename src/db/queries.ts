import type { User } from "../types.ts";

export async function getUser(db: D1Database, id: string): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email.toLowerCase()).first<User>();
}

export async function updateUserEmail(
  db: D1Database,
  userId: string,
  email: string,
): Promise<void> {
  await db
    .prepare("UPDATE users SET email = ? WHERE id = ? AND email IS NULL")
    .bind(email.toLowerCase(), userId)
    .run();
}

export interface OAuthIdentityRow {
  provider: string;
  provider_id: string;
  user_id: string;
  created_at: number;
}

export async function getIdentity(
  db: D1Database,
  provider: string,
  providerId: string,
): Promise<OAuthIdentityRow | null> {
  return db
    .prepare("SELECT * FROM oauth_identities WHERE provider = ? AND provider_id = ?")
    .bind(provider, providerId)
    .first<OAuthIdentityRow>();
}

export async function linkIdentity(
  db: D1Database,
  provider: string,
  providerId: string,
  userId: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO oauth_identities (provider, provider_id, user_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(provider, providerId, userId, Date.now())
    .run();
}

export async function createUserWithIdentity(
  db: D1Database,
  provider: string,
  providerId: string,
  email: string | null,
): Promise<string> {
  const userId = crypto.randomUUID();
  const now = Date.now();
  const normalizedEmail = email ? email.toLowerCase() : null;
  await db.batch([
    db
      .prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .bind(userId, normalizedEmail, now),
    db
      .prepare(
        "INSERT INTO oauth_identities (provider, provider_id, user_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(provider, providerId, userId, now),
  ]);
  return userId;
}
