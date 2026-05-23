import { acquireProxyCred, buildS3Secret, parseStorageUri } from "./storage.ts";

// Matches all storage URIs in SQL text
const STORAGE_URI_REGEX = /(?:r2-s3compat|r2|http-ds):\/\/[^\s'"]+/g;

export interface ResolvedQuery {
  sql: string;
  preamble: string[];
}

/**
 * Resolves all storage URIs in SQL to proxy-backed URLs.
 * Handles r2://, r2-s3compat:// (via S3 proxy credentials) and http-ds:// (via token endpoint).
 * Returns the rewritten SQL and any DuckDB SECRET statements to use as preamble.
 */
export async function resolveStorageUris(
  rawSql: string,
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<ResolvedQuery> {
  const allUris = Array.from(new Set(rawSql.match(STORAGE_URI_REGEX) ?? []));

  if (allUris.length === 0) {
    return { sql: rawSql, preamble: [] };
  }

  const s3Uris = allUris.filter((u) => !u.startsWith("http-ds://"));
  const httpDsUris = allUris.filter((u) => u.startsWith("http-ds://"));

  const secretsByBackend = new Map<string, string>();
  const s3UriMap = new Map<string, string>(); // original URI → s3:// URI

  for (const uri of s3Uris) {
    const parsed = parseStorageUri(uri);
    if (!parsed) continue;
    const { backend, key } = parsed;

    if (!secretsByBackend.has(backend)) {
      const cred = await acquireProxyCred(backend, "", workerBase, getAuthHeaders);
      secretsByBackend.set(backend, buildS3Secret(cred));
    }

    s3UriMap.set(uri, `s3://${backend}/${key}`);
  }

  // Resolve http-ds:// URIs via token endpoint.
  const httpDsUrlMap = new Map<string, string>();
  if (httpDsUris.length > 0) {
    const authHeaders = await getAuthHeaders();
    const res = await fetch(`${workerBase}/api/storage/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ uris: httpDsUris.map((uri) => ({ uri, method: "GET" })) }),
    });
    if (res.ok) {
      const data = (await res.json()) as { urls: Record<string, string> };
      for (const uri of httpDsUris) {
        const url = data.urls[uri];
        if (url) httpDsUrlMap.set(uri, url);
      }
    }
  }

  // Rewrite SQL — longest URIs first to avoid prefix-clobber.
  let sql = rawSql;
  for (const uri of [...allUris].sort((a, b) => b.length - a.length)) {
    const s3Uri = s3UriMap.get(uri);
    if (s3Uri) {
      sql = sql.replaceAll(uri, s3Uri);
    } else {
      const tokenUrl = httpDsUrlMap.get(uri);
      if (tokenUrl) sql = sql.replaceAll(uri, tokenUrl);
    }
  }

  return { sql, preamble: [...secretsByBackend.values()] };
}
