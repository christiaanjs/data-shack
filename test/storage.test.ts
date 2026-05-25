import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
});

describe("GET /api/credentials", () => {
  it("returns empty array for a new user", async () => {
    const res = await SELF.fetch("http://localhost/api/credentials", {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { credentials: unknown[] };
    expect(Array.isArray(data.credentials)).toBe(true);
    expect(data.credentials.length).toBe(0);
  });

  it("creates a credential and returns id", async () => {
    const res = await SELF.fetch("http://localhost/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ name: "my-akahu", type: "akahu", config: { token: "abc123" } }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: string };
    expect(typeof data.id).toBe("string");
    expect(data.id.startsWith("cred_")).toBe(true);
  });

  it("returns created credential in list without config", async () => {
    const createRes = await SELF.fetch("http://localhost/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "list-test-cred",
        type: "generic_token",
        config: { key: "val" },
      }),
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    const listRes = await SELF.fetch("http://localhost/api/credentials", {
      headers: DEV_HEADERS,
    });
    expect(listRes.status).toBe(200);
    const data = (await listRes.json()) as {
      credentials: Array<{ id: string; name: string; type: string; created_at: number }>;
    };
    const found = data.credentials.find((c) => c.id === id);
    expect(found).toBeDefined();
    expect(found?.name).toBe("list-test-cred");
    expect(found?.type).toBe("generic_token");
    expect((found as Record<string, unknown>)?.config).toBeUndefined();
  });

  it("deletes a credential", async () => {
    const createRes = await SELF.fetch("http://localhost/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ name: "to-delete", type: "akahu", config: {} }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const deleteRes = await SELF.fetch(`http://localhost/api/credentials/${id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(deleteRes.status).toBe(204);

    const listRes = await SELF.fetch("http://localhost/api/credentials", { headers: DEV_HEADERS });
    const data = (await listRes.json()) as { credentials: Array<{ id: string }> };
    expect(data.credentials.find((c) => c.id === id)).toBeUndefined();
  });
});

describe("GET /api/storage-backends", () => {
  it("returns empty array for a new user", async () => {
    const res = await SELF.fetch("http://localhost/api/storage-backends", {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { backends: unknown[] };
    expect(Array.isArray(data.backends)).toBe(true);
    expect(data.backends.length).toBe(0);
  });

  it("creates a storage backend and returns id", async () => {
    const res = await SELF.fetch("http://localhost/api/storage-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "Primary R2",
        type: "r2-bound",
        config: { bucket: "my-bucket" },
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: string };
    expect(typeof data.id).toBe("string");
    expect(data.id.startsWith("sb_")).toBe(true);
  });

  it("returns created backend in list without config", async () => {
    const createRes = await SELF.fetch("http://localhost/api/storage-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ name: "S3 Backend", type: "s3", config: { region: "us-east-1" } }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const listRes = await SELF.fetch("http://localhost/api/storage-backends", {
      headers: DEV_HEADERS,
    });
    const data = (await listRes.json()) as {
      backends: Array<{ id: string; name: string; type: string; created_at: number }>;
    };
    const found = data.backends.find((b) => b.id === id);
    expect(found).toBeDefined();
    expect(found?.name).toBe("S3 Backend");
    expect(found?.type).toBe("s3");
    expect((found as Record<string, unknown>)?.config).toBeUndefined();
  });

  it("deletes a storage backend", async () => {
    const createRes = await SELF.fetch("http://localhost/api/storage-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ name: "to-delete", type: "r2-bound", config: {} }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const deleteRes = await SELF.fetch(`http://localhost/api/storage-backends/${id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(deleteRes.status).toBe(204);

    const listRes = await SELF.fetch("http://localhost/api/storage-backends", {
      headers: DEV_HEADERS,
    });
    const data = (await listRes.json()) as { backends: Array<{ id: string }> };
    expect(data.backends.find((b) => b.id === id)).toBeUndefined();
  });
});
