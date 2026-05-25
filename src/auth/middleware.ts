import type { Env } from "../types.ts";
import { verifyJwt } from "./jwt.ts";

export interface AuthContext {
  userId: string;
}

export async function authenticate(request: Request, env: Env): Promise<AuthContext | null> {
  if (env.ENABLE_DEV_AUTH === "true") {
    const devToken = request.headers.get("X-Dev-Token");
    if (devToken && devToken === env.DEV_TOKEN) {
      return { userId: env.DEV_USER_ID };
    }
  }

  if (env.ENABLE_OAUTH === "true") {
    const authHeader = request.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      try {
        const url = new URL(request.url);
        const issuer = `${url.protocol}//${url.host}`;
        const payload = await verifyJwt(token, env.JWT_SECRET, `${issuer}/mcp`);
        if (payload) return { userId: payload.sub };
      } catch {
        // treat any crypto error as an invalid token
      }
    }
  }

  return null;
}
