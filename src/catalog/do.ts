import type { Env } from "../types.ts";

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

interface CommitBody {
  table: string;
  uri: string;
  storageBackend: string;
  accessMode?: string;
  format?: string;
  message?: string;
}

export class CatalogDO implements DurableObject {
  constructor(
    private ctx: DurableObjectState,
    private _env: Env,
  ) {
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tables (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id              TEXT PRIMARY KEY,
        table_id        TEXT NOT NULL REFERENCES tables(id),
        uri             TEXT NOT NULL,
        storage_backend TEXT NOT NULL,
        access_mode     TEXT NOT NULL DEFAULT 'signed',
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commits (
        id           TEXT PRIMARY KEY,
        table_id     TEXT NOT NULL REFERENCES tables(id),
        snapshot_id  TEXT NOT NULL REFERENCES snapshots(id),
        committed_at INTEGER NOT NULL,
        message      TEXT
      );
    `);

    // Add format column to existing instances that predate this field.
    try {
      ctx.storage.sql.exec("ALTER TABLE snapshots ADD COLUMN format TEXT");
    } catch {
      // Column already exists — nothing to do.
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/tables") {
      return this.getTables();
    }

    if (request.method === "GET" && pathname.startsWith("/snapshots/")) {
      const tableRef = decodeURIComponent(pathname.slice("/snapshots/".length));
      return this.getSnapshots(tableRef);
    }

    if (request.method === "POST" && pathname === "/commit") {
      const body = (await request.json()) as CommitBody;
      return this.commit(body);
    }

    if (request.method === "PATCH" && pathname.startsWith("/snapshots/")) {
      const snapshotId = decodeURIComponent(pathname.slice("/snapshots/".length));
      const body = (await request.json()) as Record<string, unknown>;
      return this.patchSnapshot(snapshotId, body);
    }

    return new Response("Not Found", { status: 404 });
  }

  private getTables(): Response {
    const rows = this.ctx.storage.sql
      .exec("SELECT id, name, description, created_at FROM tables ORDER BY name")
      .toArray();
    return Response.json({ tables: rows });
  }

  private getSnapshots(tableRef: string): Response {
    const tableRows = this.ctx.storage.sql
      .exec("SELECT id FROM tables WHERE name = ? OR id = ?", tableRef, tableRef)
      .toArray();
    const table = tableRows[0];
    if (!table) return new Response("Not Found", { status: 404 });

    const snapshots = this.ctx.storage.sql
      .exec(
        `SELECT id, table_id, uri, storage_backend, access_mode, format, created_at
         FROM snapshots WHERE table_id = ? ORDER BY created_at DESC`,
        table.id,
      )
      .toArray();
    return Response.json({ snapshots });
  }

  private commit(body: CommitBody): Response {
    const { table, uri, storageBackend, accessMode = "signed", format, message } = body;

    if (
      typeof table !== "string" ||
      typeof uri !== "string" ||
      typeof storageBackend !== "string"
    ) {
      return new Response("Bad Request: table, uri, storageBackend required", { status: 400 });
    }

    const now = Date.now();

    const tableRows = this.ctx.storage.sql
      .exec("SELECT id FROM tables WHERE name = ?", table)
      .toArray();
    let tableId: string;
    if (tableRows.length === 0) {
      tableId = genId("tbl");
      this.ctx.storage.sql.exec(
        "INSERT INTO tables (id, name, created_at) VALUES (?, ?, ?)",
        tableId,
        table,
        now,
      );
    } else {
      tableId = tableRows[0]!.id as string;
    }

    const snapshotId = genId("snap");
    this.ctx.storage.sql.exec(
      "INSERT INTO snapshots (id, table_id, uri, storage_backend, access_mode, format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      snapshotId,
      tableId,
      uri,
      storageBackend,
      accessMode,
      typeof format === "string" ? format : null,
      now,
    );

    const commitId = genId("commit");
    this.ctx.storage.sql.exec(
      "INSERT INTO commits (id, table_id, snapshot_id, committed_at, message) VALUES (?, ?, ?, ?, ?)",
      commitId,
      tableId,
      snapshotId,
      now,
      typeof message === "string" ? message : null,
    );

    return Response.json({ tableId, snapshotId, commitId }, { status: 201 });
  }

  private patchSnapshot(snapshotId: string, body: Record<string, unknown>): Response {
    const rows = this.ctx.storage.sql
      .exec("SELECT id FROM snapshots WHERE id = ?", snapshotId)
      .toArray();
    if (rows.length === 0) return new Response("Not Found", { status: 404 });

    if ("uri" in body) {
      if (typeof body.uri !== "string")
        return new Response("uri must be a string", { status: 400 });
      this.ctx.storage.sql.exec("UPDATE snapshots SET uri = ? WHERE id = ?", body.uri, snapshotId);
    }

    if ("format" in body) {
      const format =
        body.format === null ? null : typeof body.format === "string" ? body.format : undefined;
      if (format === undefined) {
        return new Response("format must be a string or null", { status: 400 });
      }
      this.ctx.storage.sql.exec("UPDATE snapshots SET format = ? WHERE id = ?", format, snapshotId);
    }

    return new Response(null, { status: 204 });
  }
}
