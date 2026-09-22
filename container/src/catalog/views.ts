// Port of frontend/src/catalogViews.ts for the Node DuckDB engine. Table-name
// parity with the browser client (SELECT * FROM my_table instead of raw
// storage URIs) is optional — see config.enableCatalogViews.
import type { DuckDBEngine } from "../duckdb/engine.js";
import { acquireProxyCred, buildS3Secret, parseStorageUri } from "../storage.js";

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

export async function fetchCatalogMetadata(
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<CatalogTableWithSnapshot[]> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${workerBase}/catalog/snapshots-latest`, { headers });
  if (!res.ok) throw new Error(`Catalog fetch failed: ${res.status}`);
  const { tables } = (await res.json()) as { tables: CatalogTableWithSnapshot[] };
  return tables;
}

export async function registerCatalogViews(
  engine: DuckDBEngine,
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<RegisterResult> {
  const tables = await fetchCatalogMetadata(workerBase, getAuthHeaders);
  if (tables.length === 0) return { tables, failed: [] };

  const withSnaps = tables.filter(
    (t): t is CatalogTableWithSnapshot & { latestSnapshot: CatalogSnapshot } =>
      t.latestSnapshot !== null,
  );
  if (withSnaps.length === 0) return { tables, failed: [] };

  let failed = await registerViewsPass(engine, withSnaps, workerBase, getAuthHeaders);
  if (failed.length > 0) {
    await new Promise((r) => setTimeout(r, 2000));
    const retryEntries = withSnaps.filter((t) => failed.includes(t.name));
    failed = await registerViewsPass(engine, retryEntries, workerBase, getAuthHeaders);
  }

  return { tables, failed };
}

async function registerViewsPass(
  engine: DuckDBEngine,
  entries: (CatalogTableWithSnapshot & { latestSnapshot: CatalogSnapshot })[],
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<string[]> {
  const httpDsEntries = entries.filter(({ latestSnapshot }) =>
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

  for (const { name, latestSnapshot: snapshot } of entries) {
    const preResolvedUrl = snapshot.uri.startsWith("http-ds://")
      ? httpDsTokenMap.get(snapshot.uri)
      : undefined;
    await registerView(
      engine,
      name,
      snapshot,
      workerBase,
      getAuthHeaders,
      secretsByBackend,
      failed,
      preResolvedUrl,
    );
  }

  return failed;
}

export async function refreshSingleView(
  engine: DuckDBEngine,
  tableName: string,
  snapshot: CatalogSnapshot,
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<void> {
  const failed: string[] = [];
  await registerView(engine, tableName, snapshot, workerBase, getAuthHeaders, new Map(), failed);
  if (failed.length > 0) {
    throw new Error(`Failed to refresh view for table "${tableName}"`);
  }
}

async function registerView(
  engine: DuckDBEngine,
  tableName: string,
  snapshot: CatalogSnapshot,
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
  secretsByBackend: Map<string, string>,
  failed: string[],
  preResolvedUrl?: string,
): Promise<void> {
  const safeId = tableName.replace(/"/g, '""');

  if (snapshot.uri.startsWith("http-ds://")) {
    try {
      let tokenUrl = preResolvedUrl;
      if (!tokenUrl) {
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
      await engine.runQuery(
        `CREATE OR REPLACE VIEW "${safeId}" AS SELECT * FROM ${readerFn(snapshot.uri, snapshot.format)}('${tokenUrl}')`,
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
    await engine.runQuery(`CREATE OR REPLACE VIEW "${safeId}" AS SELECT * FROM ${readExpr}`, [
      preamble,
    ]);
  } catch {
    failed.push(tableName);
  }
}
