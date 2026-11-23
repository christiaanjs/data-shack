// Port of frontend/src/catalogSnapshots.ts for the Node engine — exposes the
// catalog's full snapshot history to SQL as a plain DuckDB table:
//
//   catalog_snapshots(table_name, snapshot_id, uri, url, backend, format, created_at TIMESTAMP)
//
// `url` is directly readable (s3://backend/key). Combine with SET VARIABLE /
// getvariable() to pick files in SQL, e.g.
//   SET VARIABLE files = (SELECT list(url) FROM catalog_snapshots WHERE table_name = 'x');
//   SELECT * FROM read_json(getvariable('files'), filename = true);
//
// Unlike duckdb-wasm, @duckdb/node-api has no registerFileText()/dropFile()
// virtual-file API, so rows are loaded via a plain bulk INSERT instead of
// read_json() over a registered buffer.
import type { DuckDBEngine } from "../duckdb/engine.js";
import { acquireProxyCred, buildS3Secret } from "../storage.js";
import { type SnapshotInput, type SnapshotRow, toSnapshotRow } from "./snapshotRows.js";

const DDL = `CREATE OR REPLACE TABLE catalog_snapshots (
  table_name VARCHAR, snapshot_id VARCHAR, uri VARCHAR, url VARCHAR,
  backend VARCHAR, format VARCHAR, created_at TIMESTAMP)`;

// Backend segments seen in snapshot URLs; each needs an S3 secret to be readable.
const knownBackends = new Set<string>();

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;
const sqlNullable = (s: string | null) => (s === null ? "NULL" : sqlString(s));
const rowValues = (r: SnapshotRow) =>
  `(${sqlString(r.table_name)}, ${sqlString(r.snapshot_id)}, ${sqlString(r.uri)}, ` +
  `${sqlNullable(r.url)}, ${sqlNullable(r.backend)}, ${sqlNullable(r.format)}, epoch_ms(${r.created_ms}))`;

// Names that always resolve to the Worker's bound R2 bucket.
const BUILT_IN_BACKENDS = ["r2-bound", "data-shack"];

/** Names and ids of the user's current storage backends, or null if the lookup fails. */
async function fetchReadableBackends(
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${workerBase}/api/storage-backends`, {
      headers: await getAuthHeaders(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as
      | { backends?: Array<{ id: string; name: string }> }
      | Array<{ id: string; name: string }>;
    const list = Array.isArray(data) ? data : (data.backends ?? []);
    const set = new Set<string>(BUILT_IN_BACKENDS);
    for (const b of list) {
      set.add(b.id);
      set.add(b.name);
    }
    return set;
  } catch {
    return null;
  }
}

/** Replaces the catalog_snapshots table with the catalog's current full history. */
export async function loadCatalogSnapshots(
  engine: DuckDBEngine,
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<void> {
  const res = await fetch(`${workerBase}/catalog/snapshots-all`, {
    headers: await getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Catalog history fetch failed: ${res.status}`);
  const { snapshots } = (await res.json()) as {
    snapshots: Array<SnapshotInput & { table_name: string }>;
  };
  const readable = await fetchReadableBackends(workerBase, getAuthHeaders);
  const rows = snapshots.map((s) => toSnapshotRow(s.table_name, s, readable));

  await engine.runQuery(DDL);
  knownBackends.clear();
  for (const r of rows) if (r.backend) knownBackends.add(r.backend);
  if (rows.length === 0) return;

  await engine.runQuery(`INSERT INTO catalog_snapshots VALUES ${rows.map(rowValues).join(", ")}`);
}

/** Adds (or replaces) one snapshot row — used for live commit events. */
export async function addCatalogSnapshot(
  engine: DuckDBEngine,
  tableName: string,
  snapshot: SnapshotInput,
): Promise<void> {
  const r = toSnapshotRow(tableName, snapshot);
  if (r.backend) knownBackends.add(r.backend);
  await engine.runQuery(
    `DELETE FROM catalog_snapshots WHERE snapshot_id = ${sqlString(r.snapshot_id)}`,
  );
  await engine.runQuery(`INSERT INTO catalog_snapshots VALUES ${rowValues(r)}`);
}

/** S3 secrets for every backend referenced by catalog_snapshots.url. */
export async function catalogSecrets(
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<string[]> {
  const secrets: string[] = [];
  for (const backend of knownBackends) {
    try {
      const cred = await acquireProxyCred(backend, "", workerBase, getAuthHeaders);
      secrets.push(buildS3Secret(cred));
    } catch (err) {
      // One unresolvable backend must not break every query that mentions catalog_snapshots.
      console.warn(`[catalog] no credential for backend '${backend}'`, err);
    }
  }
  return secrets;
}
