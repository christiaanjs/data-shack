import { readFile, rename, writeFile } from "node:fs/promises";
import { createLogger } from "../logger.js";
import type { TokenProvider } from "./tokenProvider.js";

const logger = createLogger("oauth-token");

// 5-minute refresh buffer, matching frontend/src/auth.ts's isExpiringSoon().
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface CredentialFile {
  clientId: string;
  refreshToken: string;
}

/**
 * Proper per-user OAuth auth for a long-running headless client: exchanges
 * the 30-day refresh token minted by a one-time interactive login (see
 * src/login.ts) for a 1-hour access JWT, refreshing ~5 minutes before expiry.
 *
 * Refresh tokens rotate on every use (src/auth/oauth.ts's claimRefreshToken),
 * so the freshly issued refresh token is persisted back to the same file
 * after every refresh. Losing that file (or losing a write race with another
 * process using the same file) permanently locks this credential out and
 * requires re-running the interactive login — callers should mount
 * `credentialsPath` on durable storage and run exactly one container replica
 * per credential file.
 */
export class OAuthRefreshTokenProvider implements TokenProvider {
  private clientId: string | null = null;
  private refreshToken: string | null = null;
  private accessToken: string | null = null;
  private expiresAt = 0;
  private refreshInFlight: Promise<void> | null = null;

  constructor(
    private readonly workerBase: string,
    private readonly credentialsPath: string,
  ) {}

  private async loadCredentialFile(): Promise<void> {
    if (this.clientId && this.refreshToken) return;
    let raw: string;
    try {
      raw = await readFile(this.credentialsPath, "utf8");
    } catch (err) {
      throw new Error(
        `Could not read OAuth credentials at ${this.credentialsPath} — run \`npm run login\` first ` +
          `to produce this file (see container/README.md). Underlying error: ${String(err)}`,
      );
    }
    const parsed = JSON.parse(raw) as CredentialFile;
    if (!parsed.clientId || !parsed.refreshToken) {
      throw new Error(
        `Credential file at ${this.credentialsPath} is missing clientId/refreshToken`,
      );
    }
    this.clientId = parsed.clientId;
    this.refreshToken = parsed.refreshToken;
  }

  private async persistRefreshToken(): Promise<void> {
    if (!this.clientId || !this.refreshToken) return;
    const payload: CredentialFile = { clientId: this.clientId, refreshToken: this.refreshToken };
    const tmpPath = `${this.credentialsPath}.tmp-${process.pid}`;
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpPath, this.credentialsPath); // atomic on the same filesystem
  }

  private isExpiringSoon(): boolean {
    return !this.accessToken || Date.now() > this.expiresAt - REFRESH_BUFFER_MS;
  }

  private async refresh(): Promise<void> {
    await this.loadCredentialFile();
    if (!this.clientId || !this.refreshToken) throw new Error("OAuth credentials not loaded");

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      client_id: this.clientId,
    });

    const res = await fetch(`${this.workerBase}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (data.error === "invalid_grant") {
        throw new Error(
          "Refresh token was rejected (invalid_grant) — it may have been used elsewhere or revoked. " +
            "Re-run `npm run login` to mint a new one.",
        );
      }
      throw new Error(`Token refresh failed: ${res.status} ${await res.text().catch(() => "")}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    await this.persistRefreshToken();
    logger.info("access token refreshed", { expiresInSec: data.expires_in });
  }

  private async ensureValid(): Promise<string> {
    if (!this.isExpiringSoon() && this.accessToken) return this.accessToken;
    // Coalesce concurrent refreshes (WS connect + a REST call racing on startup).
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    await this.refreshInFlight;
    if (!this.accessToken) throw new Error("Refresh completed without an access token");
    return this.accessToken;
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.ensureValid();
    return { Authorization: `Bearer ${token}` };
  }

  async getWsToken(): Promise<string> {
    return this.ensureValid();
  }
}
