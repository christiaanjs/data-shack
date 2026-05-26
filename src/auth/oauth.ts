import { encryptConfig } from "../crypto.ts";
import {
  type OAuthCodeRow,
  claimOAuthCode,
  claimRefreshToken,
  getAndDeleteOAuthState,
  getOAuthClient,
  getOAuthClientByRedirectUris,
  insertOAuthClient,
  insertOAuthCode,
  insertOAuthState,
  insertRefreshToken,
} from "../db/oauth.ts";
import {
  createUserWithIdentity,
  getIdentity,
  getUser,
  getUserByEmail,
  isEmailAllowed,
  linkIdentity,
  updateUserEmail,
} from "../db/queries.ts";
import { insertCredential } from "../db/settings.ts";
import type { Env } from "../types.ts";
import {
  ACCESS_TOKEN_TTL,
  type JwtPayload,
  REFRESH_TOKEN_TTL,
  hashToken,
  signJwt,
  verifyPkce,
} from "./jwt.ts";

interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
}

interface ProviderIdentity {
  providerId: string;
  verifiedEmail: string | null;
  refreshToken?: string;
}

class ForbiddenError extends Error {}

function issuerFromRequest(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return jsonResponse({ error, error_description: description }, status);
}

function isValidRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string") return false;
  try {
    const parsed = new URL(uri);
    return parsed.hash === "";
  } catch {
    return false;
  }
}

// GET /.well-known/oauth-protected-resource (RFC 9728)
export function handleProtectedResource(request: Request): Response {
  const issuer = issuerFromRequest(request);
  return jsonResponse({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
  });
}

// GET /.well-known/oauth-authorization-server
export function handleMetadata(request: Request): Response {
  const issuer = issuerFromRequest(request);
  return jsonResponse({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

// POST /register — Dynamic Client Registration (RFC 7591)
export async function handleRegister(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthError("invalid_request", "Invalid JSON body");
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return oauthError("invalid_redirect_uri", "redirect_uris is required and must be non-empty");
  }
  if (!redirectUris.every(isValidRedirectUri)) {
    return oauthError(
      "invalid_redirect_uri",
      "Each redirect_uri must be a valid URL without a fragment",
    );
  }

  const uris = redirectUris as string[];
  const existing = await getOAuthClientByRedirectUris(env.DB, uris);
  if (existing) {
    return jsonResponse({
      client_id: existing.client_id,
      redirect_uris: JSON.parse(existing.redirect_uris) as string[],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  }

  const clientId = crypto.randomUUID();
  await insertOAuthClient(env.DB, clientId, uris, Date.now());

  return jsonResponse(
    {
      client_id: clientId,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

// GET /authorize and GET /authorize/:provider
export async function handleAuthorize(
  request: Request,
  env: Env,
  provider: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const responseType = params.get("response_type");
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method");
  const state = params.get("state");

  if (responseType !== "code") {
    return oauthError("unsupported_response_type", "Only code response_type is supported");
  }
  if (!clientId || !redirectUri || !codeChallenge || !codeChallengeMethod) {
    return oauthError("invalid_request", "Missing required parameters");
  }
  if (codeChallengeMethod !== "S256") {
    return oauthError("invalid_request", "Only S256 code_challenge_method is supported");
  }

  const client = await getOAuthClient(env.DB, clientId);
  if (!client) {
    return oauthError("invalid_client", "Unknown client_id", 401);
  }

  let allowedUris: string[];
  try {
    allowedUris = JSON.parse(client.redirect_uris) as string[];
  } catch {
    return oauthError("server_error", "Stored client configuration is invalid", 500);
  }
  if (!allowedUris.includes(redirectUri)) {
    return oauthError("invalid_redirect_uri", "redirect_uri not registered for this client");
  }

  const providerRedirect = buildProviderRedirect(provider, env, issuerFromRequest(request));
  if (providerRedirect === "unsupported") {
    return oauthError("invalid_request", `Unknown provider: ${provider}`);
  }
  if (providerRedirect === "misconfigured") {
    return oauthError("server_error", `Provider ${provider} is not configured`, 500);
  }

  const internalState = crypto.randomUUID();
  await insertOAuthState(env.DB, {
    state: internalState,
    client_id: clientId,
    provider,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    redirect_uri: redirectUri,
    original_state: state,
    expires_at: Date.now() + 10 * 60 * 1000,
  });

  providerRedirect.searchParams.set("state", internalState);
  return Response.redirect(providerRedirect.toString(), 302);
}

function buildProviderRedirect(
  provider: string,
  env: Env,
  issuer: string,
): URL | "unsupported" | "misconfigured" {
  if (provider === "google") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return "misconfigured";
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", `${issuer}/oauth/callback`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email");
    url.searchParams.set("access_type", "online");
    return url;
  }
  if (provider === "google-sheets") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return "misconfigured";
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", `${issuer}/oauth/callback`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email https://www.googleapis.com/auth/spreadsheets");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return url;
  }
  return "unsupported";
}

export async function handleConnectGoogleSheets(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const credentialName = params.get("name") ?? "Google Sheets";
  const issuer = issuerFromRequest(request);

  const providerUrl = buildProviderRedirect("google-sheets", env, issuer);
  if (providerUrl === "unsupported") return new Response("Not found", { status: 404 });
  if (providerUrl === "misconfigured") {
    return new Response("Google OAuth not configured", { status: 500 });
  }

  const state = crypto.randomUUID();
  await insertOAuthState(env.DB, {
    state,
    client_id: "",
    provider: "google-sheets",
    code_challenge: "",
    code_challenge_method: "S256",
    redirect_uri: "",
    original_state: null,
    credential_name: credentialName,
    expires_at: Date.now() + 10 * 60 * 1000,
  });

  providerUrl.searchParams.set("state", state);
  return Response.redirect(providerUrl.toString(), 302);
}

async function resolveUserId(
  db: D1Database,
  provider: string,
  providerId: string,
  verifiedEmail: string | null,
): Promise<string> {
  const identity = await getIdentity(db, provider, providerId);
  if (identity) {
    if (verifiedEmail) {
      const user = await getUser(db, identity.user_id);
      if (user && !user.email) {
        await updateUserEmail(db, identity.user_id, verifiedEmail);
      }
    }
    return identity.user_id;
  }

  if (verifiedEmail) {
    const emailOwner = await getUserByEmail(db, verifiedEmail);
    if (emailOwner) {
      await linkIdentity(db, provider, providerId, emailOwner.id);
      return emailOwner.id;
    }
  }

  if (!verifiedEmail || !(await isEmailAllowed(db, verifiedEmail))) {
    throw new ForbiddenError("Email not permitted to sign up");
  }

  return createUserWithIdentity(db, provider, providerId, verifiedEmail);
}

function popupResultHtml(
  type: "success" | "error",
  frontendOrigin: string,
  opts: { reason?: string; credentialName?: string } = {},
): Response {
  const msg = JSON.stringify({ type: `gscred-${type}`, ...opts });
  const body = type === "success" ? "Connected! Closing…" : `Failed: ${opts.reason ?? "unknown"}`;
  const html = `<!DOCTYPE html><html><head><title>${type === "success" ? "Connected" : "Failed"}</title></head>
<body><p>${body}</p>
<script>try{window.opener.postMessage(${msg},${JSON.stringify(frontendOrigin)})}catch(e){}window.close()</script>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// GET /oauth/callback
export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");

  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  const pending = await getAndDeleteOAuthState(env.DB, state);
  if (!pending || pending.expires_at < Date.now()) {
    return new Response("Invalid or expired state", { status: 400 });
  }

  const issuer = issuerFromRequest(request);
  const result = await fetchProviderIdentity(pending.provider, code, issuer, env);
  if (result instanceof Response) return result;

  const { provider, providerId, verifiedEmail } = result;

  const frontendOrigin = env.ALLOWED_ORIGIN || issuer;

  let userId: string;
  try {
    userId = await resolveUserId(env.DB, provider, providerId, verifiedEmail);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      if (pending.provider === "google-sheets") {
        return popupResultHtml("error", frontendOrigin, { reason: "access_denied" });
      }
      return new Response("Access denied: email not permitted to sign up", { status: 403 });
    }
    const retried = await resolveUserId(env.DB, provider, providerId, verifiedEmail);
    userId = retried;
  }

  if (pending.provider === "google-sheets") {
    if (!result.refreshToken) {
      return popupResultHtml("error", frontendOrigin, { reason: "no_refresh_token" });
    }
    const encryptedCfg = await encryptConfig(
      JSON.stringify({ refreshToken: result.refreshToken }),
      env.JWT_SECRET,
    );
    await insertCredential(env.DB, {
      userId,
      name: pending.credential_name ?? "Google Sheets",
      type: "google-sheets",
      encryptedConfig: encryptedCfg,
    });
    return popupResultHtml("success", frontendOrigin, {
      credentialName: pending.credential_name ?? undefined,
    });
  }

  const authCode = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  await insertOAuthCode(env.DB, {
    code: authCode,
    client_id: pending.client_id,
    user_id: userId,
    code_challenge: pending.code_challenge,
    code_challenge_method: pending.code_challenge_method,
    redirect_uri: pending.redirect_uri,
    expires_at: Date.now() + 5 * 60 * 1000,
    used: 0,
  });

  const callbackUrl = new URL(pending.redirect_uri);
  callbackUrl.searchParams.set("code", authCode);
  if (pending.original_state) callbackUrl.searchParams.set("state", pending.original_state);

  return Response.redirect(callbackUrl.toString(), 302);
}

async function fetchProviderIdentity(
  provider: string,
  code: string,
  issuer: string,
  env: Env,
): Promise<(ProviderIdentity & { provider: string }) | Response> {
  if (provider === "google" || provider === "google-sheets") {
    const result = await fetchGoogleIdentity(code, issuer, env);
    if (result instanceof Response) return result;
    return { provider, ...result };
  }
  return new Response(`Unsupported provider: ${provider}`, { status: 400 });
}

async function fetchGoogleIdentity(
  code: string,
  issuer: string,
  env: Env,
): Promise<ProviderIdentity | Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return new Response("Google OAuth is not configured", { status: 500 });
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: `${issuer}/oauth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return new Response("Google token exchange failed", { status: 502 });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
  };
  if (!tokenData.access_token) {
    return new Response(`Google auth error: ${tokenData.error ?? "unknown"}`, { status: 502 });
  }

  const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userRes.ok) return new Response("Failed to fetch Google user info", { status: 502 });

  const googleUser = (await userRes.json()) as GoogleUserInfo;
  const verifiedEmail = googleUser.email_verified ? googleUser.email.toLowerCase() : null;

  return { providerId: googleUser.sub, verifiedEmail, refreshToken: tokenData.refresh_token };
}

// POST /token
export async function handleToken(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return oauthError("invalid_request", "Content-Type must be application/x-www-form-urlencoded");
  }

  const params = await request.formData();
  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    return handleAuthCodeGrant(request, params, env);
  }
  if (grantType === "refresh_token") {
    return handleRefreshGrant(request, params, env);
  }
  return oauthError(
    "unsupported_grant_type",
    "Only authorization_code and refresh_token are supported",
  );
}

async function handleAuthCodeGrant(
  request: Request,
  params: FormData,
  env: Env,
): Promise<Response> {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    return new Response("Server misconfiguration: JWT_SECRET too short", { status: 500 });
  }

  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const codeVerifier = params.get("code_verifier");
  const clientId = params.get("client_id");

  if (!code || !redirectUri || !codeVerifier || !clientId) {
    return oauthError("invalid_request", "Missing required parameters");
  }

  const client = await getOAuthClient(env.DB, clientId);
  if (!client) {
    return oauthError("invalid_client", "Unknown client_id", 401);
  }

  const authCode = await claimOAuthCode(env.DB, code, Date.now());
  if (!authCode) {
    return oauthError("invalid_grant", "Authorization code is invalid, expired, or already used");
  }
  if (authCode.client_id !== clientId) {
    return oauthError("invalid_grant", "client_id mismatch");
  }
  if (authCode.redirect_uri !== redirectUri) {
    return oauthError("invalid_grant", "redirect_uri mismatch");
  }

  const pkceValid = await verifyPkce(
    codeVerifier,
    authCode.code_challenge,
    authCode.code_challenge_method,
  );
  if (!pkceValid) {
    return oauthError("invalid_grant", "PKCE verification failed");
  }

  return issueTokens(request, env, authCode.user_id, clientId);
}

async function handleRefreshGrant(request: Request, params: FormData, env: Env): Promise<Response> {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    return new Response("Server misconfiguration: JWT_SECRET too short", { status: 500 });
  }

  const refreshToken = params.get("refresh_token");
  const clientId = params.get("client_id");

  if (!refreshToken || !clientId) {
    return oauthError("invalid_request", "Missing required parameters");
  }

  const client = await getOAuthClient(env.DB, clientId);
  if (!client) {
    return oauthError("invalid_client", "Unknown client_id", 401);
  }

  const tokenHash = await hashToken(refreshToken);

  const stored = await claimRefreshToken(env.DB, tokenHash, Date.now());
  if (!stored) {
    return oauthError("invalid_grant", "Refresh token is invalid, expired, or already used");
  }
  if (stored.client_id !== clientId) {
    return oauthError("invalid_grant", "client_id mismatch");
  }

  return issueTokens(request, env, stored.user_id, clientId);
}

async function issueTokens(
  request: Request,
  env: Env,
  userId: string,
  clientId: string,
): Promise<Response> {
  const { payload, ttl } = makeAccessPayload(userId, issuerFromRequest(request));
  const accessToken = await signJwt(payload, env.JWT_SECRET);

  const refreshToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const refreshHash = await hashToken(refreshToken);

  await insertRefreshToken(env.DB, {
    token_hash: refreshHash,
    user_id: userId,
    client_id: clientId,
    expires_at: Date.now() + REFRESH_TOKEN_TTL * 1000,
    revoked: 0,
  });

  return jsonResponse({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ttl,
    refresh_token: refreshToken,
  });
}

function makeAccessPayload(userId: string, issuer: string): { payload: JwtPayload; ttl: number } {
  const now = Math.floor(Date.now() / 1000);
  return {
    payload: {
      sub: userId,
      iss: issuer,
      aud: `${issuer}/mcp`,
      iat: now,
      exp: now + ACCESS_TOKEN_TTL,
      jti: crypto.randomUUID(),
    },
    ttl: ACCESS_TOKEN_TTL,
  };
}

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono/tiny";

const requireOAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.env.ENABLE_OAUTH !== "true") return c.notFound();
  return next();
};

export const oauthRouter = new Hono<{ Bindings: Env }>();

oauthRouter.get("/.well-known/oauth-protected-resource", requireOAuth, (c) =>
  handleProtectedResource(c.req.raw),
);
// RFC 9728: clients may append the resource path to the well-known prefix
oauthRouter.get("/.well-known/oauth-protected-resource/mcp", requireOAuth, (c) =>
  handleProtectedResource(c.req.raw),
);
oauthRouter.get("/.well-known/oauth-authorization-server", requireOAuth, (c) =>
  handleMetadata(c.req.raw),
);
oauthRouter.post("/register", requireOAuth, (c) => handleRegister(c.req.raw, c.env));
oauthRouter.get("/authorize", requireOAuth, (c) =>
  handleAuthorize(c.req.raw, c.env, c.env.DEFAULT_OAUTH_PROVIDER ?? "google"),
);
oauthRouter.get("/authorize/:provider{[a-z][a-z0-9]*}", requireOAuth, (c) =>
  handleAuthorize(c.req.raw, c.env, c.req.param("provider")),
);
oauthRouter.get("/oauth/callback", requireOAuth, (c) => handleCallback(c.req.raw, c.env));
oauthRouter.post("/token", requireOAuth, (c) => handleToken(c.req.raw, c.env));
oauthRouter.get("/connect/google-sheets", (c) => handleConnectGoogleSheets(c.req.raw, c.env));
