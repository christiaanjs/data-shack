import type { TokenProvider } from "./tokenProvider.ts";

/**
 * Auth via a user-created API token (`dshack auth create-token`, or Settings
 * → API Tokens in the Workbench UI, or `POST /api/tokens` directly — all hit
 * the same endpoint). Unlike DevTokenProvider this is a real per-user,
 * revocable, optionally-expiring credential — and unlike
 * OAuthRefreshTokenProvider it needs no interactive login script or rotating
 * credential file, since an API token is a static bearer token until revoked.
 * `authenticate()` (src/auth/middleware.ts on the Worker) recognizes the
 * `dsk_` prefix and checks it against the `api_tokens` table directly,
 * independent of ENABLE_OAUTH/ENABLE_DEV_AUTH. Note it cannot be used to
 * mint further tokens (`POST /api/tokens` returns 403 for an api-token-
 * authenticated caller) — mint new ones from the CLI, UI, or a JWT session.
 */
export class ApiTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}

  async getAuthHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${this.token}` };
  }

  async getWsToken(): Promise<string> {
    return this.token;
  }
}
