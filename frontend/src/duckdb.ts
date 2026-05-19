import * as duckdb from "@duckdb/duckdb-wasm";

let dbInstance: duckdb.AsyncDuckDB | null = null;

export async function initDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (dbInstance) return dbInstance;

  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

  const workerUrl = bundle.mainWorker;
  if (!workerUrl) throw new Error("No DuckDB worker URL available for this platform");

  // Fetch the CDN worker script and wrap it in a blob URL so the browser
  // allows constructing a Worker from it (cross-origin Workers are blocked).
  const workerText = await fetch(workerUrl).then((r) => r.text());
  const blobUrl = URL.createObjectURL(new Blob([workerText], { type: "application/javascript" }));
  const worker = new Worker(blobUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
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
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const conn = await db.connect();
  try {
    const result = await conn.query(sql);
    const columns = result.schema.fields.map((f) => f.name);
    const rows: unknown[][] = [];
    for (const batch of result.batches) {
      for (let i = 0; i < batch.numRows; i++) {
        const row: unknown[] = [];
        for (const col of columns) {
          const vector = batch.getChildAt(result.schema.fields.findIndex((f) => f.name === col));
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
