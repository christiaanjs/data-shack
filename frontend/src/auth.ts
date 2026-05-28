const WORKER_BASE = import.meta.env.VITE_WORKER_URL ?? "";
const STORAGE_KEY_CLIENT = "oauth_client_id";
const STORAGE_KEY_ACCESS = "oauth_access_token";
const STORAGE_KEY_REFRESH = "oauth_refresh_token";
const STORAGE_KEY_EXP = "oauth_exp";

// PKCE verifier and state are stored in cookies (not localStorage) so they
// survive the cross-context hop on Android: standalone PWA initiates the flow
// but Chrome Custom Tab handles the /callback redirect — cookies are shared
// between both contexts for the same origin, while localStorage is partitioned.
const COOKIE_VERIFIER = "oauth_pkce_v";
const COOKIE_STATE = "oauth_pkce_s";
const OAUTH_COOKIE_TTL = 600; // seconds — enough for the round trip

function setAuthCookie(name: string, value: string): void {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${OAUTH_COOKIE_TTL}; path=/; SameSite=Lax${secure}`;
}

function getAuthCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function deleteAuthCookie(name: string): void {
  document.cookie = `${name}=; max-age=0; path=/`;
}

// ── PKCE helpers ──────────────────────────────────────────────────────────

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generateCodeVerifier(): Promise<string> {
  const buf = crypto.getRandomValues(new Uint8Array(32));
  return base64url(buf.buffer);
}

async function codeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64url(digest);
}

// ── DCR ───────────────────────────────────────────────────────────────────

async function ensureClientId(): Promise<string> {
  let clientId = localStorage.getItem(STORAGE_KEY_CLIENT);
  if (clientId) return clientId;

  const res = await fetch(`${WORKER_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [`${location.origin}/callback`],
    }),
  });
  if (!res.ok) throw new Error(`DCR failed: ${res.status}`);
  const data = (await res.json()) as { client_id: string };
  clientId = data.client_id;
  localStorage.setItem(STORAGE_KEY_CLIENT, clientId);
  return clientId;
}

// ── Token storage ─────────────────────────────────────────────────────────

export function getAccessToken(): string | null {
  return localStorage.getItem(STORAGE_KEY_ACCESS);
}

function storeTokens(accessToken: string, refreshToken: string, expiresIn: number) {
  localStorage.setItem(STORAGE_KEY_ACCESS, accessToken);
  localStorage.setItem(STORAGE_KEY_REFRESH, refreshToken);
  localStorage.setItem(STORAGE_KEY_EXP, String(Date.now() + expiresIn * 1000));
}

export function clearTokens() {
  localStorage.removeItem(STORAGE_KEY_ACCESS);
  localStorage.removeItem(STORAGE_KEY_REFRESH);
  localStorage.removeItem(STORAGE_KEY_EXP);
  deleteAuthCookie(COOKIE_VERIFIER);
  deleteAuthCookie(COOKIE_STATE);
}

function isExpiringSoon(): boolean {
  const exp = localStorage.getItem(STORAGE_KEY_EXP);
  if (!exp) return true;
  return Date.now() > Number(exp) - 5 * 60 * 1000; // 5 min buffer
}

// ── Refresh ───────────────────────────────────────────────────────────────

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = localStorage.getItem(STORAGE_KEY_REFRESH);
  const clientId = localStorage.getItem(STORAGE_KEY_CLIENT);
  if (!refreshToken || !clientId) return false;

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const res = await fetch(`${WORKER_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (data.error === "invalid_grant") clearTokens();
    return false;
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  storeTokens(data.access_token, data.refresh_token, data.expires_in);
  return true;
}

// ── Auth flow entry points ────────────────────────────────────────────────

export async function startLogin() {
  const clientId = await ensureClientId();
  const verifier = await generateCodeVerifier();
  const challenge = await codeChallenge(verifier);
  setAuthCookie(COOKIE_VERIFIER, verifier);

  const state = crypto.randomUUID();
  setAuthCookie(COOKIE_STATE, state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: `${location.origin}/callback`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  location.href = `${WORKER_BASE}/authorize/google?${params}`;
}

export async function handleCallback(searchParams: URLSearchParams): Promise<void> {
  const returnedState = searchParams.get("state");
  const storedState = getAuthCookie(COOKIE_STATE);
  deleteAuthCookie(COOKIE_STATE);
  if (!storedState || returnedState !== storedState) {
    throw new Error("State mismatch — possible CSRF");
  }

  const code = searchParams.get("code");
  if (!code) throw new Error("No code in callback URL");

  const verifier = getAuthCookie(COOKIE_VERIFIER);
  if (!verifier)
    throw new Error("No code_verifier found — callback arrived without a prior login attempt");

  const clientId = localStorage.getItem(STORAGE_KEY_CLIENT);
  if (!clientId) throw new Error("No client_id stored");

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: `${location.origin}/callback`,
    client_id: clientId,
  });

  const res = await fetch(`${WORKER_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  storeTokens(data.access_token, data.refresh_token, data.expires_in);
  deleteAuthCookie(COOKIE_VERIFIER);
}

// ── Token getter with auto-refresh ────────────────────────────────────────

export async function getValidToken(): Promise<string | null> {
  if (!getAccessToken()) return null;
  if (isExpiringSoon()) {
    const ok = await refreshAccessToken();
    if (!ok) return null;
  }
  return getAccessToken();
}
