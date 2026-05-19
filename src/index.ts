import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { Hono } from "hono/tiny";
import { authenticate } from "./auth/middleware.ts";
import { oauthRouter } from "./auth/oauth.ts";
import { decryptConfig, encryptConfig } from "./crypto.ts";
import {
  deleteCredential,
  deleteStorageBackend,
  insertCredential,
  insertStorageBackend,
  listCredentials,
  listStorageBackends,
} from "./db/settings.ts";
import { resolveUri, verifyStorageToken } from "./storage/resolve.ts";
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
    allowHeaders: ["Content-Type", "Authorization", "X-Dev-Token"],
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
  const urls: Record<string, string> = {};
  for (const uri of body.uris) {
    if (typeof uri !== "string") continue;
    urls[uri] = await resolveUri(uri, c.env, workerOrigin);
  }
  return c.json({ urls });
});

app.get("/api/storage/obj/:token", async (c) => {
  const token = c.req.param("token");
  const payload = await verifyStorageToken(token, c.env.JWT_SECRET);
  if (!payload) return new Response("Unauthorized", { status: 401 });

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
  if (obj.httpMetadata?.contentType) {
    headers.set("Content-Type", obj.httpMetadata.contentType);
  }
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
