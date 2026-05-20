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
