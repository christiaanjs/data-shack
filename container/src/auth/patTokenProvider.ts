import type { TokenProvider } from "./tokenProvider.ts";

/**
 * Auth via a user-created Personal Access Token (Settings → API Tokens in
 * the Workbench UI, or `POST /api/tokens`). Unlike DevTokenProvider this is
 * a real per-user, revocable, optionally-expiring credential — and unlike
 * OAuthRefreshTokenProvider it needs no interactive login script or rotating
 * credential file, since a PAT is a static bearer token until revoked.
 * `authenticate()` (src/auth/middleware.ts on the Worker) recognizes the
 * `dspat_` prefix and checks it against the `personal_access_tokens` table
 * directly, independent of ENABLE_OAUTH/ENABLE_DEV_AUTH.
 */
export class PatTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}

  async getAuthHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${this.token}` };
  }

  async getWsToken(): Promise<string> {
    return this.token;
  }
}
