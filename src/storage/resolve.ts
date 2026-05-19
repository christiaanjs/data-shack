import type { Env } from "../types.ts";

interface StorageTokenPayload {
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  k: string;
}

function base64urlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlEncodeStr(str: string): string {
  return base64urlEncode(new TextEncoder().encode(str).buffer as ArrayBuffer);
}

function base64urlDecode(str: string): Uint8Array {
  const padding = (4 - (str.length % 4)) % 4;
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signStorageToken(payload: StorageTokenPayload, secret: string): Promise<string> {
  const header = base64urlEncodeStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64urlEncodeStr(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64urlEncode(sig)}`;
}

export async function verifyStorageToken(
  token: string,
  secret: string,
): Promise<StorageTokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64urlDecode(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64))) as unknown;

    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as Record<string, unknown>).aud !== "storage" ||
      typeof (payload as Record<string, unknown>).k !== "string" ||
      typeof (payload as Record<string, unknown>).exp !== "number"
    ) {
      return null;
    }

    const p = payload as StorageTokenPayload;
    if (p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch {
    return null;
  }
}

export function parseR2Uri(uri: string): { bucket: string; key: string } | null {
  if (!uri.startsWith("r2://")) return null;
  const rest = uri.slice("r2://".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (!bucket || !key) return null;
  return { bucket, key };
}

export async function resolveUri(uri: string, env: Env, workerOrigin: string): Promise<string> {
  const parsed = parseR2Uri(uri);
  if (!parsed) throw new Error(`Unsupported URI: ${uri}`);

  const now = Math.floor(Date.now() / 1000);
  const token = await signStorageToken(
    {
      sub: "storage",
      iss: workerOrigin,
      aud: "storage",
      iat: now,
      exp: now + 3600,
      jti: crypto.randomUUID(),
      k: parsed.key,
    },
    env.JWT_SECRET,
  );

  return `${workerOrigin}/api/storage/obj/${token}`;
}
