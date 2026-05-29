import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };

// Fake AWS Sig V4 Authorization header using a given accessKeyId
function fakeS3Auth(accessKeyId: string): string {
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20240101/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fakesig`;
}

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
});

// ── Credential vending ────────────────────────────────────────────────────

describe("POST /api/storage/proxy-credentials", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "r2-bound", pathPrefix: "" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when backend is missing", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ pathPrefix: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when pathPrefix is missing", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: "r2-bound" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown storage backend", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: "sb_nonexistent", pathPrefix: "" }),
    });
    expect(res.status).toBe(404);
  });

  it("vends a credential for r2-bound by name", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: "r2-bound", pathPrefix: "" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      accessKeyId: string;
      secret: string;
      endpoint: string;
      region: string;
      bucket: string;
    };
    expect(data.accessKeyId).toMatch(/^pxy_/);
    expect(typeof data.secret).toBe("string");
    expect(data.endpoint).toContain("/api/storage/s3proxy");
    expect(data.region).toBe("auto");
    expect(data.bucket).toBe("r2-bound");
  });

  it("accepts 'data-shack' as an alias for r2-bound", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: "data-shack", pathPrefix: "" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { bucket: string };
    // bucket preserves the alias so DuckDB scopes its secret to s3://data-shack/
    expect(data.bucket).toBe("data-shack");
  });

  it("vends a credential for an r2-s3compat backend resolved by name", async () => {
    const createRes = await SELF.fetch("http://localhost/api/storage-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "proxy-test-backend",
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

    // Resolve by name — bucket should be the name, not the id
    const byName = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: "proxy-test-backend", pathPrefix: "" }),
    });
    expect(byName.status).toBe(200);
    const nameData = (await byName.json()) as { bucket: string; accessKeyId: string };
    expect(nameData.bucket).toBe("proxy-test-backend");
    expect(nameData.accessKeyId).toMatch(/^pxy_/);

    // Resolve by id (backwards compat) — bucket should be the id
    const byId = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: id, pathPrefix: "" }),
    });
    expect(byId.status).toBe(200);
    const idData = (await byId.json()) as { bucket: string };
    expect(idData.bucket).toBe(id);
  });

  it("credential is stored in KV with backendId and backendName", async () => {
    const vendRes = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: "r2-bound", pathPrefix: "test/" }),
    });
    const { accessKeyId } = (await vendRes.json()) as { accessKeyId: string };

    const stored = (await env.PROXY_CREDS_KV.get(accessKeyId, "json")) as {
      userId: string;
      backendId: string;
      backendName: string;
      pathPrefix: string;
    } | null;
    expect(stored).not.toBeNull();
    expect(stored?.userId).toBe("usr_test");
    expect(stored?.backendId).toBe("r2-bound");
    expect(stored?.backendName).toBe("r2-bound");
    expect(stored?.pathPrefix).toBe("test/");
  });

  it("accepts deprecated backendId field for backwards compatibility", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: "r2-bound", pathPrefix: "" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { bucket: string };
    expect(data.bucket).toBe("r2-bound");
  });
});

// ── S3 proxy auth ─────────────────────────────────────────────────────────

describe("S3 proxy auth enforcement", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/s3proxy/r2-bound/file.parquet");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown credential", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/s3proxy/r2-bound/file.parquet", {
      headers: { Authorization: fakeS3Auth("pxy_unknown") },
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when bucket does not match backendName", async () => {
    const vendRes = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: "r2-bound", pathPrefix: "" }),
    });
    const { accessKeyId } = (await vendRes.json()) as { accessKeyId: string };

    const res = await SELF.fetch("http://localhost/api/storage/s3proxy/wrong-bucket/file.parquet", {
      headers: { Authorization: fakeS3Auth(accessKeyId) },
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 when key is outside pathPrefix", async () => {
    const vendRes = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: "r2-bound", pathPrefix: "allowed/" }),
    });
    const { accessKeyId } = (await vendRes.json()) as { accessKeyId: string };

    const res = await SELF.fetch(
      "http://localhost/api/storage/s3proxy/r2-bound/other/file.parquet",
      { headers: { Authorization: fakeS3Auth(accessKeyId) } },
    );
    expect(res.status).toBe(403);
  });
});

// ── r2-bound GET/PUT ──────────────────────────────────────────────────────

describe("S3 proxy r2-bound GET/PUT", () => {
  async function vendR2Cred(pathPrefix = "") {
    const res = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: "r2-bound", pathPrefix }),
    });
    return (await res.json()) as { accessKeyId: string };
  }

  it("returns 404 for a missing r2 object", async () => {
    const { accessKeyId } = await vendR2Cred();
    const res = await SELF.fetch(
      "http://localhost/api/storage/s3proxy/r2-bound/no-such-file.parquet",
      { headers: { Authorization: fakeS3Auth(accessKeyId) } },
    );
    expect(res.status).toBe(404);
  });

  it("PUTs an object and GETs it back", async () => {
    const { accessKeyId } = await vendR2Cred();
    const content = "hello proxy";

    const putRes = await SELF.fetch(
      "http://localhost/api/storage/s3proxy/r2-bound/proxy-write-test.txt",
      {
        method: "PUT",
        headers: {
          Authorization: fakeS3Auth(accessKeyId),
          "Content-Type": "text/plain",
        },
        body: content,
      },
    );
    expect(putRes.status).toBe(204);
    // Verify PUT returns ETag
    expect(putRes.headers.get("ETag")).toBeTruthy();
    const etag = putRes.headers.get("ETag");

    // Verify stored under user-scoped R2 key
    const stored = await env.R2.get("users/usr_test/proxy-write-test.txt");
    expect(stored).not.toBeNull();
    expect(await stored!.text()).toBe(content);

    // GET via proxy
    const getRes = await SELF.fetch(
      "http://localhost/api/storage/s3proxy/r2-bound/proxy-write-test.txt",
      { headers: { Authorization: fakeS3Auth(accessKeyId) } },
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(content);
    // Verify CORS headers are present on GET response
    expect(getRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // Verify GET returns the same ETag
    expect(getRes.headers.get("ETag")).toBe(etag);
  });

  it("scopes writes to the authenticated user", async () => {
    const { accessKeyId } = await vendR2Cred();
    await SELF.fetch("http://localhost/api/storage/s3proxy/r2-bound/user-scope-test.txt", {
      method: "PUT",
      headers: { Authorization: fakeS3Auth(accessKeyId), "Content-Type": "text/plain" },
      body: "user data",
    });
    // Must be stored under users/usr_test/, not at root
    const wrongKey = await env.R2.get("user-scope-test.txt");
    expect(wrongKey).toBeNull();
    const rightKey = await env.R2.get("users/usr_test/user-scope-test.txt");
    expect(rightKey).not.toBeNull();
  });
});

// ── r2-bound LIST ─────────────────────────────────────────────────────────

describe("S3 proxy r2-bound LIST", () => {
  it("returns S3 ListBucketResult XML", async () => {
    // Seed a file
    await env.R2.put("users/usr_test/list-test/file.parquet", "data");

    const vendRes = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: "r2-bound", pathPrefix: "" }),
    });
    const { accessKeyId } = (await vendRes.json()) as { accessKeyId: string };

    const res = await SELF.fetch(
      "http://localhost/api/storage/s3proxy/r2-bound?list-type=2&prefix=list-test/",
      { headers: { Authorization: fakeS3Auth(accessKeyId) } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/xml");
    const xml = await res.text();
    expect(xml).toContain("<ListBucketResult");
    expect(xml).toContain("<Key>list-test/file.parquet</Key>");
  });

  it("returns 403 when list prefix is outside pathPrefix", async () => {
    const vendRes = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ backend: "r2-bound", pathPrefix: "allowed/" }),
    });
    const { accessKeyId } = (await vendRes.json()) as { accessKeyId: string };

    const res = await SELF.fetch(
      "http://localhost/api/storage/s3proxy/r2-bound?list-type=2&prefix=other/",
      { headers: { Authorization: fakeS3Auth(accessKeyId) } },
    );
    expect(res.status).toBe(403);
  });
});

// ── r2-bound OPTIONS ──────────────────────────────────────────────────────

describe("S3 proxy r2-bound OPTIONS", () => {
  it("returns S3-compatible CORS headers without authentication", async () => {
    const res = await SELF.fetch("http://localhost/api/storage/s3proxy/r2-bound/test.parquet", {
      method: "OPTIONS",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, PUT, DELETE, HEAD, OPTIONS",
    );
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Host-Override");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
    expect(res.headers.get("Allow")).toBe("GET, POST, PUT, DELETE, HEAD, OPTIONS");
    expect(await res.text()).toBe(""); // No body
  });

  it("OPTIONS works even with invalid credentials (CORS preflight)", async () => {
    const res = await SELF.fetch(
      "http://localhost/api/storage/s3proxy/r2-bound/any/path/test.parquet",
      {
        method: "OPTIONS",
        headers: { Authorization: fakeS3Auth("pxy_invalid_credential") },
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
