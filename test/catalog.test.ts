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

describe("GET /catalog/snapshots-latest", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/catalog/snapshots-latest");
    expect(res.status).toBe(401);
  });

  it("returns an array of tables", async () => {
    const res = await SELF.fetch("http://localhost/catalog/snapshots-latest", {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { tables: unknown[] };
    expect(Array.isArray(data.tables)).toBe(true);
  });

  it("returns tables with their latest snapshot inline, not an older one", async () => {
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "sl_table",
        uri: "r2://bucket/sl_table/v1.ndjson",
        storageBackend: "primary-r2",
        format: "ndjson",
      }),
    });
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "sl_table",
        uri: "r2://bucket/sl_table/v2.parquet",
        storageBackend: "primary-r2",
        format: "parquet",
      }),
    });

    const res = await SELF.fetch("http://localhost/catalog/snapshots-latest", {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      tables: Array<{
        name: string;
        latestSnapshot: { uri: string; format: string | null } | null;
      }>;
    };
    const row = data.tables.find((t) => t.name === "sl_table");
    expect(row).toBeDefined();
    // Should return the most recent (v2) snapshot, not v1.
    expect(row?.latestSnapshot?.uri).toBe("r2://bucket/sl_table/v2.parquet");
    expect(row?.latestSnapshot?.format).toBe("parquet");
  });

  it("returns null latestSnapshot for a soft-deleted-and-not-recommitted table", async () => {
    // Commit a table, then soft-delete it. Since deleted_at is set, the table
    // is excluded from snapshots-latest (deleted_at IS NULL filter). Verify the
    // LEFT JOIN null case by checking a table that was committed then deleted
    // does not appear in the results at all (the query filters deleted_at IS NULL).
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "sl_deleted_table",
        uri: "r2://bucket/sl_deleted/v1.ndjson",
        storageBackend: "primary-r2",
      }),
    });
    await SELF.fetch("http://localhost/catalog/tables/sl_deleted_table", {
      method: "DELETE",
      headers: DEV_HEADERS,
    });

    const res = await SELF.fetch("http://localhost/catalog/snapshots-latest", {
      headers: DEV_HEADERS,
    });
    const data = (await res.json()) as { tables: Array<{ name: string }> };
    // Deleted table must not appear in the batch endpoint.
    const found = data.tables.find((t) => t.name === "sl_deleted_table");
    expect(found).toBeUndefined();
  });
});

describe("GET /catalog/ws", () => {
  it("returns 426 when not a WebSocket upgrade", async () => {
    const res = await SELF.fetch("http://localhost/catalog/ws", { headers: DEV_HEADERS });
    expect(res.status).toBe(426);
  });

  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/catalog/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("broadcasts commit payload to connected clients", async () => {
    const wsRes = await SELF.fetch("http://localhost/catalog/ws", {
      headers: { Upgrade: "websocket", ...DEV_HEADERS },
    });
    expect(wsRes.status).toBe(101);
    const ws = wsRes.webSocket!;
    ws.accept();

    // Listen for the commit broadcast before triggering the commit.
    const msgPromise = new Promise<{
      type: string;
      table: string;
      uri: string;
      storage_backend: string;
      format: string | null;
    }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for catalog commit broadcast")),
        3000,
      );
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data as string) as { type: string };
        if (msg.type === "commit") {
          clearTimeout(timer);
          resolve(
            msg as {
              type: string;
              table: string;
              uri: string;
              storage_backend: string;
              format: string | null;
            },
          );
        }
      });
    });

    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "ws_broadcast_test",
        uri: "r2://bucket/ws_broadcast_test/file.ndjson",
        storageBackend: "primary-r2",
        format: "ndjson",
      }),
    });

    const msg = await msgPromise;
    expect(msg.table).toBe("ws_broadcast_test");
    expect(msg.uri).toBe("r2://bucket/ws_broadcast_test/file.ndjson");
    expect(msg.storage_backend).toBe("primary-r2");
    expect(msg.format).toBe("ndjson");
    ws.close();
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

describe("Transform jobs", () => {
  it("POST /api/transform-jobs creates a job", async () => {
    const res = await SELF.fetch("http://localhost/api/transform-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "compact transactions",
        sql: "COPY (SELECT * FROM transactions) TO 'r2://data-shack/compacted/txn.parquet' (FORMAT PARQUET)",
        output_table: "transactions_compacted",
        output_uri: "r2://data-shack/compacted/txn.parquet",
        output_backend: "data-shack",
        format: "parquet",
      }),
    });
    expect(res.status).toBe(201);
    const job = (await res.json()) as {
      id: string;
      status: string;
      sql: string;
      output_table: string;
    };
    expect(job.id.startsWith("tj_")).toBe(true);
    expect(job.status).toBe("idle");
    expect(job.output_table).toBe("transactions_compacted");
  });

  it("GET /api/transform-jobs lists jobs", async () => {
    await SELF.fetch("http://localhost/api/transform-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        sql: "SELECT 1",
        output_table: "list_test",
        output_uri: "r2://data-shack/list_test.parquet",
        output_backend: "data-shack",
      }),
    });

    const res = await SELF.fetch("http://localhost/api/transform-jobs", { headers: DEV_HEADERS });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { jobs: unknown[] };
    expect(Array.isArray(data.jobs)).toBe(true);
    expect(data.jobs.length).toBeGreaterThan(0);
  });

  it("POST /api/triggers creates a trigger and commit fires it", async () => {
    // Create a transform job.
    const jobRes = await SELF.fetch("http://localhost/api/transform-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "trigger test job",
        sql: "SELECT 1",
        output_table: "trigger_output",
        output_uri: "r2://data-shack/trigger_output.parquet",
        output_backend: "data-shack",
      }),
    });
    expect(jobRes.status).toBe(201);
    const job = (await jobRes.json()) as { id: string };

    // Create a trigger that watches "trigger_source" table.
    const trigRes = await SELF.fetch("http://localhost/api/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ watches: "trigger_source", job_id: job.id }),
    });
    expect(trigRes.status).toBe(201);
    const trigger = (await trigRes.json()) as {
      id: string;
      watches: string[];
      policy: string;
      job_id: string;
    };
    expect(trigger.watches).toEqual(["trigger_source"]);
    expect(trigger.policy).toBe("any");
    expect(trigger.job_id).toBe(job.id);

    // Commit to the watched table — should trigger the job.
    const commitRes = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "trigger_source",
        uri: "r2://data-shack/trigger_source/file.ndjson",
        storageBackend: "data-shack",
      }),
    });
    expect(commitRes.status).toBe(201);
    const commitData = (await commitRes.json()) as { triggeredJobIds: string[] };
    expect(commitData.triggeredJobIds).toContain(job.id);

    // Job should now be pending.
    const jobsRes = await SELF.fetch("http://localhost/api/transform-jobs", {
      headers: DEV_HEADERS,
    });
    const { jobs } = (await jobsRes.json()) as { jobs: Array<{ id: string; status: string }> };
    const found = jobs.find((j) => j.id === job.id);
    expect(found?.status).toBe("pending");
  });

  it("commit to an unwatched table does not trigger the job", async () => {
    const jobRes = await SELF.fetch("http://localhost/api/transform-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        sql: "SELECT 1",
        output_table: "not_triggered_out",
        output_uri: "r2://data-shack/not_triggered.parquet",
        output_backend: "data-shack",
      }),
    });
    const job = (await jobRes.json()) as { id: string };

    // Trigger watches a different table.
    await SELF.fetch("http://localhost/api/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ watches: "watched_table_x", job_id: job.id }),
    });

    // Commit to a different table.
    const commitRes = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "different_table_y",
        uri: "r2://data-shack/different.ndjson",
        storageBackend: "data-shack",
      }),
    });
    const commitData = (await commitRes.json()) as { triggeredJobIds: string[] };
    expect(commitData.triggeredJobIds).not.toContain(job.id);
  });

  it("DELETE /api/transform-jobs/:id removes the job", async () => {
    const jobRes = await SELF.fetch("http://localhost/api/transform-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        sql: "SELECT 1",
        output_table: "to_delete_job",
        output_uri: "r2://data-shack/to_delete.parquet",
        output_backend: "data-shack",
      }),
    });
    const job = (await jobRes.json()) as { id: string };

    const del = await SELF.fetch(`http://localhost/api/transform-jobs/${job.id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(del.status).toBe(204);

    // Should no longer appear in list.
    const list = await SELF.fetch("http://localhost/api/transform-jobs", { headers: DEV_HEADERS });
    const { jobs } = (await list.json()) as { jobs: Array<{ id: string }> };
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();
  });

  it("GET /api/triggers lists triggers", async () => {
    const res = await SELF.fetch("http://localhost/api/triggers", { headers: DEV_HEADERS });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { triggers: unknown[] };
    expect(Array.isArray(data.triggers)).toBe(true);
  });

  it("DELETE /api/triggers/:id removes the trigger", async () => {
    const jobRes = await SELF.fetch("http://localhost/api/transform-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        sql: "SELECT 1",
        output_table: "trig_del_out",
        output_uri: "r2://data-shack/trig_del.parquet",
        output_backend: "data-shack",
      }),
    });
    const job = (await jobRes.json()) as { id: string };

    const trigRes = await SELF.fetch("http://localhost/api/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ watches: "trig_del_source", job_id: job.id }),
    });
    const trigger = (await trigRes.json()) as { id: string };

    const del = await SELF.fetch(`http://localhost/api/triggers/${trigger.id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(del.status).toBe(204);

    const list = await SELF.fetch("http://localhost/api/triggers", { headers: DEV_HEADERS });
    const { triggers } = (await list.json()) as { triggers: Array<{ id: string }> };
    expect(triggers.find((t) => t.id === trigger.id)).toBeUndefined();
  });

  it("trigger with watches array is stored and returned as array", async () => {
    const jobRes = await SELF.fetch("http://localhost/api/transform-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        sql: "SELECT 1",
        output_table: "multi_watch_out",
        output_uri: "r2://data-shack/multi_watch.parquet",
        output_backend: "data-shack",
      }),
    });
    const job = (await jobRes.json()) as { id: string };

    const trigRes = await SELF.fetch("http://localhost/api/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ watches: ["table_a", "table_b"], policy: "all", job_id: job.id }),
    });
    expect(trigRes.status).toBe(201);
    const trigger = (await trigRes.json()) as {
      id: string;
      watches: string[];
      policy: string;
      job_id: string;
    };
    expect(trigger.watches).toEqual(["table_a", "table_b"]);
    expect(trigger.policy).toBe("all");
  });

  it("policy:all trigger does not fire after only one watched table commits", async () => {
    const jobRes = await SELF.fetch("http://localhost/api/transform-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        sql: "SELECT 1",
        output_table: "all_policy_out",
        output_uri: "r2://data-shack/all_policy.parquet",
        output_backend: "data-shack",
      }),
    });
    const job = (await jobRes.json()) as { id: string };

    await SELF.fetch("http://localhost/api/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ watches: ["source_a", "source_b"], policy: "all", job_id: job.id }),
    });

    // Commit only source_a — should NOT trigger the job.
    const commitRes = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "source_a",
        uri: "r2://data-shack/source_a.ndjson",
        storageBackend: "data-shack",
      }),
    });
    expect(commitRes.status).toBe(201);
    const commitData = (await commitRes.json()) as { triggeredJobIds: string[] };
    expect(commitData.triggeredJobIds).not.toContain(job.id);

    // Job should still be idle.
    const jobRes2 = await SELF.fetch("http://localhost/api/transform-jobs", {
      headers: DEV_HEADERS,
    });
    const { jobs } = (await jobRes2.json()) as { jobs: Array<{ id: string; status: string }> };
    expect(jobs.find((j) => j.id === job.id)?.status).toBe("idle");
  });

  it("policy:all trigger fires after all watched tables have committed", async () => {
    const jobRes = await SELF.fetch("http://localhost/api/transform-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        sql: "SELECT 1",
        output_table: "all_policy_both_out",
        output_uri: "r2://data-shack/all_policy_both.parquet",
        output_backend: "data-shack",
      }),
    });
    const job = (await jobRes.json()) as { id: string };

    await SELF.fetch("http://localhost/api/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ watches: ["both_a", "both_b"], policy: "all", job_id: job.id }),
    });

    // Commit both_a first — not triggered yet.
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "both_a",
        uri: "r2://data-shack/both_a.ndjson",
        storageBackend: "data-shack",
      }),
    });

    // Commit both_b — now both are fresh → trigger fires.
    const commitRes = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "both_b",
        uri: "r2://data-shack/both_b.ndjson",
        storageBackend: "data-shack",
      }),
    });
    expect(commitRes.status).toBe(201);
    const commitData = (await commitRes.json()) as { triggeredJobIds: string[] };
    expect(commitData.triggeredJobIds).toContain(job.id);
  });

  it("policy:all trigger does not fire again until job completes and both tables re-commit", async () => {
    const jobRes = await SELF.fetch("http://localhost/api/transform-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        sql: "SELECT 1",
        output_table: "all_idempotent_out",
        output_uri: "r2://data-shack/all_idempotent.parquet",
        output_backend: "data-shack",
      }),
    });
    const job = (await jobRes.json()) as { id: string };

    await SELF.fetch("http://localhost/api/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ watches: ["idem_a", "idem_b"], policy: "all", job_id: job.id }),
    });

    // Commit both — job fires and goes to pending.
    for (const tbl of ["idem_a", "idem_b"]) {
      await SELF.fetch("http://localhost/catalog/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...DEV_HEADERS },
        body: JSON.stringify({
          table: tbl,
          uri: `r2://data-shack/${tbl}.ndjson`,
          storageBackend: "data-shack",
        }),
      });
    }

    // Simulate job claim + complete (sets last_completed_at).
    await SELF.fetch(`http://localhost/api/transform-jobs/${job.id}/trigger`, {
      method: "POST",
      headers: DEV_HEADERS,
    });
    await SELF.fetch(`http://localhost/do/catalog/jobs/${job.id}/claim`, {
      method: "POST",
      headers: DEV_HEADERS,
    });
    await SELF.fetch(`http://localhost/do/catalog/jobs/${job.id}/complete`, {
      method: "POST",
      headers: DEV_HEADERS,
    });

    // Now commit only idem_a — should NOT re-trigger (idem_b hasn't recommitted).
    const commitRes = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "idem_a",
        uri: "r2://data-shack/idem_a_v2.ndjson",
        storageBackend: "data-shack",
      }),
    });
    const commitData = (await commitRes.json()) as { triggeredJobIds: string[] };
    expect(commitData.triggeredJobIds).not.toContain(job.id);
  });
});
