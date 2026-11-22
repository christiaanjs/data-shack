import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { runQuery } from "./duckdb.ts";
import {
  type HistorySnapshot,
  type ResolvedHistorySnapshot,
  applyExisting,
  applyWatermarks,
  buildHistoryRelation,
  findExisting,
  findHistoryCalls,
  findWatermarks,
  hasTemplates,
  prevTableName,
  quoteIdent,
  selectSnapshots,
} from "./historySql.ts";
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

export interface QueryResolveContext {
  db: AsyncDuckDB;
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
}

async function fetchSnapshots(
  table: string,
  ctx: QueryResolveContext,
  limit?: number,
): Promise<HistorySnapshot[] | null> {
  const qs = limit ? `?limit=${limit}` : "";
  const res = await fetch(`${ctx.workerBase}/catalog/snapshots/${encodeURIComponent(table)}${qs}`, {
    headers: await ctx.getAuthHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Catalog snapshot lookup failed for '${table}': ${res.status}`);
  const { snapshots } = (await res.json()) as { snapshots: HistorySnapshot[] };
  return snapshots;
}

/**
 * Like resolveStorageUris, but first expands the history templates documented in
 * historySql.ts (`history(...)`, `{{watermark(...)}}`, `{{existing(...)}}`).
 */
export async function resolveQuerySql(
  rawSql: string,
  ctx: QueryResolveContext,
): Promise<ResolvedQuery> {
  if (!hasTemplates(rawSql)) {
    return resolveStorageUris(rawSql, ctx.workerBase, ctx.getAuthHeaders);
  }

  const secrets = new Map<string, string>(); // backend → CREATE SECRET
  const statements: string[] = [];
  const ensureSecret = async (backend: string) => {
    if (secrets.has(backend)) return;
    const cred = await acquireProxyCred(backend, "", ctx.workerBase, ctx.getAuthHeaders);
    secrets.set(backend, buildS3Secret(cred));
  };
  const secretForUri = async (uri: string) => {
    const parsed = parseStorageUri(uri);
    if (!parsed) throw new Error(`Unsupported storage URI for history/existing: ${uri}`);
    await ensureSecret(parsed.backend);
    return parsed;
  };

  let sql = rawSql;

  // 1. Watermarks: max(column) of the previous output, read via the catalog view.
  const watermarks = new Map<string, number>();
  for (const { table, column } of findWatermarks(sql)) {
    const latest = await fetchSnapshots(table, ctx, 1);
    let ms = 0;
    if (latest && latest.length > 0) {
      await secretForUri((latest[0] as HistorySnapshot).uri);
      const { rows } = await runQuery(
        ctx.db,
        `SELECT epoch_ms(max(${quoteIdent(column)}))::BIGINT FROM ${quoteIdent(table)}`,
        [...secrets.values()],
      );
      const v = rows[0]?.[0];
      ms = v === null || v === undefined ? 0 : Number(v);
    }
    watermarks.set(`${table}.${column}`, ms);
  }
  sql = applyWatermarks(sql, watermarks);

  // 2. existing(): materialise the previous output into a temp table so a COPY
  //    can overwrite the files it was read from. Temp tables are per-connection
  //    and runQuery runs preamble + SQL on one connection, then closes it.
  const present = new Set<string>();
  for (const { table } of findExisting(sql)) {
    const latest = await fetchSnapshots(table, ctx, 1);
    if (!latest || latest.length === 0) continue;
    await secretForUri((latest[0] as HistorySnapshot).uri);
    present.add(table);
    statements.push(
      `CREATE OR REPLACE TEMP TABLE ${quoteIdent(prevTableName(table))} AS SELECT * FROM ${quoteIdent(table)}`,
    );
  }
  sql = applyExisting(sql, present);

  // 3. history(): inline relation over the selected snapshots.
  for (const call of findHistoryCalls(sql)) {
    const all = await fetchSnapshots(call.table, ctx);
    if (!all) throw new Error(`history('${call.table}'): table not found in catalog`);
    const resolved: ResolvedHistorySnapshot[] = [];
    for (const snap of selectSnapshots(all, call)) {
      const { backend, key } = await secretForUri(snap.uri);
      if (key.endsWith("/") || key.includes("*")) {
        throw new Error(`history('${call.table}'): directory/glob snapshots are not supported`);
      }
      resolved.push({ ...snap, url: `s3://${backend}/${key}` });
    }
    sql = sql.replaceAll(call.raw, buildHistoryRelation(call.table, resolved));
  }

  const rest = await resolveStorageUris(sql, ctx.workerBase, ctx.getAuthHeaders);
  const preamble = [...new Set([...secrets.values(), ...rest.preamble])];
  return { sql: rest.sql, preamble: [...preamble, ...statements] };
}
