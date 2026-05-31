import { decryptConfig } from "../crypto.ts";
import type { LoadJob } from "../db/load-jobs.ts";
import { getCredentialConfig, getStorageBackendConfig } from "../db/settings.ts";
import { decryptHttpConfig, resolveHeaderTemplates } from "../http-config.ts";
import { r2BoundKey, signS3Request } from "../storage/resolve.ts";
import type { Env } from "../types.ts";
import {
  type DateRangeConfig,
  type PaginationConfig,
  validateDateRangeConfig,
  validatePaginationConfig,
} from "./config-types.ts";

function getAtPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce(
      (acc, key) =>
        acc !== null && acc !== undefined && typeof acc === "object"
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      obj,
    );
}

function formatDate(date: Date, fmt: DateRangeConfig["format"]): string {
  switch (fmt) {
    case "iso":
      return date.toISOString();
    case "iso_date":
      return date.toISOString().split("T")[0]!;
    case "unix":
      return String(Math.floor(date.getTime() / 1000));
    case "unix_ms":
      return String(date.getTime());
    default:
      throw new Error(`Unknown date format: ${fmt as string}`);
  }
}

async function toFixedLengthBody(response: Response): Promise<ReadableStream | ArrayBuffer> {
  const len = response.headers.get("Content-Length");
  if (len && response.body) {
    const fixed = new FixedLengthStream(Number(len));
    response.body.pipeTo(fixed.writable);
    return fixed.readable;
  }
  return response.arrayBuffer();
}

function extractXmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1]! : "";
}

// ── Paginated write helpers ───────────────────────────────────────────────────

async function writePaginatedToR2(
  pages: AsyncGenerator<unknown[]>,
  format: string,
  r2: R2Bucket,
  r2Key: string,
): Promise<void> {
  const enc = new TextEncoder();
  const MIN_PART = 5 * 1024 * 1024;

  const upload = await r2.createMultipartUpload(r2Key);
  const parts: R2UploadedPart[] = [];
  let partNum = 0;
  let buf: Uint8Array[] = [];
  let bufSize = 0;
  let first = true;

  function enqueue(s: string): void {
    const chunk = enc.encode(s);
    buf.push(chunk);
    bufSize += chunk.length;
  }

  async function flushPart(isLast: boolean): Promise<void> {
    if (buf.length === 0) return;
    if (!isLast && bufSize < MIN_PART) return;
    partNum++;
    const combined = new Uint8Array(bufSize);
    let offset = 0;
    for (const chunk of buf) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    buf = [];
    bufSize = 0;
    parts.push(await upload.uploadPart(partNum, combined));
  }

  try {
    if (format === "json") enqueue("[");

    for await (const items of pages) {
      for (const item of items) {
        if (format === "ndjson") {
          enqueue(`${JSON.stringify(item)}\n`);
        } else {
          if (!first) enqueue(",");
          enqueue(JSON.stringify(item));
          first = false;
        }
      }
      await flushPart(false);
    }

    if (format === "json") enqueue("]");
    await flushPart(true);
  } catch (err) {
    await upload.abort();
    throw err;
  }

  await upload.complete(parts);
}

async function writePaginatedToS3Multipart(
  pages: AsyncGenerator<unknown[]>,
  format: string,
  s3Config: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    region: string;
  },
  key: string,
): Promise<void> {
  const enc = new TextEncoder();
  const MIN_PART = 5 * 1024 * 1024; // 5 MB minimum S3 part size

  // 1. Initiate multipart upload
  const { url: initUrl, headers: initHeaders } = await signS3Request({
    method: "POST",
    ...s3Config,
    key,
    queryParams: { uploads: "" },
  });
  const initRes = await fetch(initUrl, { method: "POST", headers: initHeaders });
  if (!initRes.ok) {
    throw new Error(`S3 multipart initiate failed: ${initRes.status} ${initRes.statusText}`);
  }
  const uploadId = extractXmlTag(await initRes.text(), "UploadId");
  if (!uploadId) throw new Error("S3 multipart initiate returned no UploadId");

  const parts: { partNumber: number; etag: string }[] = [];
  let partNum = 0;
  let buf: Uint8Array[] = [];
  let bufSize = 0;
  let first = true;

  async function flushPart(isLast: boolean): Promise<void> {
    if (buf.length === 0) return;
    if (!isLast && bufSize < MIN_PART) return;
    partNum++;
    const combined = new Uint8Array(bufSize);
    let offset = 0;
    for (const chunk of buf) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    buf = [];
    bufSize = 0;

    const { url: partUrl, headers: partHeaders } = await signS3Request({
      method: "PUT",
      ...s3Config,
      key,
      queryParams: { partNumber: String(partNum), uploadId },
    });
    const partRes = await fetch(partUrl, {
      method: "PUT",
      headers: { ...partHeaders, "Content-Length": String(combined.byteLength) },
      body: combined,
    });
    if (!partRes.ok) {
      throw new Error(`S3 multipart upload part ${partNum} failed: ${partRes.status}`);
    }
    const etag = partRes.headers.get("ETag") ?? "";
    parts.push({ partNumber: partNum, etag });
  }

  function enqueue(chunk: Uint8Array): void {
    buf.push(chunk);
    bufSize += chunk.length;
  }

  try {
    if (format === "json") enqueue(enc.encode("["));

    for await (const items of pages) {
      for (const item of items) {
        if (format === "ndjson") {
          enqueue(enc.encode(`${JSON.stringify(item)}\n`));
        } else {
          if (!first) enqueue(enc.encode(","));
          enqueue(enc.encode(JSON.stringify(item)));
          first = false;
        }
      }
      await flushPart(false);
    }

    if (format === "json") enqueue(enc.encode("]"));
    await flushPart(true);
  } catch (err) {
    // Abort multipart upload on any error
    const { url: abortUrl, headers: abortHeaders } = await signS3Request({
      method: "DELETE",
      ...s3Config,
      key,
      queryParams: { uploadId },
    });
    await fetch(abortUrl, { method: "DELETE", headers: abortHeaders }).catch(() => {});
    throw err;
  }

  // 3. Complete multipart upload
  const xmlParts = parts
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
    .join("");
  const completeXml = enc.encode(`<CompleteMultipartUpload>${xmlParts}</CompleteMultipartUpload>`);
  const { url: completeUrl, headers: completeHeaders } = await signS3Request({
    method: "POST",
    ...s3Config,
    key,
    queryParams: { uploadId },
  });
  const completeRes = await fetch(completeUrl, {
    method: "POST",
    headers: { ...completeHeaders, "Content-Length": String(completeXml.byteLength) },
    body: completeXml,
  });
  if (!completeRes.ok) {
    throw new Error(
      `S3 multipart complete failed: ${completeRes.status} ${completeRes.statusText}`,
    );
  }
}

// ── Main loader ───────────────────────────────────────────────────────────────

export async function runHttpLoadJob(
  job: LoadJob,
  env: Env,
): Promise<{ uri: string; triggeredJobIds: string[] }> {
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
  const urlObj = new URL(httpConfig.baseUrl.replace(/\/$/, "") + path);

  // Apply date range params if configured
  let dateRangeCfg: DateRangeConfig | null = null;
  if (job.date_range_config) {
    try {
      dateRangeCfg = validateDateRangeConfig(JSON.parse(job.date_range_config));
    } catch {
      /* fall through to null */
    }
    if (!dateRangeCfg) throw new Error(`Invalid date_range_config for job: ${job.id}`);
  }
  if (dateRangeCfg) {
    const now = new Date();
    const start = new Date(now.getTime() - dateRangeCfg.lookback_days * 86_400_000);
    urlObj.searchParams.set(dateRangeCfg.param_from, formatDate(start, dateRangeCfg.format));
    urlObj.searchParams.set(dateRangeCfg.param_to, formatDate(now, dateRangeCfg.format));
  }

  // 3. Compute destination key
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = job.format === "ndjson" ? "ndjson" : job.format;
  const tableDir = job.table_path.trim() || job.table_name;
  const filename = `load-${timestamp}.${ext}`;

  // 4. Fetch and decrypt storage backend
  const backendRow = await getStorageBackendConfig(env.DB, job.storage_backend_id, job.user_id);
  if (!backendRow) {
    throw new Error(`Storage backend not found: ${job.storage_backend_id}`);
  }

  // 5. Execute: paginated or single-request
  let paginationCfg: PaginationConfig | null = null;
  if (job.pagination_config) {
    try {
      paginationCfg = validatePaginationConfig(JSON.parse(job.pagination_config));
    } catch {
      /* fall through to null */
    }
    if (!paginationCfg) throw new Error(`Invalid pagination_config for job: ${job.id}`);
  }

  let uri: string;

  if (paginationCfg) {
    // Paginated path — iterate pages, write to storage
    const rawMaxPages = Number.parseInt(env.MAX_PAGINATION_PAGES ?? "45", 10);
    const maxPages = Number.isFinite(rawMaxPages) && rawMaxPages > 0 ? rawMaxPages : 45;

    async function* fetchPages(): AsyncGenerator<unknown[]> {
      let cursor: string | undefined;
      let pageCount = 0;
      const pageUrl = new URL(urlObj.toString());

      while (true) {
        if (cursor) pageUrl.searchParams.set(paginationCfg!.cursor_param, cursor);

        const res = await fetch(pageUrl.toString(), {
          method: job.http_method,
          headers: resolvedHeaders,
        });
        if (!res.ok) {
          throw new Error(`Upstream HTTP error: ${res.status} ${res.statusText}`);
        }

        const json = await res.json<unknown>();
        const items = paginationCfg!.data_path
          ? (getAtPath(json, paginationCfg!.data_path) as unknown[])
          : (json as unknown[]);
        if (!Array.isArray(items)) {
          throw new Error(
            `Paginated response data is not an array${paginationCfg!.data_path ? ` at path "${paginationCfg!.data_path}"` : ""}`,
          );
        }

        yield items;

        const nextCursor = getAtPath(json, paginationCfg!.cursor_path);
        if (!nextCursor || typeof nextCursor !== "string") break;

        pageCount++;
        if (pageCount >= maxPages) {
          throw new Error(
            `Pagination exceeded MAX_PAGINATION_PAGES (${maxPages}). Increase MAX_PAGINATION_PAGES env var or reduce the lookback window.`,
          );
        }
        cursor = nextCursor;
      }
    }

    if (backendRow.type === "r2-bound") {
      const relPath = `${tableDir}/${filename}`;
      await writePaginatedToR2(fetchPages(), job.format, env.R2, r2BoundKey(job.user_id, relPath));
      uri = `r2://${backendRow.name}/${relPath}`;
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
      await writePaginatedToS3Multipart(fetchPages(), job.format, raw, key);
      uri = `r2-s3compat://${job.storage_backend_id}/${key}`;
    } else {
      throw new Error(`Unsupported storage backend type: ${backendRow.type}`);
    }
  } else {
    // Single-request path (original logic)
    const upstream = await fetch(urlObj.toString(), {
      method: job.http_method,
      headers: resolvedHeaders,
    });
    if (!upstream.ok) {
      throw new Error(`Upstream HTTP error: ${upstream.status} ${upstream.statusText}`);
    }
    if (!upstream.body) {
      throw new Error("Upstream response has no body");
    }

    if (backendRow.type === "r2-bound") {
      const relPath = `${tableDir}/${filename}`;
      const r2Body = await toFixedLengthBody(upstream);
      await env.R2.put(r2BoundKey(job.user_id, relPath), r2Body);
      uri = `r2://${backendRow.name}/${relPath}`;
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

  const commitData = (await commitRes.json()) as { triggeredJobIds?: string[] };
  return { uri, triggeredJobIds: commitData.triggeredJobIds ?? [] };
}
