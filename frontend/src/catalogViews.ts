import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { runQuery } from "./duckdb.ts";
import { acquireProxyCred, buildS3Secret, parseStorageUri } from "./storage.ts";

export interface CatalogTable {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
}

export interface CatalogSnapshot {
  id: string;
  table_id: string;
  uri: string;
  storage_backend: string;
  access_mode: string;
  format: string | null;
  created_at: number;
}

export interface CatalogTableWithSnapshot extends CatalogTable {
  latestSnapshot: CatalogSnapshot | null;
}

export function readerFn(uri: string, format?: string | null): string {
  const fmt = format ?? inferFormat(uri);
  if (fmt === "parquet") return "read_parquet";
  if (fmt === "csv") return "read_csv_auto";
  return "read_json";
}

export function inferFormat(uri: string): string {
  if (uri.endsWith(".parquet")) return "parquet";
  if (uri.endsWith(".csv")) return "csv";
  if (uri.endsWith(".ndjson") || uri.endsWith(".jsonl")) return "ndjson";
  return "json";
}

export interface RegisterResult {
  tables: CatalogTableWithSnapshot[];
  failed: string[];
}

/**
 * Fetches all catalog tables with their latest snapshots in a single request,
 * then creates DuckDB views so SQL can reference tables by name.
 */
export async function registerCatalogViews(
  db: AsyncDuckDB,
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<RegisterResult> {
  const headers = await getAuthHeaders();

  const res = await fetch(`${workerBase}/catalog/snapshots-latest`, { headers });
  if (!res.ok) throw new Error(`Catalog fetch failed: ${res.status}`);
  const { tables } = (await res.json()) as { tables: CatalogTableWithSnapshot[] };

  if (tables.length === 0) return { tables, failed: [] };

  const withSnaps = tables.filter(
    (t): t is CatalogTableWithSnapshot & { latestSnapshot: CatalogSnapshot } =>
      t.latestSnapshot !== null,
  );

  if (withSnaps.length === 0) return { tables, failed: [] };

  // Batch-resolve http-ds:// URIs to signed token URLs before creating views.
  const httpDsEntries = withSnaps.filter(({ latestSnapshot }) =>
    latestSnapshot.uri.startsWith("http-ds://"),
  );
  const httpDsTokenMap = new Map<string, string>();
  if (httpDsEntries.length > 0) {
    try {
      const authHeaders = await getAuthHeaders();
      const resolveRes = await fetch(`${workerBase}/api/storage/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          uris: httpDsEntries.map(({ latestSnapshot }) => ({
            uri: latestSnapshot.uri,
            method: "GET",
          })),
        }),
      });
      if (resolveRes.ok) {
        const data = (await resolveRes.json()) as { urls: Record<string, string> };
        for (const [uri, url] of Object.entries(data.urls)) httpDsTokenMap.set(uri, url);
      }
    } catch {
      // Token resolution failed — affected tables land in failed[] below.
    }
  }

  const secretsByBackend = new Map<string, string>();
  const failed: string[] = [];

  for (const { name, latestSnapshot: snapshot } of withSnaps) {
    // For http-ds:// URIs, pass the pre-resolved token URL to avoid per-table round-trips.
    const preResolvedUrl = snapshot.uri.startsWith("http-ds://")
      ? httpDsTokenMap.get(snapshot.uri)
      : undefined;
    await registerView(
      db,
      name,
      snapshot,
      workerBase,
      getAuthHeaders,
      secretsByBackend,
      failed,
      preResolvedUrl,
    );
  }

  return { tables, failed };
}

/**
 * Re-creates the DuckDB view for a single table using a freshly committed snapshot.
 * Called by the catalog WebSocket handler when a commit message arrives.
 */
export async function refreshSingleView(
  db: AsyncDuckDB,
  tableName: string,
  snapshot: CatalogSnapshot,
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<void> {
  const failed: string[] = [];
  await registerView(db, tableName, snapshot, workerBase, getAuthHeaders, new Map(), failed);
}

async function registerView(
  db: AsyncDuckDB,
  tableName: string,
  snapshot: CatalogSnapshot,
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
  secretsByBackend: Map<string, string>,
  failed: string[],
  /** Pre-resolved token URL for http-ds:// URIs; avoids an extra /resolve round-trip. */
  preResolvedUrl?: string,
): Promise<void> {
  const safeId = tableName.replace(/"/g, '""');

  if (snapshot.uri.startsWith("http-ds://")) {
    try {
      let tokenUrl = preResolvedUrl;
      if (!tokenUrl) {
        // Fallback: resolve on demand (used by refreshSingleView).
        const authHeaders = await getAuthHeaders();
        const res = await fetch(`${workerBase}/api/storage/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ uris: [{ uri: snapshot.uri, method: "GET" }] }),
        });
        if (!res.ok) {
          failed.push(tableName);
          return;
        }
        const data = (await res.json()) as { urls: Record<string, string> };
        tokenUrl = data.urls[snapshot.uri];
      }
      if (!tokenUrl) {
        failed.push(tableName);
        return;
      }
      await runQuery(
        db,
        `CREATE OR REPLACE VIEW "${safeId}" AS SELECT * FROM ${readerFn(snapshot.uri, snapshot.format)}('${tokenUrl}')`,
        [],
      );
    } catch {
      failed.push(tableName);
    }
    return;
  }

  const parsed = parseStorageUri(snapshot.uri);
  if (!parsed) {
    failed.push(tableName);
    return;
  }
  const { backend, key } = parsed;

  if (!secretsByBackend.has(backend)) {
    try {
      const cred = await acquireProxyCred(backend, "", workerBase, getAuthHeaders);
      secretsByBackend.set(backend, buildS3Secret(cred));
    } catch {
      failed.push(tableName);
      return;
    }
  }

  const preamble = secretsByBackend.get(backend);
  if (!preamble) {
    failed.push(tableName);
    return;
  }

  const readExpr = key.endsWith("/")
    ? `read_parquet('s3://${backend}/${key}**/*.parquet', hive_partitioning=true)`
    : `${readerFn(snapshot.uri, snapshot.format)}('s3://${backend}/${key}')`;

  try {
    await runQuery(db, `CREATE OR REPLACE VIEW "${safeId}" AS SELECT * FROM ${readExpr}`, [
      preamble,
    ]);
  } catch {
    failed.push(tableName);
  }
}
