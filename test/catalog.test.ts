import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
});

describe("GET /catalog/tables", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/catalog/tables");
    expect(res.status).toBe(401);
  });

  it("returns empty table list for a new user", async () => {
    const res = await SELF.fetch("http://localhost/catalog/tables", { headers: DEV_HEADERS });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { tables: unknown[] };
    expect(Array.isArray(data.tables)).toBe(true);
    expect(data.tables.length).toBe(0);
  });
});

describe("POST /catalog/commit", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table: "transactions",
        uri: "r2://bucket/transactions/file.ndjson",
        storageBackend: "primary-r2",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("creates a table and snapshot on first commit", async () => {
    const res = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "transactions",
        uri: "r2://data-shack-storage/transactions/staging/file.ndjson",
        storageBackend: "primary-r2",
        accessMode: "signed",
        message: "initial load",
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { tableId: string; snapshotId: string; commitId: string };
    expect(typeof data.tableId).toBe("string");
    expect(data.tableId.startsWith("tbl_")).toBe(true);
    expect(typeof data.snapshotId).toBe("string");
    expect(data.snapshotId.startsWith("snap_")).toBe(true);
    expect(typeof data.commitId).toBe("string");
    expect(data.commitId.startsWith("commit_")).toBe(true);
  });

  it("table appears in GET /catalog/tables after commit", async () => {
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "accounts",
        uri: "r2://data-shack-storage/accounts/file.ndjson",
        storageBackend: "primary-r2",
      }),
    });

    const res = await SELF.fetch("http://localhost/catalog/tables", { headers: DEV_HEADERS });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { tables: Array<{ id: string; name: string }> };
    const found = data.tables.find((t) => t.name === "accounts");
    expect(found).toBeDefined();
    expect(found?.id.startsWith("tbl_")).toBe(true);
  });

  it("second commit to the same table reuses the existing table row", async () => {
    const commit1 = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "balances",
        uri: "r2://data-shack-storage/balances/v1.ndjson",
        storageBackend: "primary-r2",
      }),
    });
    const d1 = (await commit1.json()) as { tableId: string };

    const commit2 = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "balances",
        uri: "r2://data-shack-storage/balances/v2.ndjson",
        storageBackend: "primary-r2",
      }),
    });
    const d2 = (await commit2.json()) as { tableId: string; snapshotId: string };

    expect(d2.tableId).toBe(d1.tableId);
    expect(d2.snapshotId.startsWith("snap_")).toBe(true);
  });
});

describe("GET /catalog/snapshots/:table", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/catalog/snapshots/transactions");
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown table", async () => {
    const res = await SELF.fetch("http://localhost/catalog/snapshots/no_such_table", {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("returns snapshots in descending order for a committed table", async () => {
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "history",
        uri: "r2://data-shack-storage/history/2026-01.ndjson",
        storageBackend: "primary-r2",
      }),
    });
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "history",
        uri: "r2://data-shack-storage/history/2026-05.parquet",
        storageBackend: "primary-r2",
        accessMode: "signed",
      }),
    });

    const res = await SELF.fetch("http://localhost/catalog/snapshots/history", {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      snapshots: Array<{ id: string; uri: string; storage_backend: string; access_mode: string }>;
    };
    expect(data.snapshots.length).toBe(2);
    // Most recent first
    expect(data.snapshots[0]?.uri).toBe("r2://data-shack-storage/history/2026-05.parquet");
    expect(data.snapshots[1]?.uri).toBe("r2://data-shack-storage/history/2026-01.ndjson");
    expect(data.snapshots[0]?.storage_backend).toBe("primary-r2");
    expect(data.snapshots[0]?.access_mode).toBe("signed");
  });

  it("stores and returns an explicit format field", async () => {
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "typed_table",
        uri: "r2://data-shack-storage/data/balances.json",
        storageBackend: "primary-r2",
        format: "ndjson",
      }),
    });

    const res = await SELF.fetch("http://localhost/catalog/snapshots/typed_table", {
      headers: DEV_HEADERS,
    });
    const data = (await res.json()) as { snapshots: Array<{ format: string | null }> };
    expect(data.snapshots[0]?.format).toBe("ndjson");
  });

  it("stores null format when not specified", async () => {
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "untyped_table",
        uri: "r2://data-shack-storage/data/file.parquet",
        storageBackend: "primary-r2",
      }),
    });

    const res = await SELF.fetch("http://localhost/catalog/snapshots/untyped_table", {
      headers: DEV_HEADERS,
    });
    const data = (await res.json()) as { snapshots: Array<{ format: string | null }> };
    expect(data.snapshots[0]?.format).toBeNull();
  });

  it("can look up snapshots by table id as well as name", async () => {
    const commitRes = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "payments",
        uri: "r2://data-shack-storage/payments/file.parquet",
        storageBackend: "primary-r2",
      }),
    });
    const { tableId } = (await commitRes.json()) as { tableId: string };

    const byId = await SELF.fetch(`http://localhost/catalog/snapshots/${tableId}`, {
      headers: DEV_HEADERS,
    });
    expect(byId.status).toBe(200);
    const data = (await byId.json()) as { snapshots: Array<{ uri: string }> };
    expect(data.snapshots.length).toBe(1);
    expect(data.snapshots[0]?.uri).toBe("r2://data-shack-storage/payments/file.parquet");
  });
});

describe("PATCH /catalog/snapshots/:id", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/catalog/snapshots/snap_fake", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: "r2://bucket/new.parquet" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown snapshot id", async () => {
    const res = await SELF.fetch("http://localhost/catalog/snapshots/snap_doesnotexist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ uri: "r2://bucket/new.parquet" }),
    });
    expect(res.status).toBe(404);
  });

  it("updates uri and format on an existing snapshot", async () => {
    const commitRes = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "patch_target",
        uri: "r2://bucket/original.json",
        storageBackend: "primary-r2",
        format: "json",
      }),
    });
    const { snapshotId } = (await commitRes.json()) as { snapshotId: string };

    const patchRes = await SELF.fetch(`http://localhost/catalog/snapshots/${snapshotId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ uri: "r2://bucket/corrected.ndjson", format: "ndjson" }),
    });
    expect(patchRes.status).toBe(204);

    const snapRes = await SELF.fetch("http://localhost/catalog/snapshots/patch_target", {
      headers: DEV_HEADERS,
    });
    const data = (await snapRes.json()) as {
      snapshots: Array<{ uri: string; format: string | null }>;
    };
    expect(data.snapshots[0]?.uri).toBe("r2://bucket/corrected.ndjson");
    expect(data.snapshots[0]?.format).toBe("ndjson");
  });

  it("clears format when patched to null", async () => {
    const commitRes = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "patch_null_format",
        uri: "r2://bucket/data.parquet",
        storageBackend: "primary-r2",
        format: "parquet",
      }),
    });
    const { snapshotId } = (await commitRes.json()) as { snapshotId: string };

    await SELF.fetch(`http://localhost/catalog/snapshots/${snapshotId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ format: null }),
    });

    const snapRes = await SELF.fetch("http://localhost/catalog/snapshots/patch_null_format", {
      headers: DEV_HEADERS,
    });
    const data = (await snapRes.json()) as { snapshots: Array<{ format: string | null }> };
    expect(data.snapshots[0]?.format).toBeNull();
  });

  it("returns 400 when uri is not a string", async () => {
    const commitRes = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "patch_bad_uri",
        uri: "r2://bucket/data.parquet",
        storageBackend: "primary-r2",
      }),
    });
    const { snapshotId } = (await commitRes.json()) as { snapshotId: string };

    const res = await SELF.fetch(`http://localhost/catalog/snapshots/${snapshotId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ uri: 42 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /catalog/commit validation", () => {
  it("rejects table names with invalid characters", async () => {
    const res = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: 'bad"name',
        uri: "r2://bucket/data.parquet",
        storageBackend: "primary-r2",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /catalog/tables/:table", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/catalog/tables/no_such_table", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown table", async () => {
    const res = await SELF.fetch("http://localhost/catalog/tables/no_such_table", {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("soft-deletes a table: 204 response and absent from GET /catalog/tables", async () => {
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "to_delete",
        uri: "r2://bucket/data.parquet",
        storageBackend: "primary-r2",
      }),
    });

    const del = await SELF.fetch("http://localhost/catalog/tables/to_delete", {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(del.status).toBe(204);

    const list = await SELF.fetch("http://localhost/catalog/tables", { headers: DEV_HEADERS });
    const { tables } = (await list.json()) as { tables: Array<{ name: string }> };
    expect(tables.find((t) => t.name === "to_delete")).toBeUndefined();
  });

  it("snapshots of a soft-deleted table return 404", async () => {
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "deleted_snaps",
        uri: "r2://bucket/data.parquet",
        storageBackend: "primary-r2",
      }),
    });
    await SELF.fetch("http://localhost/catalog/tables/deleted_snaps", {
      method: "DELETE",
      headers: DEV_HEADERS,
    });

    const res = await SELF.fetch("http://localhost/catalog/snapshots/deleted_snaps", {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("can delete by table id as well as name", async () => {
    const commitRes = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "delete_by_id",
        uri: "r2://bucket/data.parquet",
        storageBackend: "primary-r2",
      }),
    });
    const { tableId } = (await commitRes.json()) as { tableId: string };

    const del = await SELF.fetch(`http://localhost/catalog/tables/${tableId}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(del.status).toBe(204);

    const list = await SELF.fetch("http://localhost/catalog/tables", { headers: DEV_HEADERS });
    const { tables } = (await list.json()) as { tables: Array<{ name: string }> };
    expect(tables.find((t) => t.name === "delete_by_id")).toBeUndefined();
  });

  it("committing to a soft-deleted table name restores it", async () => {
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "restore_me",
        uri: "r2://bucket/v1.parquet",
        storageBackend: "primary-r2",
      }),
    });
    await SELF.fetch("http://localhost/catalog/tables/restore_me", {
      method: "DELETE",
      headers: DEV_HEADERS,
    });

    // Re-commit should restore the table.
    const recommit = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "restore_me",
        uri: "r2://bucket/v2.parquet",
        storageBackend: "primary-r2",
      }),
    });
    expect(recommit.status).toBe(201);

    const list = await SELF.fetch("http://localhost/catalog/tables", { headers: DEV_HEADERS });
    const { tables } = (await list.json()) as { tables: Array<{ name: string }> };
    expect(tables.find((t) => t.name === "restore_me")).toBeDefined();
  });
});
