// Port of frontend/src/snapshotRows.ts — identical row-shaping logic.
import { parseStorageUri } from "../storage.js";

/** One row of the `catalog_snapshots` DuckDB table (created_at is added as a TIMESTAMP in SQL). */
export interface SnapshotRow {
  table_name: string;
  snapshot_id: string;
  uri: string;
  /** Directly readable DuckDB URL (s3://backend/key), or null for schemes DuckDB can't read. */
  url: string | null;
  backend: string | null;
  format: string | null;
  created_ms: number;
}

export interface SnapshotInput {
  id: string;
  uri: string;
  format: string | null;
  created_at: number;
}

function inferFormat(uri: string): string {
  if (uri.endsWith(".parquet")) return "parquet";
  if (uri.endsWith(".csv")) return "csv";
  if (uri.endsWith(".ndjson") || uri.endsWith(".jsonl")) return "ndjson";
  return "json";
}

/**
 * `readable` (optional) is the set of backend names/ids that currently resolve.
 * Snapshots on a backend outside it (deleted/renamed since) get url = NULL so SQL
 * can skip them with `WHERE url IS NOT NULL`.
 */
export function toSnapshotRow(
  tableName: string,
  s: SnapshotInput,
  readable?: Set<string> | null,
): SnapshotRow {
  const parsed = parseStorageUri(s.uri);
  const ok = parsed !== null && (!readable || readable.has(parsed.backend));
  return {
    table_name: tableName,
    snapshot_id: s.id,
    uri: s.uri,
    url: parsed && ok ? `s3://${parsed.backend}/${parsed.key}` : null,
    backend: parsed && ok ? parsed.backend : null,
    format: s.format ?? inferFormat(s.uri),
    created_ms: Math.trunc(s.created_at),
  };
}
