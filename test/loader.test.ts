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
      "Test R2",
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
      "Test S3",
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

      expect(uri).toMatch(new RegExp(`^r2://data-shack-storage/${USER_ID}/`));
      const key = uri.replace("r2://data-shack-storage/", "");
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

      expect(uri).toMatch(new RegExp(`^r2://data-shack-storage/${USER_ID}/`));
      const key = uri.replace("r2://data-shack-storage/", "");
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

      expect(uri).toContain(`/${USER_ID}/financial/accounts/`);
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
