// Port of frontend/src/storage.ts for a Node process — same proxy-credential
// vending flow and CREATE SECRET statement, since DuckDB's S3/httpfs client
// behaves identically in @duckdb/node-api and duckdb-wasm.

interface ProxyCred {
  accessKeyId: string;
  secret: string;
  endpoint: string; // hostname[:port][/path] — protocol stripped
  useSSL: boolean;
  region: string;
  bucket: string;
  expiresAt: number;
}

const credCache = new Map<string, ProxyCred>();

export async function acquireProxyCred(
  backend: string,
  pathPrefix: string,
  workerOrigin: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
  ttlSeconds = 3600,
): Promise<ProxyCred> {
  const cacheKey = `${backend}:${pathPrefix}`;
  const cached = credCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached;

  const headers = await getAuthHeaders();
  const res = await fetch(`${workerOrigin}/api/storage/proxy-credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ backend, pathPrefix, ttlSeconds }),
  });
  if (!res.ok) throw new Error(`Failed to acquire proxy credential: ${res.status}`);
  const data = (await res.json()) as {
    accessKeyId: string;
    secret: string;
    endpoint: string;
    region: string;
    bucket: string;
  };

  const cred: ProxyCred = {
    ...data,
    endpoint: data.endpoint.replace(/^https?:\/\//, ""),
    useSSL: data.endpoint.startsWith("https://"),
    expiresAt: Date.now() + (Math.min(ttlSeconds, 3600) - 60) * 1000,
  };
  credCache.set(cacheKey, cred);
  return cred;
}

export function buildS3Secret(cred: ProxyCred): string {
  const secretName = `_ds_${cred.bucket.replace(/[^a-zA-Z0-9]/g, "_")}`;
  return (
    `CREATE OR REPLACE SECRET ${secretName} ` +
    `(TYPE s3, ENDPOINT '${cred.endpoint}', ` +
    `KEY_ID '${cred.accessKeyId}', SECRET '${cred.secret}', ` +
    `REGION '${cred.region}', URL_STYLE 'path', ` +
    `USE_SSL ${cred.useSSL ? "true" : "false"}, ` +
    `SCOPE 's3://${cred.bucket}/')`
  );
}

export function parseStorageUri(uri: string): { backend: string; key: string } | null {
  if (uri.startsWith("r2://")) {
    const rest = uri.slice("r2://".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    return { backend: rest.slice(0, slash), key: rest.slice(slash + 1) };
  }
  if (uri.startsWith("r2-s3compat://")) {
    const rest = uri.slice("r2-s3compat://".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    return { backend: rest.slice(0, slash), key: rest.slice(slash + 1) };
  }
  return null;
}
