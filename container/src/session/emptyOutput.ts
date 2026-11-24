// DuckDB's `COPY (...) TO 'file'` writes nothing when the query returns zero
// rows: it reports `Count = 0` and leaves any existing file untouched. For a
// transform whose output is a single fixed URI that means "no rows now"
// silently keeps the *previous* output (e.g. unmatched transfers that have
// since been matched stay listed forever). These helpers let the job runner
// detect that case and overwrite the output with an explicitly empty result.

interface CopyResultLike {
  columns: string[];
  rows: unknown[][];
}

/** True when `result` is the single-row `Count` result of a COPY that wrote 0 rows. */
export function copyWroteNothing(result: CopyResultLike): boolean {
  if (result.columns.length !== 1 || result.columns[0]?.toLowerCase() !== "count") return false;
  if (result.rows.length !== 1) return false;
  const n = Number(result.rows[0]?.[0]);
  return Number.isFinite(n) && n === 0;
}

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * SQL that overwrites a single-file `json`/`ndjson` output with an empty
 * result (`[]` for json, an empty line for ndjson), or null when the output
 * is not a single file in a format we know how to empty (parquet/csv outputs,
 * directory/partitioned outputs).
 */
export function emptyOutputSql(
  outputUri: string,
  format: string | null | undefined,
): string | null {
  if (!outputUri || outputUri.endsWith("/")) return null;
  const fmt = (format ?? inferFormatFromUri(outputUri)).toLowerCase();
  let body: string;
  if (fmt === "json") body = "[]";
  else if (fmt === "ndjson" || fmt === "jsonl") body = "";
  else return null;
  // Raw text out via CSV with no header/quoting; the trailing newline it adds is harmless for both.
  return `COPY (SELECT ${sqlString(body)} AS v) TO ${sqlString(outputUri)} (FORMAT CSV, HEADER false, QUOTE '', ESCAPE '', DELIMITER '|')`;
}

function inferFormatFromUri(uri: string): string {
  if (uri.endsWith(".ndjson") || uri.endsWith(".jsonl")) return "ndjson";
  if (uri.endsWith(".parquet")) return "parquet";
  if (uri.endsWith(".csv")) return "csv";
  return "json";
}
