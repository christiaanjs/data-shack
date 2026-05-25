import { decryptConfig } from "../crypto.ts";
import type { LoadJob } from "../db/load-jobs.ts";
import { getCredentialConfig } from "../db/settings.ts";
import { r2BoundKey, signS3Request } from "../storage/resolve.ts";
import type { Env } from "../types.ts";

export interface GoogleSheetsConfig {
  spreadsheetId: string;
  sheetName?: string;
  range?: string;
}

export interface GoogleSheetsCredential {
  refreshToken: string;
}

export async function refreshGoogleAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token refresh failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export async function runGoogleSheetsLoadJob(
  job: LoadJob,
  env: Env,
): Promise<{ uri: string; triggeredJobIds: string[] }> {
  if (!job.source_config) {
    throw new Error(`google-sheets load job ${job.id} missing source_config`);
  }

  const sheetsCfg = JSON.parse(job.source_config) as GoogleSheetsConfig;
  const { spreadsheetId } = sheetsCfg;
  const sheetName = sheetsCfg.sheetName ?? "Sheet1";
  const range = sheetsCfg.range ?? `${sheetName}!A:ZZ`;

  // Fetch and decrypt the google-sheets credential.
  const credRow = await getCredentialConfig(env.DB, job.credential_id, job.user_id);
  if (!credRow || credRow.type !== "google-sheets") {
    throw new Error(`google-sheets credential not found: ${job.credential_id}`);
  }
  const cred = JSON.parse(
    await decryptConfig(credRow.encrypted_config, env.JWT_SECRET),
  ) as GoogleSheetsCredential;

  const accessToken = await refreshGoogleAccessToken(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    cred.refreshToken,
  );

  // Fetch sheet data via Sheets API v4.
  const sheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const sheetsRes = await fetch(sheetsUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!sheetsRes.ok) {
    const text = await sheetsRes.text();
    throw new Error(`Sheets API error: ${sheetsRes.status} ${text}`);
  }
  const sheetsData = (await sheetsRes.json()) as { values?: string[][] };
  const values = sheetsData.values ?? [];

  if (values.length === 0) {
    throw new Error(`Google Sheet ${spreadsheetId} range ${range} returned no data`);
  }

  // Convert string[][] to NDJSON (first row = headers).
  const [headers, ...dataRows] = values;
  const enc = new TextEncoder();
  const ndjsonChunks: Uint8Array[] = [];
  for (const row of dataRows) {
    const record: Record<string, string | null> = {};
    for (let i = 0; i < headers!.length; i++) {
      record[headers![i]!] = row[i] ?? null;
    }
    ndjsonChunks.push(enc.encode(`${JSON.stringify(record)}\n`));
  }
  const totalSize = ndjsonChunks.reduce((s, c) => s + c.byteLength, 0);
  const ndjsonBody = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of ndjsonChunks) {
    ndjsonBody.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // Compute destination key and write to storage backend.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tableDir = job.table_path.trim() || job.table_name;
  const filename = `load-${timestamp}.ndjson`;
  const relPath = `${tableDir}/${filename}`;

  const { getStorageBackendConfig } = await import("../db/settings.ts");
  const backendRow = await getStorageBackendConfig(env.DB, job.storage_backend_id, job.user_id);
  if (!backendRow) {
    throw new Error(`Storage backend not found: ${job.storage_backend_id}`);
  }

  let uri: string;

  if (backendRow.type === "r2-bound") {
    const raw = JSON.parse(await decryptConfig(backendRow.encrypted_config, env.JWT_SECRET)) as {
      bucket: string;
    };
    await env.R2.put(r2BoundKey(job.user_id, relPath), ndjsonBody);
    uri = `r2://${raw.bucket}/${relPath}`;
  } else if (backendRow.type === "r2-s3compat") {
    const raw = JSON.parse(await decryptConfig(backendRow.encrypted_config, env.JWT_SECRET)) as {
      endpoint: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
      region: string;
    };
    const { url: s3Url, headers: s3Headers } = await signS3Request({
      method: "PUT",
      endpoint: raw.endpoint,
      bucket: raw.bucket,
      key: relPath,
      region: raw.region,
      accessKeyId: raw.accessKeyId,
      secretAccessKey: raw.secretAccessKey,
    });
    const putRes = await fetch(s3Url, {
      method: "PUT",
      headers: { ...s3Headers, "Content-Length": String(ndjsonBody.byteLength) },
      body: ndjsonBody,
    });
    if (!putRes.ok) {
      throw new Error(`S3 PUT failed: ${putRes.status} ${putRes.statusText}`);
    }
    uri = `r2-s3compat://${job.storage_backend_id}/${relPath}`;
  } else {
    throw new Error(`Unsupported storage backend type for google-sheets job: ${backendRow.type}`);
  }

  // Commit to catalog DO.
  const stub = env.CATALOG.get(env.CATALOG.idFromName(job.user_id));
  const commitRes = await stub.fetch(
    new Request("http://internal/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table: job.table_name,
        uri,
        storageBackend: job.storage_backend_id,
        format: "ndjson",
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
