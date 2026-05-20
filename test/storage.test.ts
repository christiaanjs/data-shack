import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
});

describe("POST /api/storage/resolve", () => {
  it("returns 401 without auth token", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uris: [{ uri: "r2://data-shack-storage/sample.ndjson", method: "GET" }],
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 for non-array uris body", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ uris: "not-an-array" }),
    });
    expect(res.status).toBe(400);
  });

  it("resolves r2:// URI (GET) to a /api/storage/obj/ URL", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: "r2://data-shack-storage/sample.ndjson", method: "GET" }],
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { urls: Record<string, string> };
    const url = data.urls["r2://data-shack-storage/sample.ndjson"];
    expect(url).toBeDefined();
    expect(url).toContain("/api/storage/obj/");
  });

  it("resolves r2:// URI (PUT) to a /api/storage/obj/ URL", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: "r2://data-shack-storage/output.parquet", method: "PUT" }],
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { urls: Record<string, string> };
    const url = data.urls["r2://data-shack-storage/output.parquet"];
    expect(url).toBeDefined();
    expect(url).toContain("/api/storage/obj/");
  });

  it("resolves mixed GET and PUT URIs in a single call", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [
          { uri: "r2://data-shack-storage/input.parquet", method: "GET" },
          { uri: "r2://data-shack-storage/output.parquet", method: "PUT" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { urls: Record<string, string> };
    expect(data.urls["r2://data-shack-storage/input.parquet"]).toContain("/api/storage/obj/");
    expect(data.urls["r2://data-shack-storage/output.parquet"]).toContain("/api/storage/obj/");
  });

  it("silently omits http-ds:// URIs with method PUT (no write support)", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ uris: [{ uri: "http-ds://cred_123/path", method: "PUT" }] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { urls: Record<string, string> };
    expect(data.urls["http-ds://cred_123/path"]).toBeUndefined();
  });
});

describe("GET /api/storage/obj/:token", () => {
  it("returns 401 for an invalid token", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/obj/invalid-token");
    expect(res.status).toBe(401);
  });

  it("returns 404 when R2 object does not exist but token is valid", async () => {
    const resolveRes = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: "r2://data-shack-storage/nonexistent.ndjson", method: "GET" }],
      }),
    });
    expect(resolveRes.status).toBe(200);
    const data = (await resolveRes.json()) as { urls: Record<string, string> };
    const url = data.urls["r2://data-shack-storage/nonexistent.ndjson"] ?? "";

    const res = await SELF.fetch(url);
    expect(res.status).toBe(404);
  });

  it("streams an R2 object when it exists (user-scoped key)", async () => {
    const content = '{"id":1,"name":"test"}\n';
    // r2-bound keys are prefixed with users/{userId}/ for isolation
    await env.R2.put("users/usr_test/test-obj.ndjson", content, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });

    const resolveRes = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: "r2://data-shack-storage/test-obj.ndjson", method: "GET" }],
      }),
    });
    const resolveData = (await resolveRes.json()) as { urls: Record<string, string> };
    const url = resolveData.urls["r2://data-shack-storage/test-obj.ndjson"] ?? "";

    const objRes = await SELF.fetch(url);
    expect(objRes.status).toBe(200);
    expect(objRes.headers.get("Content-Type")).toBe("application/x-ndjson");
    const body = await objRes.text();
    expect(body).toBe(content);
  });

  it("returns 401 when a PUT token is used on the GET endpoint (cross-method rejection)", async () => {
    const resolveRes = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: "r2://data-shack-storage/some-file.parquet", method: "PUT" }],
      }),
    });
    const resolveData = (await resolveRes.json()) as { urls: Record<string, string> };
    const writeUrl = resolveData.urls["r2://data-shack-storage/some-file.parquet"] ?? "";

    const res = await SELF.fetch(writeUrl);
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/storage/obj/:token", () => {
  it("returns 401 for an invalid token", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/obj/invalid-token", {
      method: "PUT",
      body: "data",
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when a GET token is used for PUT (cross-method rejection)", async () => {
    const resolveRes = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: "r2://data-shack-storage/some-file.parquet", method: "GET" }],
      }),
    });
    const resolveData = (await resolveRes.json()) as { urls: Record<string, string> };
    const readUrl = resolveData.urls["r2://data-shack-storage/some-file.parquet"] ?? "";

    const putRes = await SELF.fetch(readUrl, { method: "PUT", body: "data" });
    expect(putRes.status).toBe(401);
  });

  it("writes an R2 object and returns 204", async () => {
    const resolveRes = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: "r2://data-shack-storage/write-test.txt", method: "PUT" }],
      }),
    });
    expect(resolveRes.status).toBe(200);
    const resolveData = (await resolveRes.json()) as { urls: Record<string, string> };
    const writeUrl = resolveData.urls["r2://data-shack-storage/write-test.txt"] ?? "";

    const content = "hello from write test";
    const putRes = await SELF.fetch(writeUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: content,
    });
    expect(putRes.status).toBe(204);

    const obj = await env.R2.get("users/usr_test/write-test.txt");
    expect(obj).not.toBeNull();
    const text = await obj!.text();
    expect(text).toBe(content);
  });
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
      body: JSON.stringify({ name: "My Akahu", type: "akahu", config: { token: "abc123" } }),
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
        name: "List Test Cred",
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
    expect(found?.name).toBe("List Test Cred");
    expect(found?.type).toBe("generic_token");
    expect((found as Record<string, unknown>)?.config).toBeUndefined();
  });

  it("deletes a credential", async () => {
    const createRes = await SELF.fetch("http://localhost/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ name: "To Delete", type: "akahu", config: {} }),
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
      body: JSON.stringify({ name: "To Delete", type: "r2-bound", config: {} }),
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

describe("r2-s3compat URI resolution", () => {
  it("resolves r2-s3compat:// URI (GET) to a /api/storage/r2s3compat/obj/ URL", async () => {
    const createRes = await SELF.fetch("http://localhost/api/storage-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "Test R2 S3Compat",
        type: "r2-s3compat",
        config: {
          endpoint: "https://test-account.r2.cloudflarestorage.com",
          accessKeyId: "test-key-id",
          secretAccessKey: "test-secret",
          bucket: "test-bucket",
          region: "auto",
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    const resolveRes = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: `r2-s3compat://${id}/path/to/data.parquet`, method: "GET" }],
      }),
    });
    expect(resolveRes.status).toBe(200);
    const data = (await resolveRes.json()) as { urls: Record<string, string> };
    const url = data.urls[`r2-s3compat://${id}/path/to/data.parquet`];
    expect(url).toBeDefined();
    expect(url).toContain("/api/storage/r2s3compat/obj/");
  });

  it("resolves r2-s3compat:// URI (PUT) to a /api/storage/r2s3compat/obj/ URL", async () => {
    const createRes = await SELF.fetch("http://localhost/api/storage-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "Write Test Backend",
        type: "r2-s3compat",
        config: {
          endpoint: "https://test-account.r2.cloudflarestorage.com",
          accessKeyId: "test-key-id",
          secretAccessKey: "test-secret",
          bucket: "test-bucket",
          region: "auto",
        },
      }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const resolveRes = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: `r2-s3compat://${id}/output.parquet`, method: "PUT" }],
      }),
    });
    expect(resolveRes.status).toBe(200);
    const data = (await resolveRes.json()) as { urls: Record<string, string> };
    const url = data.urls[`r2-s3compat://${id}/output.parquet`];
    expect(url).toBeDefined();
    expect(url).toContain("/api/storage/r2s3compat/obj/");
  });

  it("returns 401 for invalid r2s3compat token", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/r2s3compat/obj/invalid-token");
    expect(res.status).toBe(401);
  });

  it("returns 401 when a GET token is used for r2s3compat PUT (cross-method rejection)", async () => {
    const createRes = await SELF.fetch("http://localhost/api/storage-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "Method Check Backend",
        type: "r2-s3compat",
        config: {
          endpoint: "https://test-account.r2.cloudflarestorage.com",
          accessKeyId: "k",
          secretAccessKey: "s",
          bucket: "b",
          region: "auto",
        },
      }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const resolveRes = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: `r2-s3compat://${id}/file.parquet`, method: "GET" }],
      }),
    });
    const resolveData = (await resolveRes.json()) as { urls: Record<string, string> };
    const readUrl = resolveData.urls[`r2-s3compat://${id}/file.parquet`] ?? "";

    const putRes = await SELF.fetch(readUrl, { method: "PUT", body: "data" });
    expect(putRes.status).toBe(401);
  });

  it("returns 401 when a PUT token is used for r2s3compat GET (cross-method rejection)", async () => {
    const createRes = await SELF.fetch("http://localhost/api/storage-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "Method Check Backend 2",
        type: "r2-s3compat",
        config: {
          endpoint: "https://test-account.r2.cloudflarestorage.com",
          accessKeyId: "k",
          secretAccessKey: "s",
          bucket: "b",
          region: "auto",
        },
      }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const resolveRes = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: `r2-s3compat://${id}/file.parquet`, method: "PUT" }],
      }),
    });
    const resolveData = (await resolveRes.json()) as { urls: Record<string, string> };
    const writeUrl = resolveData.urls[`r2-s3compat://${id}/file.parquet`] ?? "";

    const getRes = await SELF.fetch(writeUrl);
    expect(getRes.status).toBe(401);
  });
});

describe("token security", () => {
  it("r2-bound PUT token key is scoped to the authenticated user", async () => {
    const resolveRes = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: "r2://data-shack-storage/my-file.parquet", method: "PUT" }],
      }),
    });
    const data = (await resolveRes.json()) as { urls: Record<string, string> };
    const writeUrl = data.urls["r2://data-shack-storage/my-file.parquet"] ?? "";

    const token = writeUrl.split("/api/storage/obj/")[1] ?? "";
    const parts = token.split(".");
    expect(parts.length).toBe(3);
    const payloadJson = atob(
      (parts[1] ?? "")
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil((parts[1] ?? "").length / 4) * 4, "="),
    );
    const payload = JSON.parse(payloadJson) as { k: string; method: string };
    expect(payload.k).toMatch(/^users\/usr_test\//);
    expect(payload.method).toBe("PUT");
  });

  it("r2-bound GET token embeds method GET", async () => {
    const resolveRes = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        uris: [{ uri: "r2://data-shack-storage/my-file.parquet", method: "GET" }],
      }),
    });
    const data = (await resolveRes.json()) as { urls: Record<string, string> };
    const readUrl = data.urls["r2://data-shack-storage/my-file.parquet"] ?? "";

    const token = readUrl.split("/api/storage/obj/")[1] ?? "";
    const parts = token.split(".");
    const payloadJson = atob(
      (parts[1] ?? "")
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil((parts[1] ?? "").length / 4) * 4, "="),
    );
    const payload = JSON.parse(payloadJson) as { method: string };
    expect(payload.method).toBe("GET");
  });
});
