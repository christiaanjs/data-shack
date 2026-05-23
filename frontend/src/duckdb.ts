import * as duckdb from "@duckdb/duckdb-wasm";

let dbInstance: duckdb.AsyncDuckDB | null = null;

function resolveLogLevel(): duckdb.LogLevel {
  switch (import.meta.env.VITE_DUCKDB_LOG_LEVEL) {
    case "DEBUG":
      return duckdb.LogLevel.DEBUG;
    case "INFO":
      return duckdb.LogLevel.INFO;
    case "WARNING":
      return duckdb.LogLevel.WARNING;
    case "ERROR":
      return duckdb.LogLevel.ERROR;
    default:
      return import.meta.env.DEV ? duckdb.LogLevel.INFO : duckdb.LogLevel.WARNING;
  }
}

export async function initDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (dbInstance) return dbInstance;

  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

  if (!bundle.mainWorker) throw new Error("No DuckDB worker URL available for this platform");

  // importScripts inside the blob is the official pattern for loading a
  // cross-origin CDN worker — the blob URL itself is same-origin.
  const blobUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
  );
  const worker = new Worker(blobUrl);
  const logger = new duckdb.ConsoleLogger(resolveLogLevel());
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(blobUrl);
  await db.open({ path: ":memory:" });

  const conn = await db.connect();
  try {
    await conn.query("INSTALL httpfs; LOAD httpfs;");
  } finally {
    await conn.close();
  }

  dbInstance = db;
  return db;
}

export async function runQuery(
  db: duckdb.AsyncDuckDB,
  sql: string,
  preamble?: string[],
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const conn = await db.connect();
  try {
    if (preamble) {
      for (const stmt of preamble) await conn.query(stmt);
    }
    const result = await conn.query(sql);
    const columns = result.schema.fields.map((f) => f.name);
    const rows: unknown[][] = [];
    for (const batch of result.batches) {
      for (let i = 0; i < batch.numRows; i++) {
        const row: unknown[] = [];
        for (let j = 0; j < columns.length; j++) {
          const vector = batch.getChildAt(j);
          row.push(vector ? vector.get(i) : null);
        }
        rows.push(row);
      }
    }
    return { columns, rows };
  } finally {
    await conn.close();
  }
}
