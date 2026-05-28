import { Cron } from "croner";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { Hono } from "hono/tiny";
import { authenticate } from "./auth/middleware.ts";
import { oauthRouter } from "./auth/oauth.ts";
import { CatalogDO } from "./catalog/do.ts";
export { CatalogDO };
import { SessionDO } from "./session/do.ts";
export { SessionDO };
import { decryptConfig, encryptConfig } from "./crypto.ts";
import { deleteDashboard, getDashboard, listDashboards } from "./db/dashboards.ts";
import {
  advanceNextRunAt,
  deleteLoadJob,
  getLoadJob,
  getLoadJobById,
  insertLoadJob,
  listDueLoadJobs,
  listLoadJobs,
  updateLoadJob,
  updateLoadJobOutcome,
} from "./db/load-jobs.ts";
import {
  deleteCredential,
  deleteStorageBackend,
  getCredentialByNameOrId,
  getCredentialConfig,
  getStorageBackendConfig,
  insertCredential,
  insertStorageBackend,
  listCredentials,
  listStorageBackends,
  updateStorageBackend,
} from "./db/settings.ts";
import { decryptHttpConfig, resolveHeaderTemplates } from "./http-config.ts";
import { validateDateRangeConfig, validatePaginationConfig } from "./loaders/config-types.ts";
import { refreshGoogleAccessToken, runGoogleSheetsLoadJob } from "./loaders/google-sheets.ts";
import { runHttpLoadJob } from "./loaders/http.ts";
import { mcpHandler } from "./mcp/server.ts";
import {
  fetchStorageUri,
  inferSnapshotFormat,
  isProxyReadableFormat,
  isProxyReadableUri,
  resolveTableSnapshot,
} from "./storage/catalog-fetch.ts";
import { parseHttpDsUri, signDataSourceToken, verifyDataSourceToken } from "./storage/resolve.ts";
import { storageRouter } from "./storage/router.ts";
import type { Env } from "./types.ts";

function isAllowedOrigin(origin: string, allowedOrigin: string, allowSubdomains: boolean): boolean {
  if (!allowedOrigin || !origin) return false;
  if (origin === allowedOrigin) return true;
  if (!allowSubdomains) return false;
  try {
    const allowed = new URL(allowedOrigin);
    const incoming = new URL(origin);
    return (
      incoming.protocol === allowed.protocol && incoming.hostname.endsWith(`.${allowed.hostname}`)
    );
  } catch {
    return false;
  }
}

type Variables = { userId: string };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", (c, next) => {
  // Skip CORS middleware for s3proxy - it handles its own CORS
  if (c.req.path.startsWith("/api/storage/s3proxy")) {
    return next();
  }
  const env = c.env;
  return cors({
    origin: (origin) =>
      isAllowedOrigin(origin, env.ALLOWED_ORIGIN, env.ALLOW_ORIGIN_SUBDOMAINS === "true")
        ? origin
        : null,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Dev-Token",
      "Range",
      "X-Amz-Date",
      "X-Amz-Content-SHA256",
    ],
    exposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
    maxAge: 86400,
  })(c, next);
});

const requireAuth = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return new Response("Unauthorized", { status: 401 });
  c.set("userId", auth.userId);
  return next();
});

// ── OAuth endpoints ───────────────────────────────────────────────────────

app.route("/", oauthRouter);
app.route("/api/storage", storageRouter);

// ── Authenticated endpoints ───────────────────────────────────────────────

app.get("/me", requireAuth, (c) => c.json({ userId: c.get("userId") }));

// ── HTTP data source helpers ──────────────────────────────────────────────

async function resolveHttpDsUri(
  uri: string,
  env: Env,
  userId: string,
  workerOrigin: string,
): Promise<string> {
  const parsed = parseHttpDsUri(uri);
  if (!parsed) throw new Error(`Invalid http-ds URI: ${uri}`);

  const row = await getCredentialByNameOrId(env.DB, parsed.credentialId, userId);
  if (!row || row.type !== "http")
    throw new Error(`HTTP credential not found: ${parsed.credentialId}`);

  const now = Math.floor(Date.now() / 1000);
  const token = await signDataSourceToken(
    {
      sub: "data-source",
      aud: "data-source",
      iat: now,
      exp: now + 3600,
      jti: crypto.randomUUID(),
      c: row.id,
      p: parsed.path,
      u: userId,
    },
    env.JWT_SECRET,
  );

  return `${workerOrigin}/api/data-sources/obj/${token}`;
}

// Serves HTTP data source responses for DuckDB httpfs — token is the auth mechanism.
app.on(["GET", "HEAD"], "/api/data-sources/obj/:token", async (c) => {
  const token = c.req.param("token");
  const payload = await verifyDataSourceToken(token, c.env.JWT_SECRET);
  if (!payload) return new Response("Unauthorized", { status: 401 });

  const row = await getCredentialConfig(c.env.DB, payload.c, payload.u);
  if (!row || row.type !== "http") return new Response("Not Found", { status: 404 });

  const config = await decryptHttpConfig(row.encrypted_config, c.env.JWT_SECRET);
  if (!config) return new Response("Bad Gateway", { status: 502 });

  // Parse path for pagination params
  const pathUrl = new URL(payload.p, "http://x");
  const pagCursorParam = pathUrl.searchParams.get("_pag_cursor_param");
  const pagCursorPath = pathUrl.searchParams.get("_pag_cursor_path");
  const pagDataPath = pathUrl.searchParams.get("_pag_data_path");
  // Strip _pag_* and build clean path
  pathUrl.searchParams.delete("_pag_cursor_param");
  pathUrl.searchParams.delete("_pag_cursor_path");
  pathUrl.searchParams.delete("_pag_data_path");
  const cleanPath = pathUrl.pathname + (pathUrl.search !== "?" ? pathUrl.search : "");

  const baseUrl = config.baseUrl.replace(/\/$/, "") + cleanPath;
  const resolvedHeaders = resolveHeaderTemplates(config.headers, config.variables);

  function getAtPath(obj: unknown, path: string): unknown {
    return path.split(".").reduce<unknown>((cur, key) => {
      if (cur && typeof cur === "object" && !Array.isArray(cur)) {
        return (cur as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }

  const isPaginated = pagCursorParam && pagCursorPath;
  const isHead = c.req.method === "HEAD";

  if (!isPaginated) {
    let upstream: Response;
    try {
      upstream = await fetch(baseUrl, { method: "GET", headers: resolvedHeaders });
    } catch {
      return new Response("Bad Gateway", { status: 502 });
    }
    return new Response(isHead ? null : upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
      },
    });
  }

  // HEAD requests don't need a body — skip the fetch loop entirely.
  if (isHead) return new Response(null, { headers: { "Content-Type": "application/x-ndjson" } });

  // Paginated: fetch all pages, concatenate as NDJSON
  const maxPages = 45;
  const chunks: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const pageUrl = new URL(baseUrl);
    if (cursor) pageUrl.searchParams.set(pagCursorParam, cursor);
    let res: Response;
    try {
      res = await fetch(pageUrl.toString(), { method: "GET", headers: resolvedHeaders });
    } catch {
      return new Response("Bad Gateway", { status: 502 });
    }
    if (!res.ok) return new Response(`Upstream error: ${res.status}`, { status: 502 });
    const json = (await res.json()) as unknown;
    const items = pagDataPath ? getAtPath(json, pagDataPath) : json;
    if (Array.isArray(items)) {
      for (const item of items) chunks.push(JSON.stringify(item));
    } else if (items !== undefined) {
      chunks.push(JSON.stringify(items));
    }
    const nextCursor = getAtPath(json, pagCursorPath);
    if (!nextCursor || typeof nextCursor !== "string") break;
    cursor = nextCursor;
  }
  return new Response(isHead ? null : chunks.join("\n"), {
    headers: { "Content-Type": "application/x-ndjson" },
  });
});

// Direct proxy for the test UI — requires Bearer JWT auth.
app.post("/api/data-sources/:id/fetch", requireAuth, async (c) => {
  const credentialId = c.req.param("id");
  const body = await c.req.json<{ path?: unknown; method?: unknown }>();

  const row = await getCredentialConfig(c.env.DB, credentialId, c.get("userId"));
  if (!row) return c.json({ error: "not_found", error_description: "Credential not found" }, 404);
  if (row.type !== "http") {
    return c.json(
      {
        error: "invalid_type",
        error_description: "Credential is not an http data source",
      },
      400,
    );
  }

  const config = await decryptHttpConfig(row.encrypted_config, c.env.JWT_SECRET);
  if (!config) {
    return c.json({ error: "config_error", error_description: "Invalid credential config" }, 502);
  }

  const path = typeof body.path === "string" ? body.path : "/";
  const method = typeof body.method === "string" ? body.method.toUpperCase() : "GET";
  const url = config.baseUrl.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`);
  const resolvedHeaders = resolveHeaderTemplates(config.headers, config.variables);

  let upstream: Response;
  try {
    upstream = await fetch(url, { method, headers: resolvedHeaders });
  } catch {
    return c.json({ error: "bad_gateway", error_description: "Upstream request failed" }, 502);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
    },
  });
});

// ── HTTP data source resolve (legacy — still used by http-ds:// URIs in queries) ──

app.post("/api/storage/resolve", requireAuth, async (c) => {
  const body = await c.req.json<{ uris?: unknown }>();
  if (!Array.isArray(body.uris)) return c.json({ error: "uris must be an array" }, 400);
  const workerOrigin = new URL(c.req.url).origin;
  const userId = c.get("userId");
  const urls: Record<string, string> = {};
  for (const item of body.uris) {
    if (typeof item !== "object" || item === null) continue;
    const { uri, method: rawMethod } = item as Record<string, unknown>;
    if (typeof uri !== "string") continue;
    const method: "GET" | "PUT" = rawMethod === "PUT" ? "PUT" : "GET";
    try {
      if (uri.startsWith("http-ds://") && method === "GET") {
        urls[uri] = await resolveHttpDsUri(uri, c.env, userId, workerOrigin);
      }
    } catch (err) {
      console.error(err);
    }
  }
  return c.json({ urls });
});

// ── Credentials endpoints ─────────────────────────────────────────────────

app.get("/api/credentials", requireAuth, async (c) => {
  const credentials = await listCredentials(c.env.DB, c.get("userId"));
  return c.json({ credentials });
});

app.get("/api/credentials/:id", requireAuth, async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id, name, type, encrypted_config FROM credentials WHERE id = ? AND user_id = ?",
  )
    .bind(c.req.param("id"), c.get("userId"))
    .first<{ id: string; name: string; type: string; encrypted_config: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  let config: unknown = {};
  try {
    config = JSON.parse(await decryptConfig(row.encrypted_config, c.env.JWT_SECRET));
  } catch {
    // return empty config if decryption fails rather than erroring
  }
  return c.json({ id: row.id, name: row.name, type: row.type, config });
});

app.post("/api/credentials", requireAuth, async (c) => {
  const body = await c.req.json<{
    name?: unknown;
    type?: unknown;
    config?: unknown;
  }>();
  if (typeof body.name !== "string" || typeof body.type !== "string" || !body.config) {
    return c.json({ error: "name, type, and config are required" }, 400);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(body.name) || body.name.length > 64) {
    return c.json(
      {
        error:
          "name must be 1–64 characters, start with a letter or digit, and contain only letters, digits, '.', '_', or '-'",
      },
      400,
    );
  }
  const encryptedConfig = await encryptConfig(JSON.stringify(body.config), c.env.JWT_SECRET);
  const result = await insertCredential(c.env.DB, {
    userId: c.get("userId"),
    name: body.name,
    type: body.type,
    encryptedConfig,
  });
  return c.json({ id: result.id }, 201);
});

app.delete("/api/credentials/:id", requireAuth, async (c) => {
  const deleted = await deleteCredential(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!deleted) return new Response("Not Found", { status: 404 });
  return new Response(null, { status: 204 });
});

app.post("/api/credentials/:id/test", requireAuth, async (c) => {
  const row = await getCredentialConfig(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.type !== "google-sheets") {
    return c.json({ error: "test not supported for this credential type" }, 400);
  }
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.json({ error: "Google OAuth not configured on this server" }, 503);
  }
  let cred: { refreshToken: string };
  try {
    cred = JSON.parse(await decryptConfig(row.encrypted_config, c.env.JWT_SECRET)) as {
      refreshToken: string;
    };
  } catch {
    return c.json({ ok: false, error: "Failed to decrypt credential" }, 500);
  }
  try {
    await refreshGoogleAccessToken(
      c.env.GOOGLE_CLIENT_ID,
      c.env.GOOGLE_CLIENT_SECRET,
      cred.refreshToken,
    );
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 502);
  }
});

// ── Storage backends endpoints ────────────────────────────────────────────

app.get("/api/storage-backends", requireAuth, async (c) => {
  const backends = await listStorageBackends(c.env.DB, c.get("userId"));
  return c.json({ backends });
});

app.post("/api/storage-backends", requireAuth, async (c) => {
  const body = await c.req.json<{
    name?: unknown;
    type?: unknown;
    config?: unknown;
  }>();
  if (typeof body.name !== "string" || typeof body.type !== "string" || !body.config) {
    return c.json({ error: "name, type, and config are required" }, 400);
  }
  const name = body.name.trim();
  if (!name || name.length > 64 || name.includes("/")) {
    return c.json({ error: "name must be 1–64 characters and must not contain '/'" }, 400);
  }
  if (name === "r2-bound" || name === "data-shack") {
    return c.json({ error: `'${name}' is a reserved backend name` }, 400);
  }
  const encryptedConfig = await encryptConfig(JSON.stringify(body.config), c.env.JWT_SECRET);
  try {
    const result = await insertStorageBackend(c.env.DB, {
      userId: c.get("userId"),
      name,
      type: body.type,
      encryptedConfig,
    });
    return c.json({ id: result.id }, 201);
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      return c.json({ error: "a storage backend with that name already exists" }, 409);
    }
    throw err;
  }
});

app.get("/api/storage-backends/:id", requireAuth, async (c) => {
  const row = await getStorageBackendConfig(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!row) return c.json({ error: "not found" }, 404);
  let config: unknown = {};
  try {
    config = JSON.parse(await decryptConfig(row.encrypted_config, c.env.JWT_SECRET));
  } catch {
    // return empty config if decryption fails rather than erroring
  }
  return c.json({ id: row.id, name: row.name, type: row.type, config });
});

app.patch("/api/storage-backends/:id", requireAuth, async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const opts: { name?: string; encryptedConfig?: string } = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string") return c.json({ error: "name must be a string" }, 400);
    const name = body.name.trim();
    if (!name || name.length > 64 || name.includes("/")) {
      return c.json({ error: "name must be 1–64 characters and must not contain '/'" }, 400);
    }
    if (name === "r2-bound" || name === "data-shack") {
      return c.json({ error: `'${name}' is a reserved backend name` }, 400);
    }
    opts.name = name;
  }

  if (body.config !== undefined) {
    opts.encryptedConfig = await encryptConfig(JSON.stringify(body.config), c.env.JWT_SECRET);
  }

  if (!opts.name && !opts.encryptedConfig) {
    return c.json({ error: "at least one of name or config must be provided" }, 400);
  }

  try {
    const updated = await updateStorageBackend(c.env.DB, c.req.param("id"), c.get("userId"), opts);
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json({ id: c.req.param("id") });
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      return c.json({ error: "a storage backend with that name already exists" }, 409);
    }
    throw err;
  }
});

app.delete("/api/storage-backends/:id", requireAuth, async (c) => {
  const deleted = await deleteStorageBackend(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!deleted) return new Response("Not Found", { status: 404 });
  return new Response(null, { status: 204 });
});

// ── Catalog endpoints ─────────────────────────────────────────────────────

function catalogStub(env: Env, userId: string) {
  return env.CATALOG.get(env.CATALOG.idFromName(userId));
}

function sessionStub(env: Env, userId: string) {
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(userId));
}

app.get("/catalog/tables", requireAuth, async (c) => {
  const res = await catalogStub(c.env, c.get("userId")).fetch("http://do/tables");
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get("/catalog/snapshots-latest", requireAuth, async (c) => {
  const res = await catalogStub(c.env, c.get("userId")).fetch("http://do/snapshots-latest");
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// Catalog WebSocket — auth-gated upgrade forwarded to the Catalog DO.
app.get("/catalog/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426);
  }
  // Auth: prefer Sec-WebSocket-Protocol token, fall back to ?token= query param.
  const wsProtocol = c.req.header("Sec-WebSocket-Protocol");
  const queryToken = new URL(c.req.url).searchParams.get("token");
  const rawToken = wsProtocol ?? queryToken;
  let authRequest = c.req.raw;
  if (rawToken) {
    const augmented = new Headers(c.req.raw.headers);
    if (c.env.DEV_TOKEN && rawToken === c.env.DEV_TOKEN) {
      augmented.set("X-Dev-Token", rawToken);
    } else {
      augmented.set("Authorization", `Bearer ${rawToken}`);
    }
    authRequest = new Request(c.req.url, { headers: augmented, method: c.req.method });
  }
  const auth = await authenticate(authRequest, c.env);
  if (!auth) return new Response("Unauthorized", { status: 401 });

  return catalogStub(c.env, auth.userId).fetch(
    new Request("http://do/ws", {
      headers: c.req.raw.headers,
      cf: (c.req.raw as Request & { cf?: unknown }).cf,
    }),
  );
});

app.get("/catalog/snapshots/:table", requireAuth, async (c) => {
  const table = c.req.param("table");
  const res = await catalogStub(c.env, c.get("userId")).fetch(
    `http://do/snapshots/${encodeURIComponent(table)}`,
  );
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.patch("/catalog/snapshots/:id", requireAuth, async (c) => {
  const snapshotId = c.req.param("id");
  const body = await c.req.json();
  const res = await catalogStub(c.env, c.get("userId")).fetch(
    `http://do/snapshots/${encodeURIComponent(snapshotId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return new Response(res.body, { status: res.status });
});

app.delete("/catalog/tables/:table", requireAuth, async (c) => {
  const table = c.req.param("table");
  const res = await catalogStub(c.env, c.get("userId")).fetch(
    `http://do/tables/${encodeURIComponent(table)}`,
    { method: "DELETE" },
  );
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/catalog/commit", requireAuth, async (c) => {
  const body = await c.req.json();
  const userId = c.get("userId");
  const res = await catalogStub(c.env, userId).fetch("http://do/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const cloned = res.clone();
    c.executionCtx.waitUntil(
      (async () => {
        const data = (await cloned.json()) as { triggeredJobIds?: string[] };
        if (data.triggeredJobIds && data.triggeredJobIds.length > 0) {
          try {
            await sessionStub(c.env, userId).fetch("http://do/dispatch-jobs", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId, jobIds: data.triggeredJobIds }),
            });
          } catch {
            // Best-effort: jobs remain pending and will be dispatched on next browser connect.
          }
        }
      })(),
    );
  }
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Load jobs endpoints ───────────────────────────────────────────────────

const SAFE_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const VALID_HTTP_METHODS = ["GET", "POST"] as const;
const VALID_FORMATS = ["json", "ndjson", "csv", "parquet"] as const;

app.get("/api/load-jobs", requireAuth, async (c) => {
  const jobs = await listLoadJobs(c.env.DB, c.get("userId"));
  return c.json({ jobs });
});

app.post("/api/load-jobs", requireAuth, async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.name !== "string" || !body.name) {
    return c.json({ error: "name is required" }, 400);
  }
  if (typeof body.credential_id !== "string" || !body.credential_id) {
    return c.json({ error: "credential_id is required" }, 400);
  }
  if (typeof body.storage_backend_id !== "string" || !body.storage_backend_id) {
    return c.json({ error: "storage_backend_id is required" }, 400);
  }
  if (typeof body.table_name !== "string" || !SAFE_TABLE_NAME.test(body.table_name)) {
    return c.json({ error: "table_name must match [a-zA-Z_][a-zA-Z0-9_]*" }, 400);
  }
  if (
    body.http_method !== undefined &&
    !VALID_HTTP_METHODS.includes(body.http_method as (typeof VALID_HTTP_METHODS)[number])
  ) {
    return c.json({ error: "http_method must be GET or POST" }, 400);
  }
  if (
    body.format !== undefined &&
    !VALID_FORMATS.includes(body.format as (typeof VALID_FORMATS)[number])
  ) {
    return c.json({ error: "format must be json, ndjson, csv, or parquet" }, 400);
  }
  let dateRangeConfig: string | null = null;
  if (body.date_range_config !== undefined && body.date_range_config !== null) {
    const parsed = validateDateRangeConfig(body.date_range_config);
    if (!parsed) return c.json({ error: "invalid date_range_config" }, 400);
    dateRangeConfig = JSON.stringify(parsed);
  }
  let paginationConfig: string | null = null;
  if (body.pagination_config !== undefined && body.pagination_config !== null) {
    const parsed = validatePaginationConfig(body.pagination_config);
    if (!parsed) return c.json({ error: "invalid pagination_config" }, 400);
    const fmt = typeof body.format === "string" ? body.format : "ndjson";
    if (!["json", "ndjson"].includes(fmt)) {
      return c.json({ error: "pagination_config requires output format json or ndjson" }, 400);
    }
    paginationConfig = JSON.stringify(parsed);
  }

  let job: Awaited<ReturnType<typeof insertLoadJob>>;
  try {
    job = await insertLoadJob(c.env.DB, c.get("userId"), {
      name: body.name,
      credential_id: body.credential_id,
      storage_backend_id: body.storage_backend_id,
      table_name: body.table_name,
      table_path: typeof body.table_path === "string" ? body.table_path : undefined,
      http_path: typeof body.http_path === "string" ? body.http_path : undefined,
      http_method: typeof body.http_method === "string" ? body.http_method : undefined,
      format: typeof body.format === "string" ? body.format : undefined,
      cron_schedule: typeof body.cron_schedule === "string" ? body.cron_schedule : undefined,
      date_range_config: dateRangeConfig,
      pagination_config: paginationConfig,
      source_type: typeof body.source_type === "string" ? body.source_type : undefined,
      source_config:
        body.source_config !== undefined && body.source_config !== null
          ? JSON.stringify(body.source_config)
          : undefined,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid cron_schedule")) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
  return c.json(job, 201);
});

app.patch("/api/load-jobs/:id", requireAuth, async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.name !== "string" || !body.name) {
    return c.json({ error: "name is required" }, 400);
  }
  if (typeof body.credential_id !== "string" || !body.credential_id) {
    return c.json({ error: "credential_id is required" }, 400);
  }
  if (typeof body.storage_backend_id !== "string" || !body.storage_backend_id) {
    return c.json({ error: "storage_backend_id is required" }, 400);
  }
  if (typeof body.table_name !== "string" || !SAFE_TABLE_NAME.test(body.table_name)) {
    return c.json({ error: "table_name must match [a-zA-Z_][a-zA-Z0-9_]*" }, 400);
  }
  if (
    body.http_method !== undefined &&
    !VALID_HTTP_METHODS.includes(body.http_method as (typeof VALID_HTTP_METHODS)[number])
  ) {
    return c.json({ error: "http_method must be GET or POST" }, 400);
  }
  if (
    body.format !== undefined &&
    !VALID_FORMATS.includes(body.format as (typeof VALID_FORMATS)[number])
  ) {
    return c.json({ error: "format must be json, ndjson, csv, or parquet" }, 400);
  }
  let patchDateRangeConfig: string | null = null;
  if (body.date_range_config !== undefined && body.date_range_config !== null) {
    const parsed = validateDateRangeConfig(body.date_range_config);
    if (!parsed) return c.json({ error: "invalid date_range_config" }, 400);
    patchDateRangeConfig = JSON.stringify(parsed);
  }
  let patchPaginationConfig: string | null = null;
  if (body.pagination_config !== undefined && body.pagination_config !== null) {
    const parsed = validatePaginationConfig(body.pagination_config);
    if (!parsed) return c.json({ error: "invalid pagination_config" }, 400);
    const fmt = typeof body.format === "string" ? body.format : "ndjson";
    if (!["json", "ndjson"].includes(fmt)) {
      return c.json({ error: "pagination_config requires output format json or ndjson" }, 400);
    }
    patchPaginationConfig = JSON.stringify(parsed);
  }

  // Fetch the existing job to preserve source_type/source_config when not provided.
  const existingJob = await getLoadJob(c.env.DB, c.get("userId"), c.req.param("id"));
  if (!existingJob) return new Response("Not Found", { status: 404 });

  let updated: Awaited<ReturnType<typeof updateLoadJob>>;
  try {
    updated = await updateLoadJob(c.env.DB, c.get("userId"), c.req.param("id"), {
      name: body.name,
      credential_id: body.credential_id,
      storage_backend_id: body.storage_backend_id,
      table_name: body.table_name,
      table_path: typeof body.table_path === "string" ? body.table_path : "",
      http_path: typeof body.http_path === "string" ? body.http_path : "/",
      http_method: typeof body.http_method === "string" ? body.http_method : "GET",
      format: typeof body.format === "string" ? body.format : "ndjson",
      cron_schedule: typeof body.cron_schedule === "string" ? body.cron_schedule : "0 * * * *",
      date_range_config: patchDateRangeConfig,
      pagination_config: patchPaginationConfig,
      source_type:
        typeof body.source_type === "string" ? body.source_type : existingJob.source_type,
      source_config:
        body.source_config !== undefined && body.source_config !== null
          ? JSON.stringify(body.source_config)
          : existingJob.source_config,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid cron_schedule")) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
  if (!updated) return new Response("Not Found", { status: 404 });
  return c.json(updated);
});

app.delete("/api/load-jobs/:id", requireAuth, async (c) => {
  const deleted = await deleteLoadJob(c.env.DB, c.get("userId"), c.req.param("id"));
  if (!deleted) return new Response("Not Found", { status: 404 });
  return new Response(null, { status: 204 });
});

app.post("/api/load-jobs/:id/trigger", requireAuth, async (c) => {
  const job = await getLoadJob(c.env.DB, c.get("userId"), c.req.param("id"));
  if (!job) return new Response("Not Found", { status: 404 });
  await c.env.LOAD_JOB_QUEUE.send({ jobId: job.id });
  return c.json({ queued: true }, 202);
});

// ── Session WebSocket ─────────────────────────────────────────────────────

app.get("/session/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426);
  }
  // Prefer Sec-WebSocket-Protocol for auth (avoids token appearing in URL logs).
  // Fall back to ?token= query param for backward compatibility.
  const wsProtocol = c.req.header("Sec-WebSocket-Protocol");
  const url = new URL(c.req.url);
  const queryToken = url.searchParams.get("token");
  const rawToken = wsProtocol ?? queryToken;
  let authRequest = c.req.raw;
  if (rawToken) {
    const augmented = new Headers(c.req.raw.headers);
    if (c.env.DEV_TOKEN && rawToken === c.env.DEV_TOKEN) {
      augmented.set("X-Dev-Token", rawToken);
    } else {
      augmented.set("Authorization", `Bearer ${rawToken}`);
    }
    authRequest = new Request(c.req.url, { headers: augmented, method: c.req.method });
  }
  const auth = await authenticate(authRequest, c.env);
  if (!auth) return new Response("Unauthorized", { status: 401 });
  const userId = auth.userId;

  // Strip token from forwarded URL and set X-User-ID for the Session DO.
  const forwardUrl = new URL(c.req.url);
  forwardUrl.searchParams.delete("token");
  const stub = sessionStub(c.env, userId);
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-User-ID", userId);
  return stub.fetch(
    new Request(forwardUrl.toString(), {
      headers,
      cf: (c.req.raw as Request & { cf?: unknown }).cf,
    }),
  );
});

app.get("/session/status", requireAuth, async (c) => {
  const userId = c.get("userId");
  const res = await sessionStub(c.env, userId).fetch("http://do/status", {
    headers: { "X-User-ID": userId },
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── MCP server ────────────────────────────────────────────────────────────

// Streamable HTTP (2025-03-26): GET establishes a server-to-client SSE channel.
// We don't send server-initiated messages, so respond with 405 to signal the
// endpoint exists but this direction isn't used.
app.get("/mcp", (c) => {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
});

app.post("/mcp", requireAuth, async (c) => {
  const userId = c.get("userId");
  return mcpHandler(
    c.req.raw,
    c.env,
    userId,
    sessionStub(c.env, userId),
    catalogStub(c.env, userId),
  );
});

// ── Transform job endpoints (relay to Catalog DO) ─────────────────────────

app.get("/api/transform-jobs", requireAuth, async (c) => {
  const res = await catalogStub(c.env, c.get("userId")).fetch("http://do/jobs");
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/transform-jobs", requireAuth, async (c) => {
  const body = await c.req.json();
  const res = await catalogStub(c.env, c.get("userId")).fetch("http://do/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.delete("/api/transform-jobs/:id", requireAuth, async (c) => {
  const res = await catalogStub(c.env, c.get("userId")).fetch(
    `http://do/jobs/${encodeURIComponent(c.req.param("id"))}`,
    { method: "DELETE" },
  );
  return new Response(res.body, { status: res.status });
});

app.patch("/api/transform-jobs/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const res = await catalogStub(c.env, c.get("userId")).fetch(
    `http://do/jobs/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/transform-jobs/:id/trigger", requireAuth, async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId");
  const res = await catalogStub(c.env, userId).fetch(
    `http://do/jobs/${encodeURIComponent(id)}/trigger`,
    { method: "POST" },
  );
  if (res.ok) {
    c.executionCtx.waitUntil(
      sessionStub(c.env, userId)
        .fetch("http://do/dispatch-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        })
        .catch(() => {}),
    );
  }
  return new Response(res.body, { status: res.status });
});

app.get("/api/triggers", requireAuth, async (c) => {
  const res = await catalogStub(c.env, c.get("userId")).fetch("http://do/triggers");
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/triggers", requireAuth, async (c) => {
  const body = await c.req.json();
  const res = await catalogStub(c.env, c.get("userId")).fetch("http://do/triggers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.delete("/api/triggers/:id", requireAuth, async (c) => {
  const res = await catalogStub(c.env, c.get("userId")).fetch(
    `http://do/triggers/${encodeURIComponent(c.req.param("id"))}`,
    { method: "DELETE" },
  );
  return new Response(res.body, { status: res.status });
});

// ── Dashboard endpoints ───────────────────────────────────────────────────

app.get("/api/dashboards", requireAuth, async (c) => {
  const dashboards = await listDashboards(c.env.DB, c.get("userId"));
  return c.json({ dashboards });
});

app.get("/api/dashboards/:id", requireAuth, async (c) => {
  const row = await getDashboard(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({
    id: row.id,
    title: row.title,
    artifact_source: row.artifact_source,
    queries: JSON.parse(row.queries) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
});

app.delete("/api/dashboards/:id", requireAuth, async (c) => {
  const deleted = await deleteDashboard(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!deleted) return new Response("Not Found", { status: 404 });
  return new Response(null, { status: 204 });
});

// ── Table data proxy (proxy mode for dashboards without DuckDB) ───────────
// Streams raw JSON/NDJSON from storage; format validation and JSON parsing happen client-side.

app.get("/api/table-data/:tableName", requireAuth, async (c) => {
  const userId = c.get("userId");
  const snap = await resolveTableSnapshot(c.req.param("tableName"), catalogStub(c.env, userId));
  if (!snap) return c.json({ error: "Table not found or no snapshot" }, 404);

  const effectiveFormat = inferSnapshotFormat(snap.format, snap.uri);
  if (!isProxyReadableFormat(effectiveFormat)) {
    return c.json(
      {
        error: `${effectiveFormat} format requires DuckDB. Enable DuckDB to query this table.`,
      },
      400,
    );
  }
  if (!isProxyReadableUri(snap.uri)) {
    return c.json({ error: "Storage backend not supported in proxy mode" }, 400);
  }

  const dataRes = await fetchStorageUri(snap.uri, userId, c.env);
  return new Response(dataRes.body, {
    status: dataRes.status,
    headers: {
      "Content-Type": dataRes.headers.get("Content-Type") ?? "application/octet-stream",
    },
  });
});

// ── Root ─────────────────────────────────────────────────────────────────

app.get("/", (c) => c.text("data-shack worker"));

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const now = Date.now();
    const jobs = await listDueLoadJobs(env.DB, now);
    ctx.waitUntil(
      Promise.all(
        jobs.flatMap((j) => {
          const nextRunAt = new Cron(j.cron_schedule).nextRun()?.getTime() ?? null;
          return [
            advanceNextRunAt(env.DB, j.id, nextRunAt, now),
            env.LOAD_JOB_QUEUE.send({ jobId: j.id }),
          ];
        }),
      ),
    );
  },

  async queue(batch: MessageBatch<{ jobId: string }>, env: Env) {
    await Promise.allSettled(
      batch.messages.map(async (msg) => {
        const job = await getLoadJobById(env.DB, msg.body.jobId);
        if (!job) {
          msg.ack();
          return;
        }
        let triggeredJobIds: string[] = [];
        try {
          if (job.source_type === "google-sheets") {
            ({ triggeredJobIds } = await runGoogleSheetsLoadJob(job, env));
          } else {
            ({ triggeredJobIds } = await runHttpLoadJob(job, env));
          }
        } catch (err) {
          const lastError = String(err);
          console.error(`Load job ${job.id} (${job.name}) failed:`, err);
          await updateLoadJobOutcome(env.DB, job.id, Date.now(), job.next_run_at, lastError);
          msg.retry();
          return;
        }
        const nextRunAt = new Cron(job.cron_schedule).nextRun()?.getTime() ?? null;
        await updateLoadJobOutcome(env.DB, job.id, Date.now(), nextRunAt);
        // Dispatch any triggered transform jobs to the connected browser session.
        if (triggeredJobIds.length > 0) {
          try {
            await sessionStub(env, job.user_id).fetch("http://do/dispatch-jobs", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId: job.user_id }),
            });
          } catch {
            // Best-effort; jobs remain pending and dispatch on next browser connect.
          }
        }
        msg.ack();
      }),
    );
  },
};
