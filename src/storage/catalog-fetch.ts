import { getStorageBackendByNameOrId, getStorageBackendConfig } from "../db/settings.ts";
import type { Env } from "../types.ts";
import { parseR2S3CompatUri, parseR2Uri, r2BoundKey, signS3Request } from "./resolve.ts";
import { decryptR2S3CompatConfig } from "./router.ts";

export interface SnapshotInfo {
  uri: string;
  format: string | null;
  storage_backend: string;
  access_mode: string;
}

// Resolves a catalog table name to its latest snapshot via the catalog DO.
export async function resolveTableSnapshot(
  tableName: string,
  catalogStub: ReturnType<DurableObjectNamespace["get"]>,
): Promise<SnapshotInfo | null> {
  const res = await catalogStub.fetch(`http://do/snapshots/${encodeURIComponent(tableName)}`);
  if (!res.ok) return null;
  const { snapshots } = (await res.json()) as { snapshots: SnapshotInfo[] };
  return snapshots[0] ?? null;
}

// Returns the effective format for a snapshot, falling back to URI extension heuristics.
export function inferSnapshotFormat(format: string | null, uri: string): string {
  if (format) return format;
  if (uri.endsWith(".parquet")) return "parquet";
  if (uri.endsWith(".csv")) return "csv";
  if (uri.endsWith(".ndjson") || uri.endsWith(".jsonl")) return "ndjson";
  return "json";
}

// Returns true if the format can be read without DuckDB (JSON/NDJSON only).
export function isProxyReadableFormat(format: string): boolean {
  return format === "json" || format === "ndjson";
}

// Returns true if the URI scheme is supported for direct proxy reads.
export function isProxyReadableUri(uri: string): boolean {
  return uri.startsWith("r2://") || uri.startsWith("r2-s3compat://");
}

// Fetches the raw object at the given r2:// or r2-s3compat:// URI, authenticated as userId.
// Returns a streaming Response. The caller is responsible for size limits.
// On error (404, 400, 502) the response body contains a plain-text description.
export async function fetchStorageUri(uri: string, userId: string, env: Env): Promise<Response> {
  if (uri.startsWith("r2://")) {
    const parsed = parseR2Uri(uri);
    if (!parsed) return new Response("Invalid r2:// URI", { status: 400 });
    return fetchR2Bucket(parsed.bucket, parsed.key, userId, env);
  }

  if (uri.startsWith("r2-s3compat://")) {
    const parsed = parseR2S3CompatUri(uri);
    if (!parsed) return new Response("Invalid r2-s3compat:// URI", { status: 400 });
    const backendRow = await getStorageBackendConfig(env.DB, parsed.backendId, userId);
    if (!backendRow || backendRow.type !== "r2-s3compat") {
      return new Response("Storage backend not found", { status: 404 });
    }
    const cfg = await decryptR2S3CompatConfig(backendRow.encrypted_config, env.JWT_SECRET);
    if (!cfg) return new Response("Bad Gateway", { status: 502 });
    return fetchS3Object(cfg, parsed.key);
  }

  return new Response("Unsupported URI scheme", { status: 400 });
}

async function fetchR2Bucket(
  bucket: string,
  key: string,
  userId: string,
  env: Env,
): Promise<Response> {
  if (bucket === "r2-bound" || bucket === "data-shack") {
    const obj = await env.R2.get(r2BoundKey(userId, key));
    if (!obj) return new Response("Not Found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
        "Content-Length": String(obj.size),
      },
    });
  }

  // Named backend → look up by name first, then by ID.
  const backendRow = await getStorageBackendByNameOrId(env.DB, bucket, userId);
  if (!backendRow || backendRow.type !== "r2-s3compat") {
    return new Response("Storage backend not found", { status: 404 });
  }
  const cfg = await decryptR2S3CompatConfig(backendRow.encrypted_config, env.JWT_SECRET);
  if (!cfg) return new Response("Bad Gateway", { status: 502 });
  return fetchS3Object(cfg, key);
}

async function fetchS3Object(
  cfg: {
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  },
  key: string,
): Promise<Response> {
  const { url, headers } = await signS3Request({
    method: "GET",
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    key,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
  try {
    return await fetch(url, { headers });
  } catch {
    return new Response("Failed to fetch from storage backend", { status: 502 });
  }
}
