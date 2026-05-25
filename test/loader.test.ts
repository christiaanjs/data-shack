import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { encryptConfig } from "../src/crypto.ts";
import type { LoadJob } from "../src/db/load-jobs.ts";
import { runHttpLoadJob } from "../src/loaders/http.ts";

const USER_ID = "usr_loader_test";
const BODY = JSON.stringify([{ id: 1, name: "Test Account" }]);
const BODY_LENGTH = String(new TextEncoder().encode(BODY).byteLength);

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind(USER_ID, "loader@example.com", Date.now())
    .run();
});

async function insertCredential(): Promise<string> {
  const id = `cred_${crypto.randomUUID().replace(/-/g, "")}`;
  const config = { baseUrl: "http://upstream.example.com", headers: {}, variables: {} };
  await env.DB.prepare(
    "INSERT INTO credentials (id, user_id, name, type, encrypted_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      USER_ID,
      "Test Cred",
      "http",
      await encryptConfig(JSON.stringify(config), env.JWT_SECRET),
      Date.now(),
      Date.now(),
    )
    .run();
  return id;
}

async function insertR2BoundBackend(): Promise<string> {
  const id = `sb_${crypto.randomUUID().replace(/-/g, "")}`;
  const config = { bucket: "data-shack-storage" };
  await env.DB.prepare(
    "INSERT INTO storage_backends (id, user_id, name, type, encrypted_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      USER_ID,
      `Test R2 ${id}`,
      "r2-bound",
      await encryptConfig(JSON.stringify(config), env.JWT_SECRET),
      Date.now(),
      Date.now(),
    )
    .run();
  return id;
}

async function insertR2S3CompatBackend(): Promise<string> {
  const id = `sb_${crypto.randomUUID().replace(/-/g, "")}`;
  const config = {
    endpoint: "https://test-account.r2.cloudflarestorage.com",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    bucket: "test-bucket",
    region: "auto",
  };
  await env.DB.prepare(
    "INSERT INTO storage_backends (id, user_id, name, type, encrypted_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      USER_ID,
      `Test S3 ${id}`,
      "r2-s3compat",
      await encryptConfig(JSON.stringify(config), env.JWT_SECRET),
      Date.now(),
      Date.now(),
    )
    .run();
  return id;
}

function makeJob(credId: string, backendId: string, tableName: string, tablePath = ""): LoadJob {
  return {
    id: `lj_${crypto.randomUUID().replace(/-/g, "")}`,
    user_id: USER_ID,
    name: "Test Job",
    credential_id: credId,
    storage_backend_id: backendId,
    table_name: tableName,
    table_path: tablePath,
    http_path: "/accounts",
    http_method: "GET",
    format: "json",
    cron_schedule: "0 * * * *",
    next_run_at: null,
    last_run_at: null,
    last_error: null,
    enabled: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
    date_range_config: null,
    pagination_config: null,
    source_type: "http",
    source_config: null,
  };
}

// Wraps a test with a mocked global fetch.
// Upstream calls (upstream.example.com) return BODY with or without Content-Length.
// S3 PUT calls (r2.cloudflarestorage.com) return 200 and record the request headers.
function withMockedFetch(
  withContentLength: boolean,
  fn: (getCapturedPutHeaders: () => Headers | null) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const savedFetch = globalThis.fetch;
    let capturedPutHeaders: Headers | null = null;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;

      if (url.includes("r2.cloudflarestorage.com")) {
        capturedPutHeaders = new Headers(init?.headers as HeadersInit);
        return new Response("", { status: 200 });
      }

      // upstream call
      const headers: Record<string, string> = {};
      if (withContentLength) headers["Content-Length"] = BODY_LENGTH;
      return new Response(BODY, { status: 200, headers });
    };

    try {
      await fn(() => capturedPutHeaders);
    } finally {
      globalThis.fetch = savedFetch;
    }
  };
}

// ── r2-bound ─────────────────────────────────────────────────────────────────

describe("runHttpLoadJob r2-bound", () => {
  let credId: string;
  let backendId: string;

  beforeAll(async () => {
    credId = await insertCredential();
    backendId = await insertR2BoundBackend();
  });

  it(
    "writes body to R2 and returns r2:// uri when upstream provides Content-Length",
    withMockedFetch(true, async () => {
      const job = makeJob(credId, backendId, "r2_cl_tbl");
      const { uri } = await runHttpLoadJob(job, env);

      expect(uri).toMatch(/^r2:\/\/data-shack-storage\//);
      expect(uri).not.toContain(USER_ID);
      // resolveUri will prepend users/${userId}/ — verify the actual R2 key
      const relPath = uri.replace("r2://data-shack-storage/", "");
      const key = `users/${USER_ID}/${relPath}`;
      const obj = await env.R2.get(key);
      expect(obj).not.toBeNull();
      expect(await obj!.text()).toBe(BODY);
    }),
  );

  it(
    "writes body to R2 and returns r2:// uri when upstream omits Content-Length",
    withMockedFetch(false, async () => {
      const job = makeJob(credId, backendId, "r2_nocl_tbl");
      const { uri } = await runHttpLoadJob(job, env);

      expect(uri).toMatch(/^r2:\/\/data-shack-storage\//);
      expect(uri).not.toContain(USER_ID);
      // resolveUri will prepend users/${userId}/ — verify the actual R2 key
      const relPath = uri.replace("r2://data-shack-storage/", "");
      const key = `users/${USER_ID}/${relPath}`;
      const obj = await env.R2.get(key);
      expect(obj).not.toBeNull();
      expect(await obj!.text()).toBe(BODY);
    }),
  );

  it(
    "uses table_path as storage directory when set",
    withMockedFetch(true, async () => {
      const job = makeJob(credId, backendId, "accounts", "financial/accounts");
      const { uri } = await runHttpLoadJob(job, env);

      expect(uri).toContain("/financial/accounts/");
      expect(uri).not.toContain(USER_ID);
    }),
  );
});

// ── r2-s3compat ───────────────────────────────────────────────────────────────

describe("runHttpLoadJob r2-s3compat", () => {
  let credId: string;
  let backendId: string;

  beforeAll(async () => {
    credId = await insertCredential();
    backendId = await insertR2S3CompatBackend();
  });

  it(
    "sends Content-Length on S3 PUT when upstream provides it (streaming path)",
    withMockedFetch(true, async (getCaptured) => {
      const job = makeJob(credId, backendId, "s3_cl_tbl");
      const { uri } = await runHttpLoadJob(job, env);

      expect(uri).toMatch(/^r2-s3compat:\/\//);
      const headers = getCaptured();
      expect(headers).not.toBeNull();
      expect(headers!.get("Content-Length")).toBe(BODY_LENGTH);
    }),
  );

  it(
    "sends Content-Length on S3 PUT when upstream omits it (buffering path)",
    withMockedFetch(false, async (getCaptured) => {
      const job = makeJob(credId, backendId, "s3_nocl_tbl");
      const { uri } = await runHttpLoadJob(job, env);

      expect(uri).toMatch(/^r2-s3compat:\/\//);
      const headers = getCaptured();
      expect(headers).not.toBeNull();
      expect(headers!.get("Content-Length")).toBe(BODY_LENGTH);
    }),
  );

  it(
    "uses table_path as key prefix (no user_id) when set",
    withMockedFetch(true, async () => {
      const job = makeJob(credId, backendId, "accounts", "financial/accounts");
      const { uri } = await runHttpLoadJob(job, env);

      expect(uri).toMatch(/^r2-s3compat:\/\/sb_/);
      expect(uri).toContain("/financial/accounts/");
      expect(uri).not.toContain(USER_ID);
    }),
  );
});

// ── date range config ─────────────────────────────────────────────────────────

describe("runHttpLoadJob date_range_config", () => {
  let credId: string;
  let backendId: string;

  beforeAll(async () => {
    credId = await insertCredential();
    backendId = await insertR2BoundBackend();
  });

  it("adds date params to upstream URL in iso_date format", async () => {
    const savedFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return new Response(BODY, { status: 200, headers: { "Content-Length": BODY_LENGTH } });
    };
    try {
      const job = {
        ...makeJob(credId, backendId, "txns_date_iso"),
        date_range_config: JSON.stringify({
          param_from: "start",
          param_to: "end",
          format: "iso_date",
          lookback_days: 7,
        }),
      };
      await runHttpLoadJob(job, env);
      const url = new URL(capturedUrl);
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(end!).getTime()).toBeGreaterThan(new Date(start!).getTime());
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("adds date params in unix format", async () => {
    const savedFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return new Response(BODY, { status: 200, headers: { "Content-Length": BODY_LENGTH } });
    };
    try {
      const before = Math.floor(Date.now() / 1000);
      const job = {
        ...makeJob(credId, backendId, "txns_date_unix"),
        date_range_config: JSON.stringify({
          param_from: "from_ts",
          param_to: "to_ts",
          format: "unix",
          lookback_days: 3,
        }),
      };
      await runHttpLoadJob(job, env);
      const after = Math.floor(Date.now() / 1000);
      const url = new URL(capturedUrl);
      const from = Number(url.searchParams.get("from_ts"));
      const to = Number(url.searchParams.get("to_ts"));
      expect(from).toBeGreaterThan(before - 3 * 86400 - 5);
      expect(from).toBeLessThan(before - 3 * 86400 + 5);
      expect(to).toBeGreaterThanOrEqual(before);
      expect(to).toBeLessThanOrEqual(after);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── cursor pagination (r2-bound) ──────────────────────────────────────────────

describe("runHttpLoadJob cursor pagination r2-bound", () => {
  let credId: string;
  let backendId: string;

  beforeAll(async () => {
    credId = await insertCredential();
    backendId = await insertR2BoundBackend();
  });

  it("fetches a single page when no cursor returned and writes all items as ndjson", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ items: [{ id: 1 }, { id: 2 }], cursor: {} }), { status: 200 });
    try {
      const job = {
        ...makeJob(credId, backendId, "pg_r2_single"),
        format: "ndjson",
        pagination_config: JSON.stringify({
          type: "cursor",
          cursor_param: "cursor",
          cursor_path: "cursor.next",
          data_path: "items",
        }),
      };
      const { uri } = await runHttpLoadJob(job, env);
      const relPath = uri.replace("r2://data-shack-storage/", "");
      const obj = await env.R2.get(`users/${USER_ID}/${relPath}`);
      expect(obj).not.toBeNull();
      const text = await obj!.text();
      expect(text).toContain('{"id":1}');
      expect(text).toContain('{"id":2}');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("follows cursor across multiple pages and writes all items", async () => {
    const savedFetch = globalThis.fetch;
    let callCount = 0;
    const capturedUrls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      capturedUrls.push(url);
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ items: [{ id: 1 }], cursor: { next: "tok2" } }), {
          status: 200,
        });
      }
      if (callCount === 2) {
        return new Response(JSON.stringify({ items: [{ id: 2 }], cursor: { next: "tok3" } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ items: [{ id: 3 }], cursor: {} }), { status: 200 });
    };
    try {
      const job = {
        ...makeJob(credId, backendId, "pg_r2_multi"),
        format: "ndjson",
        pagination_config: JSON.stringify({
          type: "cursor",
          cursor_param: "cursor",
          cursor_path: "cursor.next",
          data_path: "items",
        }),
      };
      const { uri } = await runHttpLoadJob(job, env);
      expect(callCount).toBe(3);
      // Second request has cursor param
      expect(capturedUrls[1]).toContain("cursor=tok2");
      expect(capturedUrls[2]).toContain("cursor=tok3");

      const relPath = uri.replace("r2://data-shack-storage/", "");
      const obj = await env.R2.get(`users/${USER_ID}/${relPath}`);
      const text = await obj!.text();
      expect(text).toContain('{"id":1}');
      expect(text).toContain('{"id":2}');
      expect(text).toContain('{"id":3}');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("writes json array output when format is json", async () => {
    const savedFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      const cursor = callCount === 1 ? { next: "tok2" } : {};
      return new Response(JSON.stringify({ items: [{ id: callCount }], cursor }), { status: 200 });
    };
    try {
      const job = {
        ...makeJob(credId, backendId, "pg_r2_json"),
        format: "json",
        pagination_config: JSON.stringify({
          type: "cursor",
          cursor_param: "cursor",
          cursor_path: "cursor.next",
          data_path: "items",
        }),
      };
      const { uri } = await runHttpLoadJob(job, env);
      const relPath = uri.replace("r2://data-shack-storage/", "");
      const obj = await env.R2.get(`users/${USER_ID}/${relPath}`);
      const parsed = JSON.parse(await obj!.text()) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("combines date range params on first request and cursor on subsequent requests", async () => {
    const savedFetch = globalThis.fetch;
    let callCount = 0;
    const capturedUrls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      capturedUrls.push(url);
      callCount++;
      const cursor = callCount === 1 ? { next: "tok2" } : {};
      return new Response(JSON.stringify({ items: [{ id: callCount }], cursor }), { status: 200 });
    };
    try {
      const job = {
        ...makeJob(credId, backendId, "pg_r2_daterange"),
        format: "ndjson",
        date_range_config: JSON.stringify({
          param_from: "start",
          param_to: "end",
          format: "iso_date",
          lookback_days: 7,
        }),
        pagination_config: JSON.stringify({
          type: "cursor",
          cursor_param: "cursor",
          cursor_path: "cursor.next",
          data_path: "items",
        }),
      };
      await runHttpLoadJob(job, env);
      expect(callCount).toBe(2);
      // Both requests have date params
      expect(new URL(capturedUrls[0]!).searchParams.has("start")).toBe(true);
      expect(new URL(capturedUrls[0]!).searchParams.has("end")).toBe(true);
      expect(new URL(capturedUrls[1]!).searchParams.has("start")).toBe(true);
      // Second request also has cursor param
      expect(new URL(capturedUrls[1]!).searchParams.get("cursor")).toBe("tok2");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("throws when pagination exceeds MAX_PAGINATION_PAGES", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ items: [{ id: 1 }], cursor: { next: "always" } }), {
        status: 200,
      });
    try {
      const job = {
        ...makeJob(credId, backendId, "pg_r2_limit"),
        format: "ndjson",
        pagination_config: JSON.stringify({
          type: "cursor",
          cursor_param: "cursor",
          cursor_path: "cursor.next",
          data_path: "items",
        }),
      };
      // Proxy env to override MAX_PAGINATION_PAGES without mutating the original
      const limitedEnv = new Proxy(env, {
        get(target, key) {
          if (key === "MAX_PAGINATION_PAGES") return "2";
          return target[key as keyof typeof env];
        },
      });
      await expect(runHttpLoadJob(job, limitedEnv)).rejects.toThrow("MAX_PAGINATION_PAGES");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── cursor pagination (r2-s3compat multipart) ─────────────────────────────────

describe("runHttpLoadJob cursor pagination r2-s3compat multipart", () => {
  let credId: string;
  let backendId: string;

  beforeAll(async () => {
    credId = await insertCredential();
    backendId = await insertR2S3CompatBackend();
  });

  it("initiates multipart, uploads one part, and completes", async () => {
    const savedFetch = globalThis.fetch;
    const s3Calls: { method: string; url: string }[] = [];
    let upstreamCallCount = 0;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.includes("r2.cloudflarestorage.com")) {
        s3Calls.push({ method, url });
        if (url.includes("?uploads")) {
          return new Response(
            "<InitiateMultipartUploadResult><UploadId>test-uid</UploadId></InitiateMultipartUploadResult>",
            { status: 200 },
          );
        }
        if (url.includes("partNumber")) {
          return new Response("", { status: 200, headers: { ETag: '"etag-1"' } });
        }
        // complete or abort
        return new Response("<CompleteMultipartUploadResult/>", { status: 200 });
      }

      // Upstream pages
      upstreamCallCount++;
      const cursor = upstreamCallCount === 1 ? { next: "tok2" } : {};
      return new Response(JSON.stringify({ items: [{ id: upstreamCallCount }], cursor }), {
        status: 200,
      });
    };

    try {
      const job = {
        ...makeJob(credId, backendId, "pg_s3_multi"),
        format: "ndjson",
        pagination_config: JSON.stringify({
          type: "cursor",
          cursor_param: "cursor",
          cursor_path: "cursor.next",
          data_path: "items",
        }),
      };
      const { uri } = await runHttpLoadJob(job, env);
      expect(uri).toMatch(/^r2-s3compat:\/\//);
      expect(upstreamCallCount).toBe(2);

      const initiates = s3Calls.filter((c) => c.method === "POST" && c.url.includes("?uploads"));
      const parts = s3Calls.filter((c) => c.method === "PUT" && c.url.includes("partNumber"));
      const completes = s3Calls.filter(
        (c) => c.method === "POST" && c.url.includes("uploadId") && !c.url.includes("?uploads"),
      );
      expect(initiates).toHaveLength(1);
      expect(parts.length).toBeGreaterThanOrEqual(1);
      expect(completes).toHaveLength(1);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("aborts multipart upload when upstream returns an error", async () => {
    const savedFetch = globalThis.fetch;
    const s3Calls: { method: string; url: string }[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.includes("r2.cloudflarestorage.com")) {
        s3Calls.push({ method, url });
        if (url.includes("?uploads")) {
          return new Response(
            "<InitiateMultipartUploadResult><UploadId>test-uid-abort</UploadId></InitiateMultipartUploadResult>",
            { status: 200 },
          );
        }
        return new Response("", { status: 200 });
      }

      // Upstream: first page succeeds, second fails
      if (url.includes("cursor=")) {
        return new Response("Service Unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({ items: [{ id: 1 }], cursor: { next: "tok2" } }), {
        status: 200,
      });
    };

    try {
      const job = {
        ...makeJob(credId, backendId, "pg_s3_abort"),
        format: "ndjson",
        pagination_config: JSON.stringify({
          type: "cursor",
          cursor_param: "cursor",
          cursor_path: "cursor.next",
          data_path: "items",
        }),
      };
      await expect(runHttpLoadJob(job, env)).rejects.toThrow("503");

      const aborts = s3Calls.filter((c) => c.method === "DELETE");
      expect(aborts).toHaveLength(1);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
