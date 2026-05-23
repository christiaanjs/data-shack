import { Cron } from "croner";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { Hono } from "hono/tiny";
import { authenticate } from "./auth/middleware.ts";
import { oauthRouter } from "./auth/oauth.ts";
import { CatalogDO } from "./catalog/do.ts";
export { CatalogDO };
import { decryptConfig, encryptConfig } from "./crypto.ts";
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
  getCredentialConfig,
  getStorageBackendConfig,
  insertCredential,
  insertStorageBackend,
  listCredentials,
  listStorageBackends,
} from "./db/settings.ts";
import { decryptHttpConfig, resolveHeaderTemplates } from "./http-config.ts";
import { validateDateRangeConfig, validatePaginationConfig } from "./loaders/config-types.ts";
import { runHttpLoadJob } from "./loaders/http.ts";
import {
  parseHttpDsUri,
  parseS3AuthCredential,
  r2BoundKey,
  signDataSourceToken,
  signS3Request,
  verifyDataSourceToken,
} from "./storage/resolve.ts";
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

// ── Authenticated endpoints ───────────────────────────────────────────────

app.get("/me", requireAuth, (c) => c.json({ userId: c.get("userId") }));

// ── R2 S3-compatible backend config helper ────────────────────────────────

async function decryptR2S3CompatConfig(
  encryptedConfig: string,
  jwtSecret: string,
): Promise<{
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
} | null> {
  try {
    const raw = JSON.parse(await decryptConfig(encryptedConfig, jwtSecret)) as Record<
      string,
      unknown
    >;
    if (
      typeof raw.endpoint !== "string" ||
      typeof raw.accessKeyId !== "string" ||
      typeof raw.secretAccessKey !== "string" ||
      typeof raw.bucket !== "string" ||
      typeof raw.region !== "string"
    )
      return null;
    try {
      const u = new URL(raw.endpoint);
      if (u.protocol !== "https:") return null;
    } catch {
      return null;
    }
    return {
      endpoint: raw.endpoint,
      accessKeyId: raw.accessKeyId,
      secretAccessKey: raw.secretAccessKey,
      bucket: raw.bucket,
      region: raw.region,
    };
  } catch {
    return null;
  }
}

// ── S3 proxy helpers ──────────────────────────────────────────────────────

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildListXml(
  bucket: string,
  prefix: string,
  objects: Array<{ key: string; size: number }>,
): string {
  const contents = objects
    .map((o) => `<Contents><Key>${escXml(o.key)}</Key><Size>${o.size}</Size></Contents>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${escXml(bucket)}</Name><Prefix>${escXml(prefix)}</Prefix><KeyCount>${objects.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
}

// ── Proxy credential vending ──────────────────────────────────────────────

app.post("/api/storage/proxy-credentials", requireAuth, async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.backendId !== "string" || !body.backendId)
    return c.json({ error: "backendId is required" }, 400);
  if (typeof body.pathPrefix !== "string") return c.json({ error: "pathPrefix is required" }, 400);

  const userId = c.get("userId");
  const backendId = body.backendId;
  const pathPrefix = body.pathPrefix;
  const ttlSeconds =
    typeof body.ttlSeconds === "number" && body.ttlSeconds > 0
      ? Math.min(body.ttlSeconds, 3600)
      : 3600;

  if (backendId !== "r2-bound") {
    const row = await getStorageBackendConfig(c.env.DB, backendId, userId);
    if (!row) return c.json({ error: "storage backend not found" }, 404);
  }

  const accessKeyId = `pxy_${crypto.randomUUID().replace(/-/g, "")}`;
  // secret is a dummy value — DuckDB requires it for Sig V4 computation but the proxy
  // never validates the signature. accessKeyId is the effective bearer token.
  const secret = crypto.randomUUID();

  await c.env.PROXY_CREDS_KV.put(accessKeyId, JSON.stringify({ userId, backendId, pathPrefix }), {
    expirationTtl: ttlSeconds,
  });

  // Read-back loop: confirm KV write is visible before returning to the client
  let kvReady = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const check = await c.env.PROXY_CREDS_KV.get(accessKeyId);
    if (check !== null) {
      kvReady = true;
      break;
    }
    if (attempt < 4) await new Promise<void>((r) => setTimeout(r, 50 * (attempt + 1)));
  }
  if (!kvReady) return c.json({ error: "credential store not ready, please retry" }, 502);

  const workerOrigin = new URL(c.req.url).origin;
  return c.json({
    accessKeyId,
    secret,
    endpoint: `${workerOrigin}/api/storage/s3proxy`,
    region: "auto",
    bucket: backendId,
  });
});

// ── S3-compatible proxy (accessKeyId IS the auth — no requireAuth) ────────

function addS3ProxyCorsHeaders(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, PUT, HEAD, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Range, X-Amz-Date, X-Amz-Content-SHA256, X-Host-Override",
  );
  headers.set("Access-Control-Max-Age", "86400");
  headers.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, ETag",
  );
}

app.on(["GET", "HEAD", "PUT", "OPTIONS"], "/api/storage/s3proxy/*", async (c) => {
  const reqUrl = new URL(c.req.url);
  const afterProxy = reqUrl.pathname.slice("/api/storage/s3proxy/".length);
  const slashIdx = afterProxy.indexOf("/");
  const bucket = slashIdx === -1 ? afterProxy : afterProxy.slice(0, slashIdx);
  const key = slashIdx === -1 ? "" : afterProxy.slice(slashIdx + 1);
  const method = c.req.method as "GET" | "HEAD" | "PUT" | "OPTIONS";

  // Handle OPTIONS (CORS preflight) without authentication
  if (method === "OPTIONS") {
    const headers = new Headers();
    addS3ProxyCorsHeaders(headers);
    headers.set("Allow", "GET, PUT, HEAD, OPTIONS");
    return new Response(null, { status: 200, headers });
  }

  const authHeader = c.req.header("Authorization") ?? "";
  const accessKeyId = parseS3AuthCredential(authHeader);
  if (!accessKeyId) {
    const h = new Headers({ "Content-Type": "text/plain" });
    addS3ProxyCorsHeaders(h);
    return new Response("Unauthorized", { status: 401, headers: h });
  }

  // Sig V4 signature is intentionally not verified — accessKeyId lookup in KV is the auth gate.
  // KV lookup with one retry in case of propagation lag
  let credJson = await c.env.PROXY_CREDS_KV.get(accessKeyId);
  if (credJson === null) {
    await new Promise<void>((r) => setTimeout(r, 100));
    credJson = await c.env.PROXY_CREDS_KV.get(accessKeyId);
  }
  if (credJson === null) {
    const h = new Headers({ "Content-Type": "text/plain" });
    addS3ProxyCorsHeaders(h);
    return new Response("Unauthorized", { status: 401, headers: h });
  }

  const cred = JSON.parse(credJson) as {
    userId: string;
    backendId: string;
    pathPrefix: string;
  };

  if (bucket !== cred.backendId) {
    const h = new Headers({ "Content-Type": "text/plain" });
    addS3ProxyCorsHeaders(h);
    return new Response("Forbidden", { status: 403, headers: h });
  }

  // Normalize pathPrefix to end with "/" so "allowed" can't be bypassed with "allowed-extra/..."
  const effectivePrefix =
    cred.pathPrefix !== "" && !cred.pathPrefix.endsWith("/")
      ? `${cred.pathPrefix}/`
      : cred.pathPrefix;
  const isList = method === "GET" && key === "" && reqUrl.searchParams.get("list-type") === "2";
  const checkPath = isList ? (reqUrl.searchParams.get("prefix") ?? "") : key;
  if (!checkPath.startsWith(effectivePrefix)) {
    const h = new Headers({ "Content-Type": "text/plain" });
    addS3ProxyCorsHeaders(h);
    return new Response("Forbidden", { status: 403, headers: h });
  }

  const { userId, backendId } = cred;

  // ── r2-bound ──────────────────────────────────────────────────────────

  if (backendId === "r2-bound") {
    if (isList) {
      const listPrefix = reqUrl.searchParams.get("prefix") ?? "";
      const r2Prefix = r2BoundKey(userId, listPrefix);
      const listed = await c.env.R2.list({ prefix: r2Prefix });
      const userPrefixLen = `users/${userId}/`.length;
      const objects = listed.objects.map((o) => ({
        key: o.key.slice(userPrefixLen),
        size: o.size,
      }));
      const headers = new Headers({ "Content-Type": "application/xml" });
      addS3ProxyCorsHeaders(headers);
      return new Response(buildListXml(bucket, listPrefix, objects), {
        headers,
      });
    }

    const r2Key = r2BoundKey(userId, key);

    if (method === "PUT") {
      const body = c.req.raw.body;
      if (!body) return new Response("Bad Request", { status: 400 });
      const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
      const result = await c.env.R2.put(r2Key, body, {
        httpMetadata: { contentType },
      });
      const headers = new Headers();
      if (result.httpEtag) headers.set("ETag", result.httpEtag);
      addS3ProxyCorsHeaders(headers);
      return new Response(null, { status: 204, headers });
    }

    const isHead = method === "HEAD";
    if (isHead) {
      const meta = await c.env.R2.head(r2Key);
      if (!meta) return new Response("Not Found", { status: 404 });
      const headers = new Headers();
      headers.set("Content-Length", String(meta.size));
      headers.set("Accept-Ranges", "bytes");
      if (meta.httpMetadata?.contentType)
        headers.set("Content-Type", meta.httpMetadata.contentType);
      if (meta.httpEtag) headers.set("ETag", meta.httpEtag);
      addS3ProxyCorsHeaders(headers);
      return new Response(null, { headers });
    }

    const rangeHeader = c.req.header("Range");
    let r2Options: R2GetOptions | undefined;
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
      if (match) {
        const offset = Number(match[1]);
        const endStr = match[2];
        const length = endStr ? Number(endStr) - offset + 1 : undefined;
        r2Options = length !== undefined ? { range: { offset, length } } : { range: { offset } };
      }
    }

    const obj = await c.env.R2.get(r2Key, r2Options);
    if (!obj) return new Response("Not Found", { status: 404 });

    const headers = new Headers();
    headers.set("Accept-Ranges", "bytes");
    if (obj.httpMetadata?.contentType) headers.set("Content-Type", obj.httpMetadata.contentType);
    if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
    addS3ProxyCorsHeaders(headers);

    if (rangeHeader && obj.range) {
      const range = obj.range as { offset: number; length: number };
      headers.set("Content-Length", String(range.length));
      headers.set(
        "Content-Range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`,
      );
      return new Response(obj.body, { status: 206, headers });
    }
    headers.set("Content-Length", String(obj.size));
    return new Response(obj.body, { headers });
  }

  // ── r2-s3compat ───────────────────────────────────────────────────────

  const row = await getStorageBackendConfig(c.env.DB, backendId, userId);
  if (!row || row.type !== "r2-s3compat") return new Response("Not Found", { status: 404 });
  const config = await decryptR2S3CompatConfig(row.encrypted_config, c.env.JWT_SECRET);
  if (!config) return new Response("Bad Gateway", { status: 502 });

  if (isList) {
    const queryParams: Record<string, string> = { "list-type": "2" };
    for (const [k, v] of reqUrl.searchParams) {
      if (k !== "list-type") queryParams[k] = v;
    }
    const { url, headers } = await signS3Request({
      method: "GET",
      endpoint: config.endpoint,
      bucket: config.bucket,
      key: "",
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      queryParams,
    });
    let upstream: Response;
    try {
      upstream = await fetch(url, { method: "GET", headers });
    } catch {
      return new Response("Bad Gateway", { status: 502 });
    }
    const listHeaders = new Headers({ "Content-Type": "application/xml" });
    addS3ProxyCorsHeaders(listHeaders);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: listHeaders,
    });
  }

  const isHead = method === "HEAD";
  const { url, headers } = await signS3Request({
    method: isHead ? "HEAD" : method,
    endpoint: config.endpoint,
    bucket: config.bucket,
    key,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });

  if (method === "PUT") {
    const putBody = c.req.raw.body;
    if (!putBody) return new Response("Bad Request", { status: 400 });
    const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: "PUT",
        headers: { ...headers, "Content-Type": contentType },
        body: putBody,
      });
    } catch {
      return new Response("Bad Gateway", { status: 502 });
    }
    const putHeaders = new Headers();
    const etag = upstream.headers.get("ETag");
    if (etag) putHeaders.set("ETag", etag);
    addS3ProxyCorsHeaders(putHeaders);
    return new Response(null, {
      status: upstream.status,
      headers: putHeaders,
    });
  }

  const rangeHeader = c.req.header("Range");
  if (rangeHeader) headers.Range = rangeHeader;

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: isHead ? "HEAD" : "GET", headers });
  } catch {
    return new Response("Bad Gateway", { status: 502 });
  }

  const responseHeaders = new Headers();
  const contentLength = upstream.headers.get("Content-Length");
  if (contentLength) responseHeaders.set("Content-Length", contentLength);
  const contentType = upstream.headers.get("Content-Type");
  if (contentType) responseHeaders.set("Content-Type", contentType);
  const contentRange = upstream.headers.get("Content-Range");
  if (contentRange) responseHeaders.set("Content-Range", contentRange);
  const etag = upstream.headers.get("ETag");
  if (etag) responseHeaders.set("ETag", etag);
  responseHeaders.set("Accept-Ranges", "bytes");
  addS3ProxyCorsHeaders(responseHeaders);

  return new Response(isHead ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});

// ── HTTP data source helpers ──────────────────────────────────────────────

async function resolveHttpDsUri(
  uri: string,
  env: Env,
  userId: string,
  workerOrigin: string,
): Promise<string> {
  const parsed = parseHttpDsUri(uri);
  if (!parsed) throw new Error(`Invalid http-ds URI: ${uri}`);

  const row = await getCredentialConfig(env.DB, parsed.credentialId, userId);
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
      c: parsed.credentialId,
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

  const url = config.baseUrl.replace(/\/$/, "") + payload.p;
  const resolvedHeaders = resolveHeaderTemplates(config.headers, config.variables);

  // Always GET upstream — many APIs don't support HEAD. Strip body ourselves for HEAD requests.
  let upstream: Response;
  try {
    upstream = await fetch(url, { method: "GET", headers: resolvedHeaders });
  } catch {
    return new Response("Bad Gateway", { status: 502 });
  }

  const isHead = c.req.method === "HEAD";
  return new Response(isHead ? null : upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
    },
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

app.post("/api/credentials", requireAuth, async (c) => {
  const body = await c.req.json<{
    name?: unknown;
    type?: unknown;
    config?: unknown;
  }>();
  if (typeof body.name !== "string" || typeof body.type !== "string" || !body.config) {
    return c.json({ error: "name, type, and config are required" }, 400);
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
  const encryptedConfig = await encryptConfig(JSON.stringify(body.config), c.env.JWT_SECRET);
  const result = await insertStorageBackend(c.env.DB, {
    userId: c.get("userId"),
    name: body.name,
    type: body.type,
    encryptedConfig,
  });
  return c.json({ id: result.id }, 201);
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

app.get("/catalog/tables", requireAuth, async (c) => {
  const res = await catalogStub(c.env, c.get("userId")).fetch("http://do/tables");
  return new Response(res.body, { status: res.status, headers: res.headers });
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
  const res = await catalogStub(c.env, c.get("userId")).fetch("http://do/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
        try {
          await runHttpLoadJob(job, env);
        } catch (err) {
          const lastError = String(err);
          console.error(`Load job ${job.id} (${job.name}) failed:`, err);
          await updateLoadJobOutcome(env.DB, job.id, Date.now(), job.next_run_at, lastError);
          msg.retry();
          return;
        }
        const nextRunAt = new Cron(job.cron_schedule).nextRun()?.getTime() ?? null;
        await updateLoadJobOutcome(env.DB, job.id, Date.now(), nextRunAt);
        msg.ack();
      }),
    );
  },
};
