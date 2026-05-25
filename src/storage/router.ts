import { createMiddleware } from "hono/factory";
import { Hono } from "hono/tiny";
import { authenticate } from "../auth/middleware.ts";
import { decryptConfig } from "../crypto.ts";
import {
  getCredentialConfig,
  getStorageBackendByNameOrId,
  getStorageBackendConfig,
} from "../db/settings.ts";
import { refreshGoogleAccessToken } from "../loaders/google-sheets.ts";
import type { GoogleSheetsCredential } from "../loaders/google-sheets.ts";
import type { Env } from "../types.ts";
import { parseS3AuthCredential, r2BoundKey, signS3Request } from "./resolve.ts";

// Names that always map to the built-in R2 Worker binding rather than a D1 backend row.
const R2_BOUND_NAMES = new Set(["r2-bound", "data-shack"]);

type Variables = { userId: string };
type R2GetOptions = Parameters<R2Bucket["get"]>[1];

export const storageRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

const requireAuth = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return new Response("Unauthorized", { status: 401 });
  c.set("userId", auth.userId);
  return next();
});

// ── Helpers ───────────────────────────────────────────────────────────────

export async function decryptR2S3CompatConfig(
  encryptedConfig: string,
  jwtSecret: string,
): Promise<{
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
} | null> {
  try {
    const raw = JSON.parse(await decryptConfig(encryptedConfig, jwtSecret)) as Record<
      string,
      unknown
    >;
    if (
      typeof raw.endpoint !== "string" ||
      typeof raw.accessKeyId !== "string" ||
      typeof raw.secretAccessKey !== "string" ||
      typeof raw.bucket !== "string" ||
      typeof raw.region !== "string"
    )
      return null;
    try {
      const u = new URL(raw.endpoint);
      if (u.protocol !== "https:") return null;
    } catch {
      return null;
    }
    return {
      endpoint: raw.endpoint,
      accessKeyId: raw.accessKeyId,
      secretAccessKey: raw.secretAccessKey,
      bucket: raw.bucket,
      region: raw.region,
    };
  } catch {
    return null;
  }
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildListXml(
  bucket: string,
  prefix: string,
  objects: Array<{ key: string; size: number }>,
): string {
  const contents = objects
    .map((o) => `<Contents><Key>${escXml(o.key)}</Key><Size>${o.size}</Size></Contents>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${escXml(bucket)}</Name><Prefix>${escXml(prefix)}</Prefix><KeyCount>${objects.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
}

function addCorsHeaders(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, PUT, HEAD, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Range, X-Amz-Date, X-Amz-Content-SHA256, X-Host-Override",
  );
  headers.set("Access-Control-Max-Age", "86400");
  headers.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, ETag",
  );
}

function corsError(status: 400 | 401 | 403 | 502, message: string): Response {
  const h = new Headers({ "Content-Type": "text/plain" });
  addCorsHeaders(h);
  return new Response(message, { status, headers: h });
}

// ── Proxy credential vending ──────────────────────────────────────────────

storageRouter.post("/proxy-credentials", requireAuth, async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  // Accept "backend" (name or id) — "backendId" kept as a deprecated alias
  const rawBackend = body.backend ?? body.backendId;
  if (typeof rawBackend !== "string" || !rawBackend)
    return c.json({ error: "backend is required (name or id of a storage backend)" }, 400);
  if (typeof body.pathPrefix !== "string") return c.json({ error: "pathPrefix is required" }, 400);

  const userId = c.get("userId");
  const pathPrefix = body.pathPrefix;
  const ttlSeconds =
    typeof body.ttlSeconds === "number" && body.ttlSeconds > 0
      ? Math.min(body.ttlSeconds, 3600)
      : 3600;

  // Resolve backend name/id → internal backendId + the name DuckDB will use as its S3 bucket.
  let backendId: string;
  let backendName: string;
  if (R2_BOUND_NAMES.has(rawBackend)) {
    backendId = "r2-bound";
    backendName = rawBackend; // preserves "r2-bound" or "data-shack" as DuckDB sees it
  } else {
    const row = await getStorageBackendByNameOrId(c.env.DB, rawBackend, userId);
    if (!row) return c.json({ error: "storage backend not found" }, 404);
    // If resolved by name, backendName = the name. If resolved by id, backendName = id (backwards compat).
    backendId = row.id;
    backendName = rawBackend === row.id ? row.id : row.name;
  }

  const accessKeyId = `pxy_${crypto.randomUUID().replace(/-/g, "")}`;
  // secret is a dummy value — DuckDB requires it for Sig V4 computation but the proxy
  // never validates the signature. accessKeyId is the effective bearer token.
  const secret = crypto.randomUUID();

  await c.env.PROXY_CREDS_KV.put(
    accessKeyId,
    JSON.stringify({ userId, backendId, backendName, pathPrefix }),
    { expirationTtl: ttlSeconds },
  );

  // Read-back loop: confirm KV write is visible before returning to the client
  let kvReady = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const check = await c.env.PROXY_CREDS_KV.get(accessKeyId);
    if (check !== null) {
      kvReady = true;
      break;
    }
    if (attempt < 4) await new Promise<void>((r) => setTimeout(r, 50 * (attempt + 1)));
  }
  if (!kvReady) return c.json({ error: "credential store not ready, please retry" }, 502);

  const workerOrigin = new URL(c.req.url).origin;
  return c.json({
    accessKeyId,
    secret,
    endpoint: `${workerOrigin}/api/storage/s3proxy`,
    region: "auto",
    bucket: backendName,
  });
});

// ── S3-compatible proxy ───────────────────────────────────────────────────

type ProxyCred = { userId: string; backendId: string; backendName: string; pathPrefix: string };
type S3ProxyRequest = {
  bucket: string;
  key: string;
  isList: boolean;
  cred: ProxyCred;
  effectivePrefix: string;
  reqUrl: URL;
  method: "GET" | "HEAD" | "PUT";
};

// Validates auth, resolves the KV credential, and enforces path-prefix scoping.
// Returns a parsed request descriptor on success, or a CORS-prefixed error Response.
async function parseS3ProxyRequest(
  req: Request,
  kv: KVNamespace,
): Promise<S3ProxyRequest | Response> {
  const reqUrl = new URL(req.url);
  const afterProxy = reqUrl.pathname.slice("/api/storage/s3proxy/".length);
  const slashIdx = afterProxy.indexOf("/");
  const bucket = slashIdx === -1 ? afterProxy : afterProxy.slice(0, slashIdx);
  // Decode key: DuckDB percent-encodes "=" in Hive partition paths (e.g. created_date%3D2026-05-21)
  const rawKey = slashIdx === -1 ? "" : afterProxy.slice(slashIdx + 1);
  const key = rawKey ? decodeURIComponent(rawKey) : "";

  const authHeader = req.headers.get("Authorization") ?? "";
  const accessKeyId = parseS3AuthCredential(authHeader);
  if (!accessKeyId) return corsError(401, "Unauthorized");

  // Sig V4 signature is intentionally not verified — accessKeyId lookup in KV is the auth gate.
  let credJson = await kv.get(accessKeyId);
  if (credJson === null) {
    await new Promise<void>((r) => setTimeout(r, 100));
    credJson = await kv.get(accessKeyId);
  }
  if (credJson === null) return corsError(401, "Unauthorized");

  const cred = JSON.parse(credJson) as ProxyCred;

  if (bucket !== cred.backendName) return corsError(403, "Forbidden");

  // Normalize pathPrefix: ensure trailing "/" so "allowed" can't be bypassed with "allowed-extra/"
  const effectivePrefix =
    cred.pathPrefix !== "" && !cred.pathPrefix.endsWith("/")
      ? `${cred.pathPrefix}/`
      : cred.pathPrefix;

  const isList = req.method === "GET" && key === "" && reqUrl.searchParams.get("list-type") === "2";
  const checkPath = isList ? (reqUrl.searchParams.get("prefix") ?? "") : key;
  if (!checkPath.startsWith(effectivePrefix)) return corsError(403, "Forbidden");

  return {
    bucket,
    key,
    isList,
    cred,
    effectivePrefix,
    reqUrl,
    method: req.method as "GET" | "HEAD" | "PUT",
  };
}

storageRouter.on(["GET", "HEAD", "PUT", "OPTIONS"], "/s3proxy/*", async (c) => {
  if (c.req.method === "OPTIONS") {
    const headers = new Headers();
    addCorsHeaders(headers);
    headers.set("Allow", "GET, PUT, HEAD, OPTIONS");
    return new Response(null, { status: 200, headers });
  }

  const parsed = await parseS3ProxyRequest(c.req.raw, c.env.PROXY_CREDS_KV);
  if (parsed instanceof Response) return parsed;

  const { bucket, key, isList, cred, reqUrl, method } = parsed;
  const { userId, backendId } = cred;

  // ── r2-bound ──────────────────────────────────────────────────────────

  if (backendId === "r2-bound") {
    if (isList) {
      const listPrefix = reqUrl.searchParams.get("prefix") ?? "";
      const listed = await c.env.R2.list({ prefix: r2BoundKey(userId, listPrefix) });
      const userPrefixLen = `users/${userId}/`.length;
      const objects = listed.objects.map((o) => ({
        key: o.key.slice(userPrefixLen),
        size: o.size,
      }));
      const headers = new Headers({ "Content-Type": "application/xml" });
      addCorsHeaders(headers);
      return new Response(buildListXml(bucket, listPrefix, objects), { headers });
    }

    const r2Key = r2BoundKey(userId, key);

    if (method === "PUT") {
      const body = c.req.raw.body;
      if (!body) return new Response("Bad Request", { status: 400 });
      const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
      const result = await c.env.R2.put(r2Key, body, { httpMetadata: { contentType } });
      const headers = new Headers();
      if (result.httpEtag) headers.set("ETag", result.httpEtag);
      addCorsHeaders(headers);
      return new Response(null, { status: 204, headers });
    }

    if (method === "HEAD") {
      const meta = await c.env.R2.head(r2Key);
      if (!meta) return new Response("Not Found", { status: 404 });
      const headers = new Headers();
      headers.set("Content-Length", String(meta.size));
      headers.set("Accept-Ranges", "bytes");
      if (meta.httpMetadata?.contentType)
        headers.set("Content-Type", meta.httpMetadata.contentType);
      if (meta.httpEtag) headers.set("ETag", meta.httpEtag);
      addCorsHeaders(headers);
      return new Response(null, { headers });
    }

    const rangeHeader = c.req.header("Range");
    let r2Options: R2GetOptions | undefined;
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
      if (match) {
        const offset = Number(match[1]);
        const endStr = match[2];
        const length = endStr ? Number(endStr) - offset + 1 : undefined;
        r2Options = length !== undefined ? { range: { offset, length } } : { range: { offset } };
      }
    }

    const obj = await c.env.R2.get(r2Key, r2Options);
    if (!obj) return new Response("Not Found", { status: 404 });

    const headers = new Headers();
    headers.set("Accept-Ranges", "bytes");
    if (obj.httpMetadata?.contentType) headers.set("Content-Type", obj.httpMetadata.contentType);
    if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
    addCorsHeaders(headers);

    if (rangeHeader && obj.range) {
      const range = obj.range as { offset: number; length: number };
      headers.set("Content-Length", String(range.length));
      headers.set(
        "Content-Range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`,
      );
      return new Response(obj.body, { status: 206, headers });
    }
    headers.set("Content-Length", String(obj.size));
    return new Response(obj.body, { headers });
  }

  // ── google-sheets / r2-s3compat ──────────────────────────────────────

  const backendRow = await getStorageBackendConfig(c.env.DB, backendId, userId);
  if (!backendRow) return new Response("Not Found", { status: 404 });

  if (backendRow.type === "google-sheets") {
    let sheetsCfg: { spreadsheetId: string; sheetName: string; gid?: number; credentialId: string };
    try {
      sheetsCfg = JSON.parse(
        await decryptConfig(backendRow.encrypted_config, c.env.JWT_SECRET),
      ) as typeof sheetsCfg;
    } catch {
      return corsError(502, "Bad Gateway");
    }

    const credRow = await getCredentialConfig(c.env.DB, sheetsCfg.credentialId, userId);
    if (!credRow || credRow.type !== "google-sheets") {
      return corsError(502, "google-sheets credential not found");
    }

    let cred: GoogleSheetsCredential;
    try {
      cred = JSON.parse(
        await decryptConfig(credRow.encrypted_config, c.env.JWT_SECRET),
      ) as GoogleSheetsCredential;
    } catch {
      return corsError(502, "Bad Gateway");
    }

    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
      return corsError(502, "Google OAuth not configured");
    }

    let accessToken: string;
    try {
      accessToken = await refreshGoogleAccessToken(
        c.env.GOOGLE_CLIENT_ID,
        c.env.GOOGLE_CLIENT_SECRET,
        cred.refreshToken,
      );
    } catch {
      return corsError(502, "Failed to refresh Google access token");
    }

    // S3 key → sheet name: strip extension, fall back to configured sheetName.
    const keyBase = key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : key;
    const sheetName = keyBase || sheetsCfg.sheetName || "Sheet1";

    if (method === "PUT") {
      // Accept JSON array or NDJSON (DuckDB COPY TO FORMAT JSON/NDJSON), fall back to CSV.
      const bodyText = await c.req.text();
      const trimmed = bodyText.trimStart();
      let rows: string[][];

      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        // JSON array or NDJSON from DuckDB COPY TO (FORMAT JSON) or (FORMAT NDJSON)
        const objects: Record<string, unknown>[] = [];
        if (trimmed.startsWith("[")) {
          const arr = JSON.parse(bodyText) as Record<string, unknown>[];
          objects.push(...arr);
        } else {
          for (const line of bodyText.split("\n")) {
            const l = line.trim();
            if (l) objects.push(JSON.parse(l) as Record<string, unknown>);
          }
        }
        if (objects.length === 0) {
          rows = [];
        } else {
          const hdrs = Object.keys(objects[0]!);
          rows = [hdrs, ...objects.map((obj) => hdrs.map((h) => String(obj[h] ?? "")))];
        }
      } else {
        // CSV fallback
        rows = bodyText
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => {
            const cells: string[] = [];
            let cur = "";
            let inQuote = false;
            for (let i = 0; i < line.length; i++) {
              const ch = line[i]!;
              if (ch === '"') {
                if (inQuote && line[i + 1] === '"') {
                  cur += '"';
                  i++;
                } else {
                  inQuote = !inQuote;
                }
              } else if (ch === "," && !inQuote) {
                cells.push(cur);
                cur = "";
              } else {
                cur += ch;
              }
            }
            cells.push(cur);
            return cells;
          });
      }

      const sheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetsCfg.spreadsheetId)}/values/${encodeURIComponent(sheetName)}?valueInputOption=USER_ENTERED`;
      const sheetsRes = await fetch(sheetsUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: rows }),
      });
      if (!sheetsRes.ok) {
        const msg = await sheetsRes.text();
        return corsError(502, `Sheets API error: ${msg}`);
      }
      const putHeaders = new Headers();
      addCorsHeaders(putHeaders);
      return new Response(null, { status: 204, headers: putHeaders });
    }

    // GET / HEAD: use Sheets API values endpoint and return a JSON array of objects.
    const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetsCfg.spreadsheetId)}/values/${encodeURIComponent(sheetName)}`;
    const valuesRes = await fetch(valuesUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!valuesRes.ok) {
      return corsError(502, `Sheets API error: ${valuesRes.status}`);
    }
    const valuesData = (await valuesRes.json()) as { values?: string[][] };
    const allRows = valuesData.values ?? [];
    const sheetsHeaders = allRows[0] ?? [];
    const jsonRows = allRows.slice(1).map((row) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < sheetsHeaders.length; i++) {
        obj[sheetsHeaders[i]!] = row[i] ?? "";
      }
      return obj;
    });
    const jsonBody = JSON.stringify(jsonRows);
    const getHeaders = new Headers({ "Content-Type": "application/json" });
    getHeaders.set("Content-Length", String(new TextEncoder().encode(jsonBody).length));
    addCorsHeaders(getHeaders);
    return new Response(method === "HEAD" ? null : jsonBody, { headers: getHeaders });
  }

  const row = backendRow;
  if (row.type !== "r2-s3compat") return new Response("Not Found", { status: 404 });
  const config = await decryptR2S3CompatConfig(row.encrypted_config, c.env.JWT_SECRET);
  if (!config) return new Response("Bad Gateway", { status: 502 });

  if (isList) {
    const queryParams: Record<string, string> = { "list-type": "2" };
    for (const [k, v] of reqUrl.searchParams) {
      if (k !== "list-type") queryParams[k] = v;
    }
    const { url, headers } = await signS3Request({
      method: "GET",
      endpoint: config.endpoint,
      bucket: config.bucket,
      key: "",
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      queryParams,
    });
    let upstream: Response;
    try {
      upstream = await fetch(url, { method: "GET", headers });
    } catch {
      return new Response("Bad Gateway", { status: 502 });
    }
    const listHeaders = new Headers({ "Content-Type": "application/xml" });
    addCorsHeaders(listHeaders);
    return new Response(upstream.body, { status: upstream.status, headers: listHeaders });
  }

  const isHead = method === "HEAD";
  const { url, headers } = await signS3Request({
    method: isHead ? "HEAD" : method,
    endpoint: config.endpoint,
    bucket: config.bucket,
    key,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });

  if (method === "PUT") {
    const putBody = c.req.raw.body;
    if (!putBody) return new Response("Bad Request", { status: 400 });
    const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: "PUT",
        headers: { ...headers, "Content-Type": contentType },
        body: putBody,
      });
    } catch {
      return new Response("Bad Gateway", { status: 502 });
    }
    const putHeaders = new Headers();
    const etag = upstream.headers.get("ETag");
    if (etag) putHeaders.set("ETag", etag);
    addCorsHeaders(putHeaders);
    return new Response(null, { status: upstream.status, headers: putHeaders });
  }

  const rangeHeader = c.req.header("Range");
  if (rangeHeader) headers.Range = rangeHeader;

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: isHead ? "HEAD" : "GET", headers });
  } catch {
    return new Response("Bad Gateway", { status: 502 });
  }

  const responseHeaders = new Headers();
  const contentLength = upstream.headers.get("Content-Length");
  if (contentLength) responseHeaders.set("Content-Length", contentLength);
  const contentType = upstream.headers.get("Content-Type");
  if (contentType) responseHeaders.set("Content-Type", contentType);
  const contentRange = upstream.headers.get("Content-Range");
  if (contentRange) responseHeaders.set("Content-Range", contentRange);
  const etag = upstream.headers.get("ETag");
  if (etag) responseHeaders.set("ETag", etag);
  responseHeaders.set("Accept-Ranges", "bytes");
  addCorsHeaders(responseHeaders);

  return new Response(isHead ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});
