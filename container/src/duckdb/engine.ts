import { DuckDBInstance } from "@duckdb/node-api";
import { createLogger } from "../logger.js";

const logger = createLogger("duckdb");

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

// Recursively convert DuckDB Node API values to JSON-serializable types.
// Mirrors frontend/src/duckdb.ts's serializeArrowValue: BIGINT becomes a
// plain number when it fits in Number.MAX_SAFE_INTEGER, otherwise a string
// (matching what the browser client already sends over the same WS protocol,
// so MCP callers see identical row shapes regardless of which client answered).
function serializeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") {
    const MAX = BigInt(Number.MAX_SAFE_INTEGER);
    const MIN = -MAX;
    return v >= MIN && v <= MAX ? Number(v) : String(v);
  }
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(serializeValue);
  if (typeof v === "object") {
    // Plain data (STRUCT rows, etc.) recurse; opaque wrapper types the node
    // API returns for exotic DuckDB types (INTERVAL, UUID, BLOB, ...) fall
    // back to their string form rather than serializing as "{}".
    const ctorName = (v as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName === "Object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = serializeValue(val);
      }
      return out;
    }
    return String(v);
  }
  return v;
}

export class DuckDBEngine {
  private instance: DuckDBInstance | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly extensionDir?: string,
  ) {}

  async init(): Promise<void> {
    this.instance = await DuckDBInstance.create(this.dbPath);
    const conn = await this.instance.connect();
    try {
      if (this.extensionDir) {
        // Pins DuckDB to the directory the Docker image pre-populated at
        // build time (see docker/install-httpfs.mjs), decoupling it from
        // whatever $HOME the build vs. runtime user/stage happens to have.
        await conn.run(`SET extension_directory = '${this.extensionDir.replace(/'/g, "''")}';`);
      }
      // The Docker image pre-installs httpfs at build time so a plain LOAD
      // works with no outbound network call. Falling back to INSTALL keeps
      // `npm run dev` working outside the image, where it isn't cached yet.
      try {
        await conn.run("LOAD httpfs;");
      } catch {
        await conn.run("INSTALL httpfs;");
        await conn.run("LOAD httpfs;");
      }
    } finally {
      conn.closeSync();
    }
    logger.info(`DuckDB initialized (${this.dbPath}), httpfs loaded`);
  }

  async runQuery(sql: string, preamble?: string[]): Promise<QueryResult> {
    if (!this.instance) throw new Error("DuckDBEngine not initialized");
    const conn = await this.instance.connect();
    try {
      if (preamble) {
        for (const stmt of preamble) await conn.run(stmt);
      }
      const reader = await conn.runAndReadAll(sql);
      const columns = reader.columnNames();
      const rowsRaw = reader.getRowsJS();
      const rows = rowsRaw.map((row) => row.map(serializeValue));
      return { columns, rows };
    } finally {
      conn.closeSync();
    }
  }
}
