/**
 * Functional tests for the S3-compatible proxy using a real AWS Sig V4 client
 * (aws4fetch). Each test vends a proxy credential then drives the proxy via
 * signed S3 requests routed through SELF.fetch() so they hit the Miniflare
 * worker directly.
 */
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";
import { beforeAll, describe, expect, it } from "vitest";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };
const PROXY_BASE = "http://localhost/api/storage/s3proxy";

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
});

// ── helpers ────────────────────────────────────────────────────────────────

async function vendCred(backendId = "r2-bound", pathPrefix = "") {
  const res = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({ backendId, pathPrefix }),
  });
  if (!res.ok) throw new Error(`vend failed: ${res.status}`);
  return res.json() as Promise<{
    accessKeyId: string;
    secret: string;
    endpoint: string;
    region: string;
    bucket: string;
  }>;
}

function makeClient(cred: { accessKeyId: string; secret: string; region: string }) {
  // service: "s3" is required because the endpoint is localhost — aws4fetch
  // cannot infer the service name from a non-AWS hostname.
  return new AwsClient({
    accessKeyId: cred.accessKeyId,
    secretAccessKey: cred.secret,
    region: cred.region,
    service: "s3",
  });
}

// Sign and dispatch via SELF so the request reaches the Miniflare worker.
async function s3Fetch(client: AwsClient, url: string, init?: RequestInit): Promise<Response> {
  const signed = await client.sign(url, init);
  return SELF.fetch(signed);
}

// ── r2-bound: basic CRUD ──────────────────────────────────────────────────

describe("S3 client – r2-bound PUT / GET / HEAD", () => {
  it("PUT returns 204 with ETag, GET returns the body", async () => {
    const cred = await vendCred();
    const client = makeClient(cred);
    const url = `${PROXY_BASE}/r2-bound/sc-test/hello.txt`;
    const body = "hello from s3 client";

    const put = await s3Fetch(client, url, {
      method: "PUT",
      body,
      headers: { "Content-Type": "text/plain" },
    });
    expect(put.status).toBe(204);
    expect(put.headers.get("ETag")).toBeTruthy();
    const etag = put.headers.get("ETag");

    const get = await s3Fetch(client, url);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(body);
    expect(get.headers.get("Content-Type")).toBe("text/plain");
    expect(get.headers.get("ETag")).toBe(etag);
    expect(get.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("HEAD returns metadata without a body", async () => {
    const cred = await vendCred();
    const client = makeClient(cred);
    const url = `${PROXY_BASE}/r2-bound/sc-test/head-target.bin`;
    const content = "head me please";

    await s3Fetch(client, url, {
      method: "PUT",
      body: content,
      headers: { "Content-Type": "application/octet-stream" },
    });

    const head = await s3Fetch(client, url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(content.length));
    expect(head.headers.get("ETag")).toBeTruthy();
    expect(head.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await head.text()).toBe("");
  });

  it("GET returns 404 for a missing object", async () => {
    const cred = await vendCred();
    const client = makeClient(cred);
    const res = await s3Fetch(client, `${PROXY_BASE}/r2-bound/sc-test/no-such-key.parquet`);
    expect(res.status).toBe(404);
  });

  it("object is stored under the user-scoped R2 prefix", async () => {
    const cred = await vendCred();
    const client = makeClient(cred);
    const key = "sc-test/scope-check.txt";
    await s3Fetch(client, `${PROXY_BASE}/r2-bound/${key}`, {
      method: "PUT",
      body: "scoped",
    });

    // Must be under users/usr_test/, not at root
    expect(await env.R2.get(key)).toBeNull();
    const obj = await env.R2.get(`users/usr_test/${key}`);
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe("scoped");
  });
});

// ── r2-bound: range reads ─────────────────────────────────────────────────

describe("S3 client – r2-bound range GET", () => {
  it("returns partial content for a byte-range request", async () => {
    const cred = await vendCred();
    const client = makeClient(cred);
    const url = `${PROXY_BASE}/r2-bound/sc-test/range-source.txt`;
    const content = "0123456789abcdef";

    await s3Fetch(client, url, { method: "PUT", body: content });

    const range = await s3Fetch(client, url, {
      headers: { Range: "bytes=4-7" },
    });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("4567");
    expect(range.headers.get("Content-Range")).toMatch(/^bytes 4-7\//);
    expect(range.headers.get("Accept-Ranges")).toBe("bytes");
  });
});

// ── r2-bound: LIST (ListObjectsV2) ────────────────────────────────────────

describe("S3 client – r2-bound LIST", () => {
  it("lists objects matching a prefix", async () => {
    await env.R2.put("users/usr_test/sc-list/alpha.parquet", "data-a");
    await env.R2.put("users/usr_test/sc-list/beta.parquet", "data-b");
    await env.R2.put("users/usr_test/sc-list/gamma.parquet", "data-c");

    const cred = await vendCred();
    const client = makeClient(cred);

    const res = await s3Fetch(client, `${PROXY_BASE}/r2-bound?list-type=2&prefix=sc-list/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/xml");
    const xml = await res.text();
    expect(xml).toContain("<ListBucketResult");
    expect(xml).toContain("<Key>sc-list/alpha.parquet</Key>");
    expect(xml).toContain("<Key>sc-list/beta.parquet</Key>");
    expect(xml).toContain("<Key>sc-list/gamma.parquet</Key>");
  });

  it("returns an empty list for a prefix with no matching objects", async () => {
    const cred = await vendCred();
    const client = makeClient(cred);
    const res = await s3Fetch(client, `${PROXY_BASE}/r2-bound?list-type=2&prefix=sc-empty-prefix/`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<ListBucketResult");
    expect(xml).not.toContain("<Key>");
  });
});

// ── path-prefix enforcement ───────────────────────────────────────────────

describe("S3 client – path-prefix scoping", () => {
  it("allows writes and reads inside the prefix", async () => {
    const cred = await vendCred("r2-bound", "allowed/");
    const client = makeClient(cred);

    const put = await s3Fetch(client, `${PROXY_BASE}/r2-bound/allowed/data.txt`, {
      method: "PUT",
      body: "within prefix",
    });
    expect(put.status).toBe(204);

    const get = await s3Fetch(client, `${PROXY_BASE}/r2-bound/allowed/data.txt`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("within prefix");
  });

  it("blocks writes outside the prefix", async () => {
    const cred = await vendCred("r2-bound", "allowed/");
    const client = makeClient(cred);

    const res = await s3Fetch(client, `${PROXY_BASE}/r2-bound/other/data.txt`, {
      method: "PUT",
      body: "blocked",
    });
    expect(res.status).toBe(403);
  });

  it("blocks reads outside the prefix", async () => {
    const cred = await vendCred("r2-bound", "allowed/");
    const client = makeClient(cred);

    // Seed a file via R2 directly so it exists but is outside the credential's prefix
    await env.R2.put("users/usr_test/other/secret.txt", "secret data");

    const res = await s3Fetch(client, `${PROXY_BASE}/r2-bound/other/secret.txt`);
    expect(res.status).toBe(403);
  });

  it("blocks LIST outside the prefix", async () => {
    const cred = await vendCred("r2-bound", "allowed/");
    const client = makeClient(cred);
    const res = await s3Fetch(client, `${PROXY_BASE}/r2-bound?list-type=2&prefix=other/`);
    expect(res.status).toBe(403);
  });
});

// ── auth failures ─────────────────────────────────────────────────────────

describe("S3 client – auth failures", () => {
  it("returns 401 when the credential has expired (removed from KV)", async () => {
    const cred = await vendCred();
    // Manually delete the credential from KV to simulate expiry
    await env.PROXY_CREDS_KV.delete(cred.accessKeyId);

    const client = makeClient(cred);
    const res = await s3Fetch(client, `${PROXY_BASE}/r2-bound/sc-test/any.txt`);
    expect(res.status).toBe(401);
  });

  it("returns 403 when the bucket does not match the credential backendId", async () => {
    const cred = await vendCred("r2-bound");
    const client = makeClient(cred);
    // The credential was vended for r2-bound but we request a different bucket
    const res = await s3Fetch(client, `${PROXY_BASE}/wrong-backend/some/key.txt`);
    expect(res.status).toBe(403);
  });
});
