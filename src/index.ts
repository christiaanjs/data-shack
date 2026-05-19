import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { Hono } from "hono/tiny";
import { authenticate } from "./auth/middleware.ts";
import { oauthRouter } from "./auth/oauth.ts";
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

// ── Root ─────────────────────────────────────────────────────────────────

app.get("/", (c) => c.text("data-shack worker"));

export default app;
