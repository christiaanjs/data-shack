export interface CredentialRow {
  id: string;
  name: string;
  type: string;
  created_at: number;
}

export interface StorageBackendRow {
  id: string;
  name: string;
  type: string;
  created_at: number;
}

export async function listCredentials(db: D1Database, userId: string): Promise<CredentialRow[]> {
  const result = await db
    .prepare(
      "SELECT id, name, type, created_at FROM credentials WHERE user_id = ? ORDER BY created_at ASC",
    )
    .bind(userId)
    .all<CredentialRow>();
  return result.results;
}

export async function insertCredential(
  db: D1Database,
  opts: { userId: string; name: string; type: string; encryptedConfig: string },
): Promise<{ id: string }> {
  const id = `cred_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO credentials (id, user_id, name, type, encrypted_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, opts.userId, opts.name, opts.type, opts.encryptedConfig, now, now)
    .run();
  return { id };
}

export async function deleteCredential(
  db: D1Database,
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM credentials WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listStorageBackends(
  db: D1Database,
  userId: string,
): Promise<StorageBackendRow[]> {
  const result = await db
    .prepare(
      "SELECT id, name, type, created_at FROM storage_backends WHERE user_id = ? ORDER BY created_at ASC",
    )
    .bind(userId)
    .all<StorageBackendRow>();
  return result.results;
}

export async function insertStorageBackend(
  db: D1Database,
  opts: { userId: string; name: string; type: string; encryptedConfig: string },
): Promise<{ id: string }> {
  const id = `sb_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO storage_backends (id, user_id, name, type, encrypted_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, opts.userId, opts.name, opts.type, opts.encryptedConfig, now, now)
    .run();
  return { id };
}

interface CredentialConfigRow {
  type: string;
  encrypted_config: string;
}

export async function getCredentialConfig(
  db: D1Database,
  id: string,
  userId: string,
): Promise<CredentialConfigRow | null> {
  const result = await db
    .prepare("SELECT type, encrypted_config FROM credentials WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<CredentialConfigRow>();
  return result ?? null;
}

export async function deleteStorageBackend(
  db: D1Database,
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM storage_backends WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

interface StorageBackendConfigRow {
  id: string;
  name: string;
  type: string;
  encrypted_config: string;
}

export async function getStorageBackendConfig(
  db: D1Database,
  id: string,
  userId: string,
): Promise<StorageBackendConfigRow | null> {
  const result = await db
    .prepare(
      "SELECT id, name, type, encrypted_config FROM storage_backends WHERE id = ? AND user_id = ?",
    )
    .bind(id, userId)
    .first<StorageBackendConfigRow>();
  return result ?? null;
}

// Resolves a storage backend by name first, falling back to ID.
// Returns the full row including id and name so callers can use either for subsequent lookups.
export async function getStorageBackendByNameOrId(
  db: D1Database,
  nameOrId: string,
  userId: string,
): Promise<StorageBackendConfigRow | null> {
  const byName = await db
    .prepare(
      "SELECT id, name, type, encrypted_config FROM storage_backends WHERE user_id = ? AND name = ?",
    )
    .bind(userId, nameOrId)
    .first<StorageBackendConfigRow>();
  if (byName) return byName;
  return (
    (await db
      .prepare(
        "SELECT id, name, type, encrypted_config FROM storage_backends WHERE user_id = ? AND id = ?",
      )
      .bind(userId, nameOrId)
      .first<StorageBackendConfigRow>()) ?? null
  );
}
