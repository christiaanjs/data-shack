interface ProxyCred {
  accessKeyId: string;
  secret: string;
  endpoint: string;
  region: string;
  bucket: string;
  expiresAt: number;
}

// Session-scoped cache keyed by "backendId:pathPrefix"
const credCache = new Map<string, ProxyCred>();

export async function acquireProxyCred(
  backendId: string,
  pathPrefix: string,
  workerOrigin: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
  ttlSeconds = 3600,
): Promise<ProxyCred> {
  const cacheKey = `${backendId}:${pathPrefix}`;
  const cached = credCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached;

  const headers = await getAuthHeaders();
  const res = await fetch(`${workerOrigin}/api/storage/proxy-credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ backendId, pathPrefix, ttlSeconds }),
  });
  if (!res.ok) throw new Error(`Failed to acquire proxy credential: ${res.status}`);
  const data = (await res.json()) as {
    accessKeyId: string;
    secret: string;
    endpoint: string;
    region: string;
    bucket: string;
  };

  const cred: ProxyCred = { ...data, expiresAt: Date.now() + (ttlSeconds - 60) * 1000 };
  credCache.set(cacheKey, cred);
  return cred;
}

// Returns a DuckDB CREATE OR REPLACE SECRET statement for the given credential.
// The secret name uses the backendId (sanitised) so multiple backends can coexist.
export function buildS3Secret(cred: ProxyCred): string {
  const secretName = `_ds_${cred.bucket.replace(/[^a-zA-Z0-9]/g, "_")}`;
  return (
    `CREATE OR REPLACE SECRET ${secretName} ` +
    `(TYPE s3, ENDPOINT '${cred.endpoint}', ` +
    `KEY_ID '${cred.accessKeyId}', SECRET '${cred.secret}', ` +
    `REGION '${cred.region}', URL_STYLE 'path', ` +
    `SCOPE 's3://${cred.bucket}/')`
  );
}

// Parses an r2:// or r2-s3compat:// URI into { backendId, key }.
// r2://bucket/key  → backendId = "r2-bound", key = key (bucket portion is ignored)
// r2-s3compat://backendId/key → backendId, key
export function parseStorageUri(uri: string): { backendId: string; key: string } | null {
  if (uri.startsWith("r2://")) {
    const rest = uri.slice("r2://".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    return { backendId: "r2-bound", key: rest.slice(slash + 1) };
  }
  if (uri.startsWith("r2-s3compat://")) {
    const rest = uri.slice("r2-s3compat://".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    return { backendId: rest.slice(0, slash), key: rest.slice(slash + 1) };
  }
  return null;
}
