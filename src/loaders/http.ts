import { decryptConfig } from "../crypto.ts";
import type { LoadJob } from "../db/load-jobs.ts";
import { getCredentialConfig, getStorageBackendConfig } from "../db/settings.ts";
import { decryptHttpConfig, resolveHeaderTemplates } from "../http-config.ts";
import { r2BoundKey, signS3Request } from "../storage/resolve.ts";
import type { Env } from "../types.ts";

async function toFixedLengthBody(response: Response): Promise<ReadableStream | ArrayBuffer> {
  const len = response.headers.get("Content-Length");
  if (len && response.body) {
    const fixed = new FixedLengthStream(Number(len));
    response.body.pipeTo(fixed.writable);
    return fixed.readable;
  }
  return response.arrayBuffer();
}

export async function runHttpLoadJob(job: LoadJob, env: Env): Promise<{ uri: string }> {
  // 1. Fetch and decrypt HTTP credential
  const credRow = await getCredentialConfig(env.DB, job.credential_id, job.user_id);
  if (!credRow || credRow.type !== "http") {
    throw new Error(`HTTP credential not found: ${job.credential_id}`);
  }
  const httpConfig = await decryptHttpConfig(credRow.encrypted_config, env.JWT_SECRET);
  if (!httpConfig) {
    throw new Error(`Invalid HTTP config for credential: ${job.credential_id}`);
  }

  // 2. Resolve header templates and build URL
  const resolvedHeaders = resolveHeaderTemplates(httpConfig.headers, httpConfig.variables);
  const path = job.http_path.startsWith("/") ? job.http_path : `/${job.http_path}`;
  const url = httpConfig.baseUrl.replace(/\/$/, "") + path;

  // 3. Fetch from HTTP data source
  const upstream = await fetch(url, { method: job.http_method, headers: resolvedHeaders });
  if (!upstream.ok) {
    throw new Error(`Upstream HTTP error: ${upstream.status} ${upstream.statusText}`);
  }
  if (!upstream.body) {
    throw new Error("Upstream response has no body");
  }

  // 4. Compute destination key (backend-specific namespacing applied below)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = job.format === "ndjson" ? "ndjson" : job.format;
  const tableDir = job.table_path.trim() || job.table_name;
  const filename = `load-${timestamp}.${ext}`;

  // 5. Fetch and decrypt storage backend, then write
  const backendRow = await getStorageBackendConfig(env.DB, job.storage_backend_id, job.user_id);
  if (!backendRow) {
    throw new Error(`Storage backend not found: ${job.storage_backend_id}`);
  }

  let uri: string;

  if (backendRow.type === "r2-bound") {
    let raw: { bucket: string };
    try {
      raw = JSON.parse(await decryptConfig(backendRow.encrypted_config, env.JWT_SECRET)) as {
        bucket: string;
      };
    } catch {
      throw new Error(`Invalid storage backend config for: ${job.storage_backend_id}`);
    }
    const relPath = `${tableDir}/${filename}`;
    const r2Body = await toFixedLengthBody(upstream);
    await env.R2.put(r2BoundKey(job.user_id, relPath), r2Body);
    uri = `r2://${raw.bucket}/${relPath}`;
  } else if (backendRow.type === "r2-s3compat") {
    let raw: {
      endpoint: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
      region: string;
    };
    try {
      raw = JSON.parse(
        await decryptConfig(backendRow.encrypted_config, env.JWT_SECRET),
      ) as typeof raw;
    } catch {
      throw new Error(`Invalid storage backend config for: ${job.storage_backend_id}`);
    }
    const key = `${tableDir}/${filename}`;
    const putBody = await toFixedLengthBody(upstream);
    const contentLength =
      putBody instanceof ArrayBuffer
        ? String(putBody.byteLength)
        : upstream.headers.get("Content-Length")!;
    const { url: s3Url, headers: s3Headers } = await signS3Request({
      method: "PUT",
      endpoint: raw.endpoint,
      bucket: raw.bucket,
      key,
      region: raw.region,
      accessKeyId: raw.accessKeyId,
      secretAccessKey: raw.secretAccessKey,
    });
    const putRes = await fetch(s3Url, {
      method: "PUT",
      headers: { ...s3Headers, "Content-Length": contentLength },
      body: putBody,
    });
    if (!putRes.ok) {
      throw new Error(`S3 PUT failed: ${putRes.status} ${putRes.statusText}`);
    }
    uri = `r2-s3compat://${job.storage_backend_id}/${key}`;
  } else {
    throw new Error(`Unsupported storage backend type: ${backendRow.type}`);
  }

  // 6. Commit to catalog DO
  const stub = env.CATALOG.get(env.CATALOG.idFromName(job.user_id));
  const commitRes = await stub.fetch(
    new Request("http://internal/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table: job.table_name,
        uri,
        storageBackend: job.storage_backend_id,
        format: job.format,
        message: `Load job: ${job.name}`,
      }),
    }),
  );
  if (!commitRes.ok) {
    const text = await commitRes.text();
    throw new Error(`Catalog commit failed: ${commitRes.status} ${text}`);
  }

  return { uri };
}
