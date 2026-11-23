export interface TokenProvider {
  /** Headers to attach to REST calls (proxy-credentials, storage resolve, catalog fetch, etc). */
  getAuthHeaders(): Promise<Record<string, string>>;
  /**
   * Raw token value to send as the WebSocket Sec-WebSocket-Protocol subprotocol.
   * The Worker compares this verbatim against DEV_TOKEN before falling back to
   * treating it as a bearer JWT — see src/index.ts's /session/ws and /catalog/ws
   * routes — so this must be the bare token, never "Bearer <token>".
   */
  getWsToken(): Promise<string>;
}

/**
 * Static shared-secret auth, matching the Worker's ENABLE_DEV_AUTH bypass
 * (src/auth/middleware.ts). Zero refresh logic, zero persistent state — the
 * simplest viable long-lived credential for a single-tenant headless client.
 * Requires the Worker deployment to have ENABLE_DEV_AUTH=true and a DEV_TOKEN/
 * DEV_USER_ID secret dedicated to this container (not reused from local dev).
 */
export class DevTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}

  async getAuthHeaders(): Promise<Record<string, string>> {
    return { "X-Dev-Token": this.token };
  }

  async getWsToken(): Promise<string> {
    return this.token;
  }
}
