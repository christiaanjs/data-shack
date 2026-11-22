// Pure SQL-templating helpers for reading catalog snapshot history from
// transform / workbench SQL. No DOM, DuckDB or network imports so the logic can
// be unit-tested from the worker test suite.
//
// Three constructs are supported in SQL text:
//
//   history('table' [, since => <ts>] [, sample_hours => N])
//       A relation over every snapshot of a catalog table (not only the latest).
//       Adds `_snapshot_id` and `_snapshot_at` (TIMESTAMP, UTC) columns.
//       `since` keeps snapshots created at or after <ts> (inclusive, so the
//       snapshot that produced a watermark is re-read — merges must be
//       idempotent). `sample_hours` keeps only the newest snapshot per N-hour
//       bucket; only safe when consecutive snapshots overlap heavily.
//
//   {{watermark('table', 'column')}}
//       max(column) of a catalog table as `epoch_ms(<ms>)`, or `epoch_ms(0)` if the
//       table does not exist yet or is empty. Meant for `since => ...`.
//
//   {{existing('table', 'fallback_cte')}}
//       The previous contents of a catalog table, materialised before the
//       statement runs (so a COPY may safely overwrite the files it came from).
//       When the table does not exist yet it expands to an empty relation shaped
//       like `fallback_cte`.

export interface HistorySnapshot {
  id: string;
  uri: string;
  format: string | null;
  created_at: number;
}

export interface HistoryCall {
  raw: string;
  table: string;
  sinceMs: number | null;
  sampleHours: number | null;
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

const WATERMARK_RE = new RegExp(
  `\\{\\{\\s*watermark\\(\\s*'(${IDENT})'\\s*,\\s*'(${IDENT})'\\s*\\)\\s*\\}\\}`,
  "g",
);
const EXISTING_RE = new RegExp(
  `\\{\\{\\s*existing\\(\\s*'(${IDENT})'\\s*,\\s*'(${IDENT})'\\s*\\)\\s*\\}\\}`,
  "g",
);
const HISTORY_ARG = String.raw`\s*,\s*(?:since|sample_hours)\s*=>\s*(?:epoch_ms\(\s*-?\d+\s*\)|TIMESTAMP\s*'[^']*'|\d+(?:\.\d+)?)`;
const HISTORY_RE = new RegExp(
  String.raw`(?<![\w.])history\(\s*'([^']+)'((?:${HISTORY_ARG})*)\s*\)`,
  "gi",
);
const ARG_RE =
  /(since|sample_hours)\s*=>\s*(epoch_ms\(\s*(-?\d+)\s*\)|TIMESTAMP\s*'([^']*)'|(\d+(?:\.\d+)?))/gi;

export function sqlString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

export function quoteIdent(s: string): string {
  return `"${s.replaceAll('"', '""')}"`;
}

/** Name of the temp table holding a materialised `existing(...)` table. */
export function prevTableName(table: string): string {
  return `_prev_${table}`;
}

export function hasTemplates(sql: string): boolean {
  return /\{\{\s*(?:watermark|existing)\(/i.test(sql) || /(?<![\w.])history\(\s*'/i.test(sql);
}

export function findWatermarks(sql: string): { table: string; column: string }[] {
  const seen = new Map<string, { table: string; column: string }>();
  for (const m of sql.matchAll(WATERMARK_RE)) {
    seen.set(`${m[1]}.${m[2]}`, { table: m[1] as string, column: m[2] as string });
  }
  return [...seen.values()];
}

/** Replaces `{{watermark(...)}}` with `epoch_ms(<ms>)` using the supplied values. */
export function applyWatermarks(sql: string, values: Map<string, number>): string {
  return sql.replace(WATERMARK_RE, (_m, table: string, column: string) => {
    return `epoch_ms(${values.get(`${table}.${column}`) ?? 0})`;
  });
}

export function findExisting(sql: string): { table: string; fallback: string }[] {
  const seen = new Map<string, { table: string; fallback: string }>();
  for (const m of sql.matchAll(EXISTING_RE)) {
    seen.set(`${m[1]}`, { table: m[1] as string, fallback: m[2] as string });
  }
  return [...seen.values()];
}

/** Replaces `{{existing(...)}}`. `present` holds the tables that exist in the catalog. */
export function applyExisting(sql: string, present: Set<string>): string {
  return sql.replace(EXISTING_RE, (_m, table: string, fallback: string) =>
    present.has(table)
      ? quoteIdent(prevTableName(table))
      : `(SELECT * FROM ${quoteIdent(fallback)} WHERE false)`,
  );
}

function parseTimestampMs(literal: string): number {
  const iso = literal.trim().replace(" ", "T");
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso);
  const ms = Date.parse(hasZone ? iso : `${iso}Z`);
  if (Number.isNaN(ms)) throw new Error(`history(): cannot parse timestamp '${literal}'`);
  return ms;
}

export function findHistoryCalls(sql: string): HistoryCall[] {
  const calls = new Map<string, HistoryCall>();
  for (const m of sql.matchAll(HISTORY_RE)) {
    const call: HistoryCall = {
      raw: m[0],
      table: m[1] as string,
      sinceMs: null,
      sampleHours: null,
    };
    for (const a of (m[2] ?? "").matchAll(ARG_RE)) {
      const name = (a[1] as string).toLowerCase();
      if (name === "since") {
        call.sinceMs = a[3] !== undefined ? Number(a[3]) : parseTimestampMs((a[4] ?? "") as string);
      } else {
        const hours = Number(a[5]);
        if (!(hours > 0)) throw new Error("history(): sample_hours must be > 0");
        call.sampleHours = hours;
      }
    }
    calls.set(call.raw, call);
  }
  return [...calls.values()];
}

/** Keeps the newest snapshot of each `hours`-wide bucket. */
export function sampleSnapshots<T extends { created_at: number }>(snaps: T[], hours: number): T[] {
  const width = hours * 3_600_000;
  const best = new Map<number, T>();
  for (const s of snaps) {
    const bucket = Math.floor(s.created_at / width);
    const cur = best.get(bucket);
    if (!cur || s.created_at > cur.created_at) best.set(bucket, s);
  }
  return [...best.values()];
}

/** Applies since/sample filters and returns snapshots oldest → newest. */
export function selectSnapshots(snaps: HistorySnapshot[], call: HistoryCall): HistorySnapshot[] {
  let out = snaps;
  if (call.sinceMs !== null) {
    const since = call.sinceMs;
    out = out.filter((s) => s.created_at >= since);
  }
  if (call.sampleHours !== null) out = sampleSnapshots(out, call.sampleHours);
  return [...out].sort((a, b) => a.created_at - b.created_at);
}

function inferFormat(uri: string): string {
  if (uri.endsWith(".parquet")) return "parquet";
  if (uri.endsWith(".csv")) return "csv";
  if (uri.endsWith(".ndjson") || uri.endsWith(".jsonl")) return "ndjson";
  return "json";
}

export interface ResolvedHistorySnapshot extends HistorySnapshot {
  /** Fully resolved URL DuckDB can read, e.g. s3://backend/key */
  url: string;
}

/**
 * Builds the relation for one `history(...)` call. Each snapshot's `filename`
 * is joined to an inline VALUES list to attach `_snapshot_id` / `_snapshot_at`.
 */
export function buildHistoryRelation(table: string, snaps: ResolvedHistorySnapshot[]): string {
  if (snaps.length === 0) {
    throw new Error(`history('${table}'): no snapshots match`);
  }
  const groups = new Map<string, ResolvedHistorySnapshot[]>();
  for (const s of snaps) {
    const fmt = s.format ?? inferFormat(s.uri);
    let reader: string;
    if (fmt === "parquet") reader = "read_parquet";
    else if (fmt === "json" || fmt === "ndjson") reader = "read_json";
    else throw new Error(`history('${table}'): unsupported snapshot format '${fmt}'`);
    const list = groups.get(reader) ?? [];
    list.push(s);
    groups.set(reader, list);
  }

  const selects = [...groups.entries()].map(([reader, list]) => {
    const files = list.map((s) => sqlString(s.url)).join(", ");
    const values = list
      .map(
        (s) => `(${sqlString(s.url)}, ${sqlString(s.id)}, epoch_ms(${Math.trunc(s.created_at)}))`,
      )
      .join(", ");
    return `SELECT d.* EXCLUDE (filename), m.snapshot_id AS _snapshot_id, m.snapshot_at AS _snapshot_at FROM ${reader}([${files}], filename = true, union_by_name = true) d JOIN (VALUES ${values}) AS m(filename, snapshot_id, snapshot_at) ON d.filename = m.filename`;
  });
  return `(${selects.join(" UNION ALL BY NAME ")})`;
}
