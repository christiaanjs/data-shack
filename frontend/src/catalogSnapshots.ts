import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { runQuery } from "./duckdb.ts";
import { type SnapshotInput, type SnapshotRow, toSnapshotRow } from "./snapshotRows.ts";
import { acquireProxyCred, buildS3Secret } from "./storage.ts";

// Exposes the catalog's full snapshot history to SQL as a plain DuckDB table:
//
//   catalog_snapshots(table_name, snapshot_id, uri, url, backend, format, created_at TIMESTAMP)
//
// `url` is directly readable (s3://backend/key). Combine with SET VARIABLE /
// getvariable() to pick files in SQL, e.g.
//   SET VARIABLE files = (SELECT list(url) FROM catalog_snapshots WHERE table_name = 'x');
//   SELECT * FROM read_json(getvariable('files'), filename = true);

const DDL = `CREATE OR REPLACE TABLE catalog_snapshots (
  table_name VARCHAR, snapshot_id VARCHAR, uri VARCHAR, url VARCHAR,
  backend VARCHAR, format VARCHAR, created_at TIMESTAMP)`;

const JSON_COLUMNS =
  "{'table_name': 'VARCHAR', 'snapshot_id': 'VARCHAR', 'uri': 'VARCHAR', 'url': 'VARCHAR', " +
  "'backend': 'VARCHAR', 'format': 'VARCHAR', 'created_ms': 'BIGINT'}";

// Backend segments seen in snapshot URLs; each needs an S3 secret to be readable.
const knownBackends = new Set<string>();

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;
const sqlNullable = (s: string | null) => (s === null ? "NULL" : sqlString(s));

/** Replaces the catalog_snapshots table with the catalog's current full history. */
export async function loadCatalogSnapshots(
  db: AsyncDuckDB,
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
  const rows = snapshots.map((s) => toSnapshotRow(s.table_name, s));

  await runQuery(db, DDL);
  knownBackends.clear();
  for (const r of rows) if (r.backend) knownBackends.add(r.backend);
  if (rows.length === 0) return;

  const file = "catalog_snapshots.json";
  await db.registerFileText(file, JSON.stringify(rows));
  try {
    await runQuery(
      db,
      `INSERT INTO catalog_snapshots
         SELECT table_name, snapshot_id, uri, url, backend, format, epoch_ms(created_ms)
         FROM read_json('${file}', format = 'array', columns = ${JSON_COLUMNS})`,
    );
  } finally {
    await db.dropFile(file);
  }
}

/** Adds (or replaces) one snapshot row — used for live commit events. */
export async function addCatalogSnapshot(
  db: AsyncDuckDB,
  tableName: string,
  snapshot: SnapshotInput,
): Promise<void> {
  const r: SnapshotRow = toSnapshotRow(tableName, snapshot);
  if (r.backend) knownBackends.add(r.backend);
  await runQuery(
    db,
    `DELETE FROM catalog_snapshots WHERE snapshot_id = ${sqlString(r.snapshot_id)};
     INSERT INTO catalog_snapshots VALUES (${sqlString(r.table_name)}, ${sqlString(r.snapshot_id)},
       ${sqlString(r.uri)}, ${sqlNullable(r.url)}, ${sqlNullable(r.backend)}, ${sqlNullable(r.format)},
       epoch_ms(${r.created_ms}))`,
  );
}

/** S3 secrets for every backend referenced by catalog_snapshots.url. */
export async function catalogSecrets(
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<string[]> {
  const secrets: string[] = [];
  for (const backend of knownBackends) {
    const cred = await acquireProxyCred(backend, "", workerBase, getAuthHeaders);
    secrets.push(buildS3Secret(cred));
  }
  return secrets;
}
