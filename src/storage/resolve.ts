import type { Env } from "../types.ts";

interface StorageTokenPayload {
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  b: string; // bucket
  k: string; // key
  method: "GET" | "PUT";
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
    const p = payload as Record<string, unknown>;

    if (
      typeof payload !== "object" ||
      payload === null ||
      p.aud !== "storage" ||
      typeof p.b !== "string" ||
      typeof p.k !== "string" ||
      typeof p.exp !== "number" ||
      (p.method !== "GET" && p.method !== "PUT")
    ) {
      return null;
    }

    const typed = payload as StorageTokenPayload;
    if (typed.exp < Math.floor(Date.now() / 1000)) return null;
    return typed;
  } catch {
    return null;
  }
}

interface DataSourceTokenPayload {
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  c: string; // credential ID
  p: string; // API path
  u: string; // user ID
}

export async function signDataSourceToken(
  payload: DataSourceTokenPayload,
  secret: string,
): Promise<string> {
  const header = base64urlEncodeStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64urlEncodeStr(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64urlEncode(sig)}`;
}

export async function verifyDataSourceToken(
  token: string,
  secret: string,
): Promise<DataSourceTokenPayload | null> {
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
      (payload as Record<string, unknown>).aud !== "data-source" ||
      typeof (payload as Record<string, unknown>).c !== "string" ||
      typeof (payload as Record<string, unknown>).p !== "string" ||
      typeof (payload as Record<string, unknown>).u !== "string" ||
      typeof (payload as Record<string, unknown>).exp !== "number"
    ) {
      return null;
    }

    const p = payload as DataSourceTokenPayload;
    if (p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch {
    return null;
  }
}

export function parseHttpDsUri(uri: string): { credentialId: string; path: string } | null {
  if (!uri.startsWith("http-ds://")) return null;
  const rest = uri.slice("http-ds://".length);
  const slash = rest.indexOf("/");
  const credentialId = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/" : rest.slice(slash);
  if (!credentialId) return null;
  return { credentialId, path };
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

export function r2BoundKey(userId: string, relPath: string): string {
  return `users/${userId}/${relPath}`;
}

export async function resolveUri(
  uri: string,
  env: Env,
  userId: string,
  workerOrigin: string,
  method: "GET" | "PUT" = "GET",
): Promise<string> {
  const parsed = parseR2Uri(uri);
  if (!parsed) throw new Error(`Unsupported URI: ${uri}`);

  const now = Math.floor(Date.now() / 1000);
  const token = await signStorageToken(
    {
      sub: "storage",
      iss: workerOrigin,
      aud: "storage",
      iat: now,
      exp: now + (method === "PUT" ? 900 : 3600),
      jti: crypto.randomUUID(),
      b: parsed.bucket,
      k: r2BoundKey(userId, parsed.key),
      method,
    },
    env.JWT_SECRET,
  );

  return `${workerOrigin}/api/storage/obj/${token}`;
}

// ── R2 S3-compatible signing ──────────────────────────────────────────────

async function hmacSha256Raw(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function s3EncodeSegment(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function s3EncodeKey(key: string): string {
  return key.split("/").map(s3EncodeSegment).join("/");
}

export async function signS3Request(opts: {
  method: "GET" | "HEAD" | "PUT" | "POST" | "DELETE";
  endpoint: string;
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  queryParams?: Record<string, string>;
}): Promise<{ url: string; headers: Record<string, string> }> {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const dateStamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`;
  const amzDate = `${dateStamp}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;

  const endpointUrl = new URL(opts.endpoint);
  const host = endpointUrl.host;
  const endpointPathPrefix =
    endpointUrl.pathname === "/" ? "" : endpointUrl.pathname.replace(/\/$/, "");
  const encodedKey = s3EncodeKey(opts.key);
  const path = `${endpointPathPrefix}/${opts.bucket}/${encodedKey}`;

  // Build canonical query string (params sorted alphabetically, both key and value URI-encoded)
  const canonicalQueryString = opts.queryParams
    ? Object.entries(opts.queryParams)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${s3EncodeSegment(k)}=${s3EncodeSegment(v)}`)
        .join("&")
    : "";
  const url = canonicalQueryString
    ? `${endpointUrl.origin}${path}?${canonicalQueryString}`
    : `${endpointUrl.origin}${path}`;

  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    opts.method,
    path,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${opts.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let sigKey = new TextEncoder().encode(`AWS4${opts.secretAccessKey}`).buffer as ArrayBuffer;
  for (const part of [dateStamp, opts.region, "s3", "aws4_request"]) {
    sigKey = await hmacSha256Raw(sigKey, part);
  }
  const signature = Array.from(new Uint8Array(await hmacSha256Raw(sigKey, stringToSign)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    url,
    headers: {
      Host: host,
      "X-Amz-Date": amzDate,
      "X-Amz-Content-SHA256": payloadHash,
      Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export async function signS3PresignedPutUrl(opts: {
  endpoint: string;
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
}): Promise<string> {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const dateStamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`;
  const amzDate = `${dateStamp}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;

  const endpointUrl = new URL(opts.endpoint);
  const host = endpointUrl.host;
  const endpointPathPrefix =
    endpointUrl.pathname === "/" ? "" : endpointUrl.pathname.replace(/\/$/, "");
  const encodedKey = s3EncodeKey(opts.key);
  const path = `${endpointPathPrefix}/${opts.bucket}/${encodedKey}`;

  const credentialScope = `${dateStamp}/${opts.region}/s3/aws4_request`;

  // Query params must be in alphabetical order for the canonical query string.
  const canonicalQueryString = [
    "X-Amz-Algorithm=AWS4-HMAC-SHA256",
    `X-Amz-Credential=${encodeURIComponent(`${opts.accessKeyId}/${credentialScope}`)}`,
    `X-Amz-Date=${amzDate}`,
    `X-Amz-Expires=${opts.expiresSeconds}`,
    "X-Amz-SignedHeaders=host",
  ].join("&");

  const canonicalRequest = [
    "PUT",
    path,
    canonicalQueryString,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let sigKey = new TextEncoder().encode(`AWS4${opts.secretAccessKey}`).buffer as ArrayBuffer;
  for (const part of [dateStamp, opts.region, "s3", "aws4_request"]) {
    sigKey = await hmacSha256Raw(sigKey, part);
  }
  const signature = Array.from(new Uint8Array(await hmacSha256Raw(sigKey, stringToSign)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${endpointUrl.origin}${path}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

// ── R2 S3-compatible token ────────────────────────────────────────────────

interface R2S3CompatTokenPayload {
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  d: string; // storage backend ID
  k: string; // object key
  u: string; // user ID
  method: "GET" | "PUT";
}

export async function signR2S3CompatToken(
  payload: R2S3CompatTokenPayload,
  secret: string,
): Promise<string> {
  const header = base64urlEncodeStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64urlEncodeStr(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64urlEncode(sig)}`;
}

export async function verifyR2S3CompatToken(
  token: string,
  secret: string,
): Promise<R2S3CompatTokenPayload | null> {
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
    const p = payload as Record<string, unknown>;

    if (
      typeof payload !== "object" ||
      payload === null ||
      p.aud !== "r2-s3compat" ||
      typeof p.d !== "string" ||
      typeof p.k !== "string" ||
      typeof p.u !== "string" ||
      typeof p.exp !== "number" ||
      (p.method !== "GET" && p.method !== "PUT")
    ) {
      return null;
    }

    const typed = payload as R2S3CompatTokenPayload;
    if (typed.exp < Math.floor(Date.now() / 1000)) return null;
    return typed;
  } catch {
    return null;
  }
}

export function parseR2S3CompatUri(uri: string): { backendId: string; key: string } | null {
  if (!uri.startsWith("r2-s3compat://")) return null;
  const rest = uri.slice("r2-s3compat://".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const backendId = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (!backendId || !key) return null;
  return { backendId, key };
}
