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
  tables: CatalogTable[];
  failed: string[];
}

/**
 * Fetches all catalog tables, resolves their latest snapshots, and creates DuckDB views
 * so SQL can reference tables by their catalog names (e.g. SELECT * FROM transactions).
 *
 * Used by both QueryPanel (on load/refresh) and sessionWs (before query/transform job execution)
 * to provide a consistent DuckDB environment regardless of which tab is active.
 */
export async function registerCatalogViews(
  db: AsyncDuckDB,
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<RegisterResult> {
  const headers = await getAuthHeaders();

  const tablesRes = await fetch(`${workerBase}/catalog/tables`, { headers });
  if (!tablesRes.ok) throw new Error(`Catalog fetch failed: ${tablesRes.status}`);
  const { tables } = (await tablesRes.json()) as { tables: CatalogTable[] };

  if (tables.length === 0) return { tables, failed: [] };

  const snapEntries = await Promise.all(
    tables.map(async (t) => {
      const res = await fetch(`${workerBase}/catalog/snapshots/${encodeURIComponent(t.name)}`, {
        headers,
      });
      if (!res.ok) return null;
      const { snapshots } = (await res.json()) as { snapshots: CatalogSnapshot[] };
      return snapshots.length > 0 ? { table: t, snapshot: snapshots[0] as CatalogSnapshot } : null;
    }),
  );
  const withSnaps = snapEntries.filter(
    (e): e is { table: CatalogTable; snapshot: CatalogSnapshot } => e !== null,
  );

  if (withSnaps.length === 0) return { tables, failed: [] };

  // Batch-resolve http-ds:// URIs to signed token URLs before creating views.
  const httpDsEntries = withSnaps.filter(({ snapshot }) => snapshot.uri.startsWith("http-ds://"));
  const httpDsTokenMap = new Map<string, string>();
  if (httpDsEntries.length > 0) {
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/storage/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          uris: httpDsEntries.map(({ snapshot }) => ({ uri: snapshot.uri, method: "GET" })),
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { urls: Record<string, string> };
        for (const [uri, url] of Object.entries(data.urls)) httpDsTokenMap.set(uri, url);
      }
    } catch {
      // token resolution failed — affected tables land in failed[] below
    }
  }

  const secretsByBackend = new Map<string, string>();
  const failed: string[] = [];

  for (const { table, snapshot } of withSnaps) {
    const safeId = table.name.replace(/"/g, '""');

    if (snapshot.uri.startsWith("http-ds://")) {
      const tokenUrl = httpDsTokenMap.get(snapshot.uri);
      if (!tokenUrl) {
        failed.push(table.name);
        continue;
      }
      try {
        await runQuery(
          db,
          `CREATE OR REPLACE VIEW "${safeId}" AS SELECT * FROM ${readerFn(snapshot.uri, snapshot.format)}('${tokenUrl}')`,
          [],
        );
      } catch {
        failed.push(table.name);
      }
      continue;
    }

    const parsed = parseStorageUri(snapshot.uri);
    if (!parsed) {
      failed.push(table.name);
      continue;
    }
    const { backend, key } = parsed;

    if (!secretsByBackend.has(backend)) {
      try {
        const cred = await acquireProxyCred(backend, "", workerBase, getAuthHeaders);
        secretsByBackend.set(backend, buildS3Secret(cred));
      } catch {
        failed.push(table.name);
        continue;
      }
    }

    const preamble = secretsByBackend.get(backend);
    if (!preamble) {
      failed.push(table.name);
      continue;
    }

    const readExpr = key.endsWith("/")
      ? `read_parquet('s3://${backend}/${key}**/*.parquet', hive_partitioning=true)`
      : `${readerFn(snapshot.uri, snapshot.format)}('s3://${backend}/${key}')`;

    try {
      await runQuery(db, `CREATE OR REPLACE VIEW "${safeId}" AS SELECT * FROM ${readExpr}`, [
        preamble,
      ]);
    } catch {
      failed.push(table.name);
    }
  }

  return { tables, failed };
}
