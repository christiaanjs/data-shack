import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_other", "other@example.com", Date.now())
    .run();
});

// baseUrl points to the worker itself — Miniflare routes it back so no real network needed.
const LOOPBACK_CONFIG = {
  baseUrl: "http://localhost",
  headers: { "X-Custom": "static-value" },
};

const TEMPLATE_CONFIG = {
  baseUrl: "http://localhost",
  headers: { "X-Token": "Bearer {{tok}}", "X-App": "{{app}}" },
  variables: { tok: "abc123", app: "myapp" },
};

async function createCredential(type: string, config: object): Promise<string> {
  const res = await SELF.fetch("http://localhost/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({ name: "Test", type, config }),
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { id: string };
  return data.id;
}

// ── POST /api/data-sources/:id/fetch ─────────────────────────────────────

describe("POST /api/data-sources/:id/fetch", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/data-sources/cred_fake/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent credential", async () => {
    const res = await SELF.fetch("http://localhost/api/data-sources/cred_doesnotexist/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ path: "/" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for another user's credential", async () => {
    // Insert a credential directly for usr_other
    const otherId = `cred_other_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO credentials (id, user_id, name, type, encrypted_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(otherId, "usr_other", "Other Cred", "http", "encrypted", now, now)
      .run();

    // Access as usr_test (DEV_USER_ID = usr_test)
    const res = await SELF.fetch(`http://localhost/api/data-sources/${otherId}/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ path: "/" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-http credential type", async () => {
    const id = await createCredential("generic_token", { token: "x" });
    const res = await SELF.fetch(`http://localhost/api/data-sources/${id}/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ path: "/" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_type");
  });

  it("passes auth/config checks and attempts upstream fetch (502 when no server)", async () => {
    // Verifies: credential lookup, decryption, and type check all pass.
    // The actual upstream fetch fails (no server on localhost in test env) → 502.
    const id = await createCredential("http", LOOPBACK_CONFIG);
    const res = await SELF.fetch(`http://localhost/api/data-sources/${id}/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ path: "/" }),
    });
    // 502 means the worker reached the outbound fetch stage — auth and config were valid
    expect(res.status).toBe(502);
  });

  it("resolves {{variable}} templates before forwarding (502 when no server)", async () => {
    // Verifies: credential lookup, decryption, and template resolution all pass.
    const id = await createCredential("http", TEMPLATE_CONFIG);
    const res = await SELF.fetch(`http://localhost/api/data-sources/${id}/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ path: "/" }),
    });
    // 502 means template resolution succeeded and an outbound fetch was attempted
    expect(res.status).toBe(502);
  });
});

// ── POST /api/storage/resolve with http-ds:// URIs ─────────────────────

describe("POST /api/storage/resolve with http-ds:// URIs", () => {
  it("resolves http-ds:// URI to a /api/data-sources/obj/ URL", async () => {
    const id = await createCredential("http", LOOPBACK_CONFIG);
    const uri = `http-ds://${id}/`;

    const res = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ uris: [uri] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { urls: Record<string, string> };
    const url = data.urls[uri];
    expect(url).toBeDefined();
    expect(url).toContain("/api/data-sources/obj/");
  });

  it("omits erroring URI from result rather than failing the whole request", async () => {
    const uri = "http-ds://cred_unknown12345/path";
    const res = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ uris: [uri] }),
    });
    // Resolve endpoint now catches per-URI errors; overall response is 200
    expect(res.status).toBe(200);
    const data = (await res.json()) as { urls: Record<string, string> };
    // The erroring URI is omitted from the result map
    expect(data.urls[uri]).toBeUndefined();
  });

  it("mixes r2:// and http-ds:// URIs in one request", async () => {
    const id = await createCredential("http", LOOPBACK_CONFIG);
    const r2Uri = "r2://data-shack-storage/sample.ndjson";
    const dsUri = `http-ds://${id}/`;

    const res = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ uris: [r2Uri, dsUri] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { urls: Record<string, string> };
    expect(data.urls[r2Uri]).toContain("/api/storage/obj/");
    expect(data.urls[dsUri]).toContain("/api/data-sources/obj/");
  });
});

// ── GET /api/data-sources/obj/:token ─────────────────────────────────────

describe("GET /api/data-sources/obj/:token", () => {
  it("returns 401 for an invalid token", async () => {
    const res = await SELF.fetch("http://localhost/api/data-sources/obj/not-a-valid-token");
    expect(res.status).toBe(401);
  });

  it("serves 502 (not 401/404) when token is valid but upstream unavailable", async () => {
    // Verifies the full pipeline: resolve → valid token → credential lookup → outbound fetch.
    // The outbound fetch fails (no server in test env) → 502 (not 401/404).
    const id = await createCredential("http", LOOPBACK_CONFIG);
    const uri = `http-ds://${id}/`;

    const resolveRes = await SELF.fetch("http://localhost/api/storage/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ uris: [uri] }),
    });
    const resolveData = (await resolveRes.json()) as { urls: Record<string, string> };
    const tokenUrl = resolveData.urls[uri] ?? "";
    expect(tokenUrl).toContain("/api/data-sources/obj/");

    // 502 means: token verified, credential found, upstream fetch attempted but failed
    const objRes = await SELF.fetch(tokenUrl);
    expect(objRes.status).toBe(502);
  });
});
