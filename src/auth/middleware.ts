import { getPersonalAccessTokenByHash, touchPersonalAccessToken } from "../db/tokens.ts";
import type { Env } from "../types.ts";
import { hashToken, verifyJwt } from "./jwt.ts";

export interface AuthContext {
  userId: string;
}

// A PAT's last_used_at is informational only — refresh it at most once per
// window instead of on every authenticated request, to avoid a D1 write on
// every single REST call / WS connect a token is used for.
const TOKEN_TOUCH_THROTTLE_MS = 5 * 60 * 1000;

const PAT_PREFIX = "dspat_";

export async function authenticate(request: Request, env: Env): Promise<AuthContext | null> {
  if (env.ENABLE_DEV_AUTH === "true") {
    const devToken = request.headers.get("X-Dev-Token");
    if (devToken && devToken === env.DEV_TOKEN) {
      return { userId: env.DEV_USER_ID };
    }
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    if (token.startsWith(PAT_PREFIX)) {
      return authenticateWithPersonalAccessToken(token, env);
    }

    if (env.ENABLE_OAUTH === "true") {
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

async function authenticateWithPersonalAccessToken(
  token: string,
  env: Env,
): Promise<AuthContext | null> {
  const tokenHash = await hashToken(token);
  const row = await getPersonalAccessTokenByHash(env.DB, tokenHash);
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at < Date.now()) return null;

  const now = Date.now();
  if (row.last_used_at === null || now - row.last_used_at > TOKEN_TOUCH_THROTTLE_MS) {
    // Best-effort — never let a touch failure fail authentication.
    touchPersonalAccessToken(env.DB, row.id, now).catch(() => {});
  }

  return { userId: row.user_id };
}
