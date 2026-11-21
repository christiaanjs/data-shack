import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };
const JSON_HEADERS = { "Content-Type": "application/json", ...DEV_HEADERS };

// The dev token resolves to this user; the catalog DO is keyed by user id.
const catalogStub = () => env.CATALOG.get(env.CATALOG.idFromName("usr_test"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function commit(table: string, uri: string): Promise<string> {
  const res = await SELF.fetch("http://localhost/catalog/commit", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ table, uri, storageBackend: "primary-r2", format: "ndjson" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { snapshotId: string }).snapshotId;
}

async function latestFor(table: string) {
  const res = await SELF.fetch("http://localhost/catalog/snapshots-latest", {
    headers: DEV_HEADERS,
  });
  const { tables } = (await res.json()) as {
    tables: { name: string; latestSnapshot: { id: string; uri: string } | null }[];
  };
  return tables.find((t) => t.name === table)?.latestSnapshot ?? null;
}

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
});

describe("catalog DO schema", () => {
  it("creates indexes, latest_snapshots and records the schema version", async () => {
    await commit("schema_probe", "r2://b/schema_probe/1.ndjson");
    await runInDurableObject(catalogStub(), async (_instance, state) => {
      const names = state.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE name IN (?, ?, ?, ?)",
          ...[
            "idx_snapshots_table_created",
            "idx_commits_table",
            "latest_snapshots",
            "schema_meta",
          ],
        )
        .toArray()
        .map((r) => r.name);
      expect(names.sort()).toEqual(
        [
          "idx_commits_table",
          "idx_snapshots_table_created",
          "latest_snapshots",
          "schema_meta",
        ].sort(),
      );
      const v = state.storage.sql.exec("SELECT v FROM schema_meta WHERE k = 'version'").one();
      expect(v.v).toBe(2);
    });
  });

  it("uses the snapshots index when looking up history for a table", async () => {
    await runInDurableObject(catalogStub(), async (_instance, state) => {
      const plan = state.storage.sql
        .exec(
          "EXPLAIN QUERY PLAN SELECT id FROM snapshots WHERE table_id = ? ORDER BY created_at DESC LIMIT 1",
          "x",
        )
        .toArray()
        .map((r) => String(r.detail))
        .join(" ");
      expect(plan).toContain("idx_snapshots_table_created");
      expect(plan).not.toMatch(/SCAN snapshots/);
    });
  });
});

describe("latest_snapshots pointer", () => {
  it("tracks the newest commit while history is retained", async () => {
    const first = await commit("latest_probe", "r2://b/latest_probe/1.ndjson");
    await sleep(5);
    const second = await commit("latest_probe", "r2://b/latest_probe/2.ndjson");
    await sleep(5);
    const third = await commit("latest_probe", "r2://b/latest_probe/3.ndjson");

    const latest = await latestFor("latest_probe");
    expect(latest?.id).toBe(third);
    expect(latest?.uri).toBe("r2://b/latest_probe/3.ndjson");

    const res = await SELF.fetch("http://localhost/catalog/snapshots/latest_probe", {
      headers: DEV_HEADERS,
    });
    const { snapshots } = (await res.json()) as { snapshots: { id: string }[] };
    expect(snapshots.map((s) => s.id)).toEqual([third, second, first]);
  });

  it("honours ?limit=1 on the history endpoint", async () => {
    await commit("limit_probe", "r2://b/limit_probe/1.ndjson");
    await sleep(5);
    const newest = await commit("limit_probe", "r2://b/limit_probe/2.ndjson");

    const res = await SELF.fetch("http://localhost/catalog/snapshots/limit_probe?limit=1", {
      headers: DEV_HEADERS,
    });
    const { snapshots } = (await res.json()) as { snapshots: { id: string }[] };
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.id).toBe(newest);
  });

  it("reflects PATCH changes to the latest snapshot", async () => {
    const id = await commit("patch_probe", "r2://b/patch_probe/1.ndjson");
    const patch = await SELF.fetch(`http://localhost/catalog/snapshots/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ uri: "r2://b/patch_probe/patched.ndjson" }),
    });
    expect(patch.status).toBe(204);
    expect((await latestFor("patch_probe"))?.uri).toBe("r2://b/patch_probe/patched.ndjson");
  });

  it("backfills latest_snapshots from history when migrating a pre-v2 DO", async () => {
    await commit("backfill_probe", "r2://b/backfill_probe/1.ndjson");
    await sleep(5);
    const newest = await commit("backfill_probe", "r2://b/backfill_probe/2.ndjson");

    await runInDurableObject(catalogStub(), async (instance, state) => {
      // Simulate a DO created before v2: no pointer rows, no version record.
      state.storage.sql.exec("DELETE FROM latest_snapshots");
      state.storage.sql.exec("DELETE FROM schema_meta");
      (instance as unknown as { migrate(): void }).migrate();
    });

    expect((await latestFor("backfill_probe"))?.id).toBe(newest);
  });
});

describe("catalog WebSocket keepalive", () => {
  it("answers a bare 'ping' with 'pong' via the runtime auto-response", async () => {
    const wsRes = await SELF.fetch("http://localhost/catalog/ws", {
      headers: { Upgrade: "websocket", ...DEV_HEADERS },
    });
    expect(wsRes.status).toBe(101);
    const ws = wsRes.webSocket!;
    ws.accept();

    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no pong received")), 3000);
      ws.addEventListener("message", (event) => {
        clearTimeout(timer);
        resolve(event.data as string);
      });
    });
    ws.send("ping");
    expect(await reply).toBe("pong");
    ws.close();
  });
});
