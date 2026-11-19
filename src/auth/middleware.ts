import { API_TOKEN_PREFIX, verifyApiToken } from "../db/api-tokens.ts";
import type { Env } from "../types.ts";
import { verifyJwt } from "./jwt.ts";

export interface AuthContext {
  userId: string;
  method: "dev" | "jwt" | "api-token";
}

export async function authenticate(request: Request, env: Env): Promise<AuthContext | null> {
  if (env.ENABLE_DEV_AUTH === "true") {
    const devToken = request.headers.get("X-Dev-Token");
    if (devToken && devToken === env.DEV_TOKEN) {
      return { userId: env.DEV_USER_ID, method: "dev" };
    }
  }

  const authHeader = request.headers.get("Authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // Long-lived API tokens (for CI/CD), checked before JWT parsing.
  if (bearer?.startsWith(API_TOKEN_PREFIX)) {
    const userId = await verifyApiToken(env.DB, bearer);
    return userId ? { userId, method: "api-token" } : null;
  }

  if (env.ENABLE_OAUTH === "true") {
    if (bearer) {
      const token = bearer;
      try {
        const url = new URL(request.url);
        const issuer = `${url.protocol}//${url.host}`;
        const payload = await verifyJwt(token, env.JWT_SECRET, `${issuer}/mcp`);
        if (payload) return { userId: payload.sub, method: "jwt" };
      } catch {
        // treat any crypto error as an invalid token
      }
    }
  }

  return null;
}
