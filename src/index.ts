import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { Hono } from "hono/tiny";
import { authenticate } from "./auth/middleware.ts";
import { oauthRouter } from "./auth/oauth.ts";
import { decryptConfig, encryptConfig } from "./crypto.ts";
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
import {
  parseHttpDsUri,
  parseR2S3CompatUri,
  resolveUri,
  signDataSourceToken,
  signR2S3CompatToken,
  signS3Request,
  verifyDataSourceToken,
  verifyR2S3CompatToken,
  verifyStorageToken,
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
  const env = c.env;
  return cors({
    origin: (origin) =>
      isAllowedOrigin(origin, env.ALLOWED_ORIGIN, env.ALLOW_ORIGIN_SUBDOMAINS === "true")
        ? origin
        : null,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Dev-Token", "Range"],
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

// ── Storage endpoints ─────────────────────────────────────────────────────

app.post("/api/storage/resolve", requireAuth, async (c) => {
  const body = await c.req.json<{ uris?: unknown }>();
  if (!Array.isArray(body.uris)) return c.json({ error: "uris must be an array" }, 400);
  const workerOrigin = new URL(c.req.url).origin;
  const userId = c.get("userId");
  const urls: Record<string, string> = {};
  for (const uri of body.uris) {
    if (typeof uri !== "string") continue;
    try {
      if (uri.startsWith("http-ds://")) {
        urls[uri] = await resolveHttpDsUri(uri, c.env, userId, workerOrigin);
      } else if (uri.startsWith("r2-s3compat://")) {
        urls[uri] = await resolveR2S3CompatUri(uri, c.env, userId, workerOrigin);
      } else {
        urls[uri] = await resolveUri(uri, c.env, userId, workerOrigin);
      }
    } catch (err) {
      console.error(err);
      // Leave this URI out of the result rather than failing the whole request
    }
  }
  return c.json({ urls });
});

app.on(["GET", "HEAD"], "/api/storage/obj/:token", async (c) => {
  const token = c.req.param("token");
  const payload = await verifyStorageToken(token, c.env.JWT_SECRET);
  if (!payload) return new Response("Unauthorized", { status: 401 });

  const isHead = c.req.method === "HEAD";

  if (isHead) {
    const meta = await c.env.R2.head(payload.k);
    if (!meta) return new Response("Not Found", { status: 404 });
    const headers = new Headers();
    headers.set("Content-Length", String(meta.size));
    headers.set("Accept-Ranges", "bytes");
    if (meta.httpMetadata?.contentType) headers.set("Content-Type", meta.httpMetadata.contentType);
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

  const obj = await c.env.R2.get(payload.k, r2Options);
  if (!obj) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  headers.set("Content-Length", String(obj.size));
  headers.set("Accept-Ranges", "bytes");
  if (obj.httpMetadata?.contentType) headers.set("Content-Type", obj.httpMetadata.contentType);

  if (rangeHeader && obj.range) {
    const range = obj.range as { offset: number; length: number };
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`,
    );
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
});

// ── R2 S3-compatible helpers ──────────────────────────────────────────────

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

async function resolveR2S3CompatUri(
  uri: string,
  env: Env,
  userId: string,
  workerOrigin: string,
): Promise<string> {
  const parsed = parseR2S3CompatUri(uri);
  if (!parsed) throw new Error(`Invalid r2-s3compat URI: ${uri}`);

  const row = await getStorageBackendConfig(env.DB, parsed.backendId, userId);
  if (!row || row.type !== "r2-s3compat")
    throw new Error(`r2-s3compat backend not found: ${parsed.backendId}`);

  const config = await decryptR2S3CompatConfig(row.encrypted_config, env.JWT_SECRET);
  if (!config) throw new Error(`Invalid r2-s3compat backend config: ${parsed.backendId}`);

  const now = Math.floor(Date.now() / 1000);
  const token = await signR2S3CompatToken(
    {
      sub: "r2-s3compat",
      aud: "r2-s3compat",
      iat: now,
      exp: now + 3600,
      jti: crypto.randomUUID(),
      d: parsed.backendId,
      k: parsed.key,
      u: userId,
    },
    env.JWT_SECRET,
  );

  return `${workerOrigin}/api/storage/r2s3compat/obj/${token}`;
}

// Proxies R2 S3-compatible reads for DuckDB httpfs — token is the auth mechanism.
app.on(["GET", "HEAD"], "/api/storage/r2s3compat/obj/:token", async (c) => {
  const token = c.req.param("token");
  const payload = await verifyR2S3CompatToken(token, c.env.JWT_SECRET);
  if (!payload) return new Response("Unauthorized", { status: 401 });

  const isHead = c.req.method === "HEAD";

  const row = await getStorageBackendConfig(c.env.DB, payload.d, payload.u);
  if (!row || row.type !== "r2-s3compat") return new Response("Not Found", { status: 404 });

  const config = await decryptR2S3CompatConfig(row.encrypted_config, c.env.JWT_SECRET);
  if (!config) return new Response("Bad Gateway", { status: 502 });

  const { url, headers } = await signS3Request({
    method: isHead ? "HEAD" : "GET",
    endpoint: config.endpoint,
    bucket: config.bucket,
    key: payload.k,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });

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
  responseHeaders.set("Accept-Ranges", "bytes");

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

function resolveHeaderTemplates(
  headers: Record<string, string>,
  variables: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value.replace(/\{\{(\w+)\}\}/g, (_, name) => variables[name] ?? "");
  }
  return resolved;
}

async function decryptHttpConfig(
  encryptedConfig: string,
  jwtSecret: string,
): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
  variables: Record<string, string>;
} | null> {
  try {
    const raw = JSON.parse(await decryptConfig(encryptedConfig, jwtSecret)) as Record<
      string,
      unknown
    >;
    if (typeof raw.baseUrl !== "string") return null;
    let parsed: URL;
    try {
      parsed = new URL(raw.baseUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    const headers: Record<string, string> = {};
    if (typeof raw.headers === "object" && raw.headers !== null) {
      for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
        if (typeof v === "string") headers[k] = v;
      }
    }
    const variables: Record<string, string> = {};
    if (typeof raw.variables === "object" && raw.variables !== null) {
      for (const [k, v] of Object.entries(raw.variables as Record<string, unknown>)) {
        if (typeof v === "string") variables[k] = v;
      }
    }
    return { baseUrl: raw.baseUrl, headers, variables };
  } catch {
    return null;
  }
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
      { error: "invalid_type", error_description: "Credential is not an http data source" },
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

// ── Credentials endpoints ─────────────────────────────────────────────────

app.get("/api/credentials", requireAuth, async (c) => {
  const credentials = await listCredentials(c.env.DB, c.get("userId"));
  return c.json({ credentials });
});

app.post("/api/credentials", requireAuth, async (c) => {
  const body = await c.req.json<{ name?: unknown; type?: unknown; config?: unknown }>();
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
  const body = await c.req.json<{ name?: unknown; type?: unknown; config?: unknown }>();
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

// ── Root ─────────────────────────────────────────────────────────────────

app.get("/", (c) => c.text("data-shack worker"));

export default app;
