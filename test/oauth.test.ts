import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signJwt, verifyJwt } from "../src/auth/jwt.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

const TEST_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

async function base64urlEncode(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function computeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64urlEncode(hash);
}

async function register(redirectUri = TEST_REDIRECT_URI): Promise<{ clientId: string }> {
  const res = await SELF.fetch("http://localhost/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  });
  expect([200, 201]).toContain(res.status);
  const data = (await res.json()) as { client_id: string };
  return { clientId: data.client_id };
}

async function insertAuthCode(opts: {
  clientId: string;
  userId: string;
  codeChallenge: string;
  redirectUri?: string;
  expiresAt?: number;
}): Promise<string> {
  const code = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO oauth_codes (code, client_id, user_id, code_challenge, code_challenge_method, redirect_uri, expires_at) VALUES (?, ?, ?, ?, 'S256', ?, ?)",
  )
    .bind(
      code,
      opts.clientId,
      opts.userId,
      opts.codeChallenge,
      opts.redirectUri ?? TEST_REDIRECT_URI,
      opts.expiresAt ?? Date.now() + 60_000,
    )
    .run();
  return code;
}

async function insertRefreshToken(opts: {
  tokenHash: string;
  userId: string;
  clientId: string;
  expiresAt?: number;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO oauth_refresh_tokens (token_hash, user_id, client_id, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(
      opts.tokenHash,
      opts.userId,
      opts.clientId,
      opts.expiresAt ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
    )
    .run();
}

async function hashToken(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function tokenRequest(params: Record<string, string>): Promise<Response> {
  return SELF.fetch("http://localhost/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

function decodeJwtSub(token: string): string {
  const part = token.split(".")[1]!;
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return (JSON.parse(atob(padded)) as { sub: string }).sub;
}

function mockGoogleApis(userId: string, email: string | null, emailVerified = true): void {
  vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ access_token: "google_test_token" }), {
          headers: { "content-type": "application/json" },
        }),
    )
    .mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({ sub: userId, email: email ?? "", email_verified: emailVerified }),
          { headers: { "content-type": "application/json" } },
        ),
    );
}

async function beginAuthorizeFlow(): Promise<{
  clientId: string;
  verifier: string;
  internalState: string;
}> {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const challenge = await computeChallenge(verifier);
  const { clientId } = await register();
  const uri = encodeURIComponent(TEST_REDIRECT_URI);
  const res = await SELF.fetch(
    `http://localhost/authorize/google?response_type=code&client_id=${clientId}&redirect_uri=${uri}&code_challenge=${challenge}&code_challenge_method=S256&state=cs`,
    { redirect: "manual" },
  );
  expect(res.status).toBe(302);
  const internalState = new URL(res.headers.get("Location")!).searchParams.get("state")!;
  return { clientId, verifier, internalState };
}

async function doCallback(internalState: string): Promise<Response> {
  return SELF.fetch(`http://localhost/oauth/callback?code=test-code&state=${internalState}`, {
    redirect: "manual",
  });
}

async function fullOAuthFlow(googleUserId: string, email: string | null, emailVerified = true) {
  const { clientId, verifier, internalState } = await beginAuthorizeFlow();
  mockGoogleApis(googleUserId, email, emailVerified);
  const callbackRes = await doCallback(internalState);
  expect(callbackRes.status).toBe(302);
  const authCode = new URL(callbackRes.headers.get("Location")!).searchParams.get("code")!;

  const tokenRes = await SELF.fetch("http://localhost/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: authCode,
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
  });
  expect(tokenRes.status).toBe(200);
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };
  return { clientId, tokens, sub: decodeJwtSub(tokens.access_token) };
}

// ── JWT helpers ───────────────────────────────────────────────────────────

describe("verifyJwt", () => {
  it("returns payload for a valid token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "usr_1",
      iss: "http://localhost",
      aud: "mcp",
      iat: now,
      exp: now + 3600,
      jti: "j1",
    };
    const token = await signJwt(payload, env.JWT_SECRET);
    const result = await verifyJwt(token, env.JWT_SECRET);
    expect(result?.sub).toBe("usr_1");
    expect(result?.aud).toBe("mcp");
  });

  it("returns null for an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "usr_1",
      iss: "http://localhost",
      aud: "mcp",
      iat: now - 7200,
      exp: now - 3600,
      jti: "j2",
    };
    const token = await signJwt(payload, env.JWT_SECRET);
    expect(await verifyJwt(token, env.JWT_SECRET)).toBeNull();
  });

  it("returns null for a token with wrong signature", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "usr_1",
      iss: "http://localhost",
      aud: "mcp",
      iat: now,
      exp: now + 3600,
      jti: "j3",
    };
    const token = await signJwt(payload, env.JWT_SECRET);
    const tampered = `${token.slice(0, -4)}xxxx`;
    expect(await verifyJwt(tampered, env.JWT_SECRET)).toBeNull();
  });

  it("returns null for a token with missing aud", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "usr_1",
      iss: "http://localhost",
      // aud intentionally omitted
      iat: now,
      exp: now + 3600,
      jti: "j4",
    };
    const token = await signJwt(payload as Parameters<typeof signJwt>[0], env.JWT_SECRET);
    expect(await verifyJwt(token, env.JWT_SECRET)).toBeNull();
  });

  it("returns null for a token with wrong audience when expectedAud is set", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "usr_1",
      iss: "http://localhost",
      aud: "http://localhost/mcp",
      iat: now,
      exp: now + 3600,
      jti: "j5",
    };
    const token = await signJwt(payload, env.JWT_SECRET);
    expect(await verifyJwt(token, env.JWT_SECRET, "http://other/mcp")).toBeNull();
    expect(await verifyJwt(token, env.JWT_SECRET, "http://localhost/mcp")).not.toBeNull();
  });

  it("returns null for malformed base64url input", async () => {
    expect(await verifyJwt("not.a.jwt!!!", env.JWT_SECRET)).toBeNull();
  });

  it("returns null for a token missing exp", async () => {
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=/g, "");
    const body = btoa(JSON.stringify({ sub: "usr_1", aud: "mcp" })).replace(/=/g, "");
    const fakeToken = `${header}.${body}.invalidsig`;
    expect(await verifyJwt(fakeToken, env.JWT_SECRET)).toBeNull();
  });
});

// ── Metadata ──────────────────────────────────────────────────────────────

describe("GET /.well-known/oauth-authorization-server", () => {
  it("returns metadata when ENABLE_OAUTH=true", async () => {
    const res = await SELF.fetch("http://localhost/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.issuer).toBe("http://localhost");
    expect(data.authorization_endpoint).toBe("http://localhost/authorize");
    expect(data.token_endpoint).toBe("http://localhost/token");
    expect(data.registration_endpoint).toBe("http://localhost/register");
    expect(data.code_challenge_methods_supported).toContain("S256");
    expect(data.token_endpoint_auth_methods_supported).toContain("none");
  });
});

// ── Registration ──────────────────────────────────────────────────────────

describe("POST /register", () => {
  it("creates a client and returns client_id", async () => {
    const res = await SELF.fetch("http://localhost/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [TEST_REDIRECT_URI] }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(typeof data.client_id).toBe("string");
    expect(data.redirect_uris).toEqual([TEST_REDIRECT_URI]);
    expect(data.token_endpoint_auth_method).toBe("none");
    expect(data.client_secret).toBeUndefined();
  });

  it("rejects missing redirect_uris", async () => {
    const res = await SELF.fetch("http://localhost/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_redirect_uri");
  });

  it("rejects empty redirect_uris array", async () => {
    const res = await SELF.fetch("http://localhost/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-string redirect_uri entries", async () => {
    const res = await SELF.fetch("http://localhost/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [123, null] }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_redirect_uri");
  });

  it("rejects redirect_uri with fragment", async () => {
    const res = await SELF.fetch("http://localhost/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://example.com/cb#fragment"] }),
    });
    expect(res.status).toBe(400);
  });
});

// ── Authorization endpoint ────────────────────────────────────────────────

describe("GET /authorize", () => {
  it("rejects unknown client_id", async () => {
    const res = await SELF.fetch(
      "http://localhost/authorize?response_type=code&client_id=unknown&redirect_uri=https%3A%2F%2Fexample.com&code_challenge=abc&code_challenge_method=S256",
    );
    expect(res.status).toBe(401);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_client");
  });

  it("rejects mismatched redirect_uri", async () => {
    const { clientId } = await register();
    const res = await SELF.fetch(
      `http://localhost/authorize?response_type=code&client_id=${clientId}&redirect_uri=https%3A%2F%2Fother.example.com&code_challenge=abc&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_redirect_uri");
  });

  it("rejects non-S256 code_challenge_method", async () => {
    const { clientId } = await register();
    const uri = encodeURIComponent(TEST_REDIRECT_URI);
    const res = await SELF.fetch(
      `http://localhost/authorize?response_type=code&client_id=${clientId}&redirect_uri=${uri}&code_challenge=abc&code_challenge_method=plain`,
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_request");
  });

  it("redirects to Google with valid params (default provider)", async () => {
    const { clientId } = await register();
    const uri = encodeURIComponent(TEST_REDIRECT_URI);
    const res = await SELF.fetch(
      `http://localhost/authorize?response_type=code&client_id=${clientId}&redirect_uri=${uri}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(location).toContain("client_id=test-google-client-id");
  });
});

// ── Token endpoint — authorization_code grant ─────────────────────────────

describe("POST /token (authorization_code)", () => {
  it("issues tokens for a valid code + verifier", async () => {
    const { clientId } = await register();
    const verifier = "test-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
    const challenge = await computeChallenge(verifier);
    const code = await insertAuthCode({ clientId, userId: "usr_test", codeChallenge: challenge });

    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: verifier,
      client_id: clientId,
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(typeof data.access_token).toBe("string");
    expect(data.token_type).toBe("Bearer");
    expect(typeof data.refresh_token).toBe("string");
    expect(typeof data.expires_in).toBe("number");
  });

  it("access token is a valid JWT with correct claims", async () => {
    const { clientId } = await register();
    const verifier = "test-verifier-abcdefghijklmnopqrstuvwxyz0123456789a";
    const challenge = await computeChallenge(verifier);
    const code = await insertAuthCode({
      clientId,
      userId: "usr_jwt_test",
      codeChallenge: challenge,
    });

    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: verifier,
      client_id: clientId,
    });
    const { access_token } = (await res.json()) as { access_token: string };
    const payload = await verifyJwt(access_token, env.JWT_SECRET);
    expect(payload?.sub).toBe("usr_jwt_test");
    expect(payload?.aud).toMatch(/\/mcp$/);
  });

  it("rejects an unknown authorization code", async () => {
    const { clientId } = await register();
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code: "not-a-real-code",
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: "anyverifier",
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects an expired authorization code", async () => {
    const { clientId } = await register();
    const verifier = "test-verifier-abcdefghijklmnopqrstuvwxyz0123456789b";
    const challenge = await computeChallenge(verifier);
    const code = await insertAuthCode({
      clientId,
      userId: "usr_test",
      codeChallenge: challenge,
      expiresAt: Date.now() - 1000,
    });

    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects a code with wrong PKCE verifier", async () => {
    const { clientId } = await register();
    const verifier = "test-verifier-abcdefghijklmnopqrstuvwxyz0123456789c";
    const challenge = await computeChallenge(verifier);
    const code = await insertAuthCode({ clientId, userId: "usr_test", codeChallenge: challenge });

    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: "wrong-verifier-abcdefghijklmnopqrstuvwxyz0123456",
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects a code used twice (atomicity)", async () => {
    const { clientId } = await register();
    const verifier = "test-verifier-abcdefghijklmnopqrstuvwxyz0123456789d";
    const challenge = await computeChallenge(verifier);
    const code = await insertAuthCode({ clientId, userId: "usr_test", codeChallenge: challenge });

    const params = {
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: verifier,
      client_id: clientId,
    };

    const res1 = await tokenRequest(params);
    expect(res1.status).toBe(200);

    const res2 = await tokenRequest(params);
    expect(res2.status).toBe(400);
    const data = (await res2.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects wrong redirect_uri", async () => {
    const { clientId } = await register();
    const verifier = "test-verifier-abcdefghijklmnopqrstuvwxyz0123456789e";
    const challenge = await computeChallenge(verifier);
    const code = await insertAuthCode({ clientId, userId: "usr_test", codeChallenge: challenge });

    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://evil.example.com/callback",
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects unknown client_id", async () => {
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code: "somecode",
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: "someverifier",
      client_id: "unknown-client",
    });
    expect(res.status).toBe(401);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_client");
  });
});

// ── Token endpoint — refresh_token grant ─────────────────────────────────

describe("POST /token (refresh_token)", () => {
  it("issues new tokens for a valid refresh token", async () => {
    const { clientId } = await register();
    const refreshToken = crypto.randomUUID();
    const tokenHash = await hashToken(refreshToken);
    await insertRefreshToken({ tokenHash, userId: "usr_test", clientId });

    const res = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(typeof data.access_token).toBe("string");
    expect(typeof data.refresh_token).toBe("string");
    expect(data.refresh_token).not.toBe(refreshToken); // token was rotated
  });

  it("rejects a refresh token used twice (rotation atomicity)", async () => {
    const { clientId } = await register();
    const refreshToken = crypto.randomUUID();
    const tokenHash = await hashToken(refreshToken);
    await insertRefreshToken({ tokenHash, userId: "usr_test", clientId });

    const res1 = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(res1.status).toBe(200);

    const res2 = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(res2.status).toBe(400);
    const data = (await res2.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects an unknown refresh token", async () => {
    const { clientId } = await register();
    const res = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: "not-a-real-token",
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects an expired refresh token", async () => {
    const { clientId } = await register();
    const refreshToken = crypto.randomUUID();
    const tokenHash = await hashToken(refreshToken);
    await insertRefreshToken({
      tokenHash,
      userId: "usr_test",
      clientId,
      expiresAt: Date.now() - 1000,
    });

    const res = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("invalid_grant");
  });
});

// ── Authorize — provider sub-routes ──────────────────────────────────────

describe("GET /authorize/:provider routing", () => {
  it("/authorize/google redirects to Google", async () => {
    const { clientId } = await register();
    const uri = encodeURIComponent(TEST_REDIRECT_URI);
    const res = await SELF.fetch(
      `http://localhost/authorize/google?response_type=code&client_id=${clientId}&redirect_uri=${uri}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(location).toContain("client_id=test-google-client-id");
  });

  it("/authorize/github returns invalid_request (unsupported provider)", async () => {
    const { clientId } = await register();
    const uri = encodeURIComponent(TEST_REDIRECT_URI);
    const res = await SELF.fetch(
      `http://localhost/authorize/github?response_type=code&client_id=${clientId}&redirect_uri=${uri}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("/authorize/unknown returns invalid_request for unsupported provider", async () => {
    const { clientId } = await register();
    const uri = encodeURIComponent(TEST_REDIRECT_URI);
    const res = await SELF.fetch(
      `http://localhost/authorize/unknown?response_type=code&client_id=${clientId}&redirect_uri=${uri}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });
});

// ── Callback & user resolution (Google API mocked) ────────────────────────

describe("GET /oauth/callback", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates a new user and redirects back with an auth code", async () => {
    const { internalState } = await beginAuthorizeFlow();
    mockGoogleApis("g1001", "user1001@example.com");
    const res = await doCallback(internalState);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(TEST_REDIRECT_URI);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe("cs"); // original client state forwarded
  });

  it("creates a user without email when email_verified=false", async () => {
    const { internalState } = await beginAuthorizeFlow();
    mockGoogleApis("g1002", "unverified@example.com", false);
    const res = await doCallback(internalState);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("code")).toBeTruthy();
  });

  it("returns the same user on repeated login with the same Google identity", async () => {
    const { sub: sub1 } = await fullOAuthFlow("g1003", "user1003@example.com");
    const { sub: sub2 } = await fullOAuthFlow("g1003", "user1003@example.com");
    expect(sub1).toBe(sub2);
  });

  it("back-fills email on an existing user that had none", async () => {
    const { sub: sub1 } = await fullOAuthFlow("g1004", null); // no email on first login
    const { sub: sub2 } = await fullOAuthFlow("g1004", "user1004@example.com");
    expect(sub1).toBe(sub2); // same user, email was back-filled
  });

  it("links a new identity to an existing account with a matching verified email", async () => {
    const sharedEmail = "shared1005@example.com";
    const { sub: originalSub } = await fullOAuthFlow("g1005a", sharedEmail);
    const { sub: linkedSub } = await fullOAuthFlow("g1005b", sharedEmail); // different sub, same email
    expect(linkedSub).toBe(originalSub);
  });

  it("returns 400 for an unknown or expired state token", async () => {
    const res = await doCallback("not-a-real-state");
    expect(res.status).toBe(400);
  });
});

// ── End-to-end: full OAuth flow → authenticated /me ──────────────────────

describe("end-to-end: OAuth JWT → /me", () => {
  afterEach(() => vi.restoreAllMocks());

  it("Google access token authenticates /me", async () => {
    const { tokens } = await fullOAuthFlow("g2001", "user2001@example.com");
    const res = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { userId: string };
    expect(typeof data.userId).toBe("string");
  });

  it("refresh token flow works end-to-end", async () => {
    const { clientId, tokens } = await fullOAuthFlow("g2002", "user2002@example.com");
    const res = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(res.status).toBe(200);
    const refreshed = (await res.json()) as { access_token: string };
    const meRes = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${refreshed.access_token}` },
    });
    expect(meRes.status).toBe(200);
  });
});

// ── Authentication middleware ─────────────────────────────────────────────

describe("authenticate (via /me)", () => {
  it("accepts a valid Bearer JWT", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "usr_test",
      iss: "http://localhost",
      aud: "http://localhost/mcp",
      iat: now,
      exp: now + 3600,
      jti: crypto.randomUUID(),
    };
    const token = await signJwt(payload, env.JWT_SECRET);
    const res = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a JWT with wrong audience with 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "usr_test",
      iss: "http://localhost",
      aud: "http://other-host/mcp",
      iat: now,
      exp: now + 3600,
      jti: crypto.randomUUID(),
    };
    const token = await signJwt(payload, env.JWT_SECRET);
    const res = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects an expired Bearer JWT with 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "usr_test",
      iss: "http://localhost",
      aud: "http://localhost/mcp",
      iat: now - 7200,
      exp: now - 3600,
      jti: crypto.randomUUID(),
    };
    const token = await signJwt(payload, env.JWT_SECRET);
    const res = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed Bearer token without throwing", async () => {
    const res = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: "Bearer not!!valid!!jwt" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests without Authorization header", async () => {
    const res = await SELF.fetch("http://localhost/me");
    expect(res.status).toBe(401);
  });
});
