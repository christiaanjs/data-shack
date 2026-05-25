import { decryptConfig } from "../crypto.ts";
import {
  getCredentialByNameOrId,
  getCredentialConfig,
  getStorageBackendByNameOrId,
  listHttpCredentials,
} from "../db/settings.ts";
import { decryptHttpConfig, resolveHeaderTemplates } from "../http-config.ts";
import { signS3Request } from "../storage/resolve.ts";
import type { Env } from "../types.ts";

const PROTOCOL_VERSION = "2025-03-26";
const MAX_RESULT_ROWS = 1000;
const MAX_READ_BYTES = 1_048_576; // 1 MB

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: Tool[] = [
  {
    name: "get_warehouse_schema",
    description:
      "List all catalog tables and their latest snapshot URIs, formats, and storage backends. No browser session required.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "run_query",
    description:
      "Execute a DuckDB SQL query against warehouse data. Requires an active browser tab to be open. Use catalog table names directly (e.g. SELECT * FROM transactions LIMIT 10) — views are pre-registered from snapshot URIs.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "DuckDB SQL to execute" },
        format: {
          type: "string",
          enum: ["table", "json", "csv"],
          description:
            "Output format. 'table' (default) = tab-separated with header, 'json' = array of objects, 'csv' = CSV with header row.",
        },
      },
      required: ["sql"],
    },
  },
  {
    name: "list_data_sources",
    description:
      "List all configured HTTP data source credentials. Returns id, name, and base URL for each. Use the name or id in http-ds://name/path URIs.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_data",
    description:
      "Read JSON or NDJSON data directly from a URI without requiring a browser session. Supports http-ds://credentialId/path for HTTP data sources and r2://backendName/key for R2 storage (both r2-bound and r2-s3compat backends). Size limit: 1 MB.",
    inputSchema: {
      type: "object",
      properties: {
        uri: {
          type: "string",
          description:
            "URI to read from. Examples: http-ds://cred_abc/accounts, r2://data-shack/reference/config.json",
        },
      },
      required: ["uri"],
    },
  },
];

function jsonRpcOk(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

function sseResponse(obj: unknown): Response {
  const body = `data: ${JSON.stringify(obj)}\n\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

export async function mcpHandler(
  request: Request,
  env: Env,
  userId: string,
  sessionStub: ReturnType<DurableObjectNamespace["get"]>,
  catalogStub: ReturnType<DurableObjectNamespace["get"]>,
): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return Response.json(jsonRpcError(null, -32700, "Parse error"), { status: 400 });
  }

  const { id, method, params } = body;

  // Notifications (no id) — acknowledge without a body.
  if (id === undefined) {
    return new Response(null, { status: 202 });
  }

  const useSSE = request.headers.get("Accept")?.includes("text/event-stream") ?? false;
  const respond = (result: unknown) => {
    const payload = jsonRpcOk(id, result);
    return useSSE ? sseResponse(payload) : Response.json(payload);
  };
  const respondError = (code: number, message: string, data?: unknown) => {
    const payload = jsonRpcError(id, code, message, data);
    return useSSE ? sseResponse(payload) : Response.json(payload);
  };

  // ── Method dispatch ───────────────────────────────────────────────────────

  if (method === "initialize") {
    return respond({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "data-shack", version: "1.0.0" },
    });
  }

  if (method === "tools/list") {
    return respond({ tools: TOOLS });
  }

  if (method === "tools/call") {
    const p = params as { name?: string; arguments?: Record<string, unknown> };
    const toolName = p?.name;
    const args = p?.arguments ?? {};

    if (toolName === "get_warehouse_schema") {
      return handleGetSchema(respond, respondError, catalogStub);
    }

    if (toolName === "run_query") {
      const sql = args.sql;
      if (typeof sql !== "string" || !sql.trim()) {
        return respondError(-32602, "sql is required");
      }
      const fmt = typeof args.format === "string" ? args.format : "table";
      return handleRunQuery(respond, respondError, sql, fmt, userId, sessionStub);
    }

    if (toolName === "list_data_sources") {
      return handleListDataSources(respond, respondError, userId, env);
    }

    if (toolName === "read_data") {
      const uri = args.uri;
      if (typeof uri !== "string" || !uri.trim()) {
        return respondError(-32602, "uri is required");
      }
      return handleReadData(respond, respondError, uri, userId, env);
    }

    return respondError(-32601, `Unknown tool: ${toolName}`);
  }

  return respondError(-32601, `Method not found: ${method}`);
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function handleGetSchema(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  catalogStub: ReturnType<DurableObjectNamespace["get"]>,
): Promise<Response> {
  const tablesRes = await catalogStub.fetch("http://do/tables");
  if (!tablesRes.ok) return respondError(-32603, "Failed to read catalog tables");

  const { tables } = (await tablesRes.json()) as {
    tables: { id: string; name: string; description: string | null; created_at: number }[];
  };

  if (tables.length === 0) {
    return respond({
      content: [{ type: "text", text: "No tables in catalog yet." }],
    });
  }

  const lines: string[] = ["# Warehouse Schema\n"];
  for (const table of tables) {
    const snapRes = await catalogStub.fetch(
      `http://do/snapshots/${encodeURIComponent(table.name)}`,
    );
    if (!snapRes.ok) continue;
    const { snapshots } = (await snapRes.json()) as {
      snapshots: {
        id: string;
        uri: string;
        storage_backend: string;
        format: string | null;
        created_at: number;
      }[];
    };

    lines.push(`## ${table.name}`);
    if (table.description) lines.push(table.description);
    if (snapshots.length === 0) {
      lines.push("  No snapshots.\n");
      continue;
    }
    const latest = snapshots[0]!;
    lines.push(`  Latest snapshot: ${latest.uri}`);
    if (latest.format) lines.push(`  Format: ${latest.format}`);
    lines.push(`  Backend: ${latest.storage_backend}`);
    lines.push(`  Snapshots: ${snapshots.length} total\n`);
  }

  return respond({ content: [{ type: "text", text: lines.join("\n") }] });
}

async function handleRunQuery(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string, data?: unknown) => Response,
  sql: string,
  fmt: string,
  userId: string,
  sessionStub: ReturnType<DurableObjectNamespace["get"]>,
): Promise<Response> {
  const queryRes = await sessionStub.fetch("http://do/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, userId }),
  });

  if (queryRes.status === 503) {
    const err = (await queryRes.json()) as { message?: string };
    return respondError(-32603, err.message ?? "No active browser session");
  }

  if (!queryRes.ok) {
    try {
      const err = (await queryRes.json()) as { message?: string };
      return respondError(-32603, err.message ?? "Query failed");
    } catch {
      return respondError(-32603, "Query failed");
    }
  }

  const result = (await queryRes.json()) as { columns: string[]; rows: unknown[][] };
  const truncated = result.rows.length > MAX_RESULT_ROWS;
  const rows = truncated ? result.rows.slice(0, MAX_RESULT_ROWS) : result.rows;

  if (fmt === "json") {
    const objects = rows.map((row) =>
      Object.fromEntries(result.columns.map((col, i) => [col, row[i]])),
    );
    const text = JSON.stringify(objects, null, 2);
    if (truncated) {
      return respond({
        content: [{ type: "text", text: `${text}\n\n(truncated to ${MAX_RESULT_ROWS} rows)` }],
      });
    }
    return respond({ content: [{ type: "text", text }] });
  }

  if (fmt === "csv") {
    const lines = [result.columns.join(",")];
    for (const row of rows) {
      lines.push(
        row
          .map((v) => {
            const s = v === null ? "" : String(v);
            return s.includes(",") || s.includes('"') || s.includes("\n")
              ? `"${s.replace(/"/g, '""')}"`
              : s;
          })
          .join(","),
      );
    }
    if (truncated) lines.push(`# truncated to ${MAX_RESULT_ROWS} rows`);
    return respond({ content: [{ type: "text", text: lines.join("\n") }] });
  }

  // default: table (tab-separated)
  const lines: string[] = [];
  lines.push(result.columns.join("\t"));
  for (const row of rows) {
    lines.push(row.map((v) => (v === null ? "NULL" : String(v))).join("\t"));
  }
  if (truncated) lines.push(`\n(truncated to ${MAX_RESULT_ROWS} rows)`);

  return respond({ content: [{ type: "text", text: lines.join("\n") }] });
}

async function handleListDataSources(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  userId: string,
  env: Env,
): Promise<Response> {
  const credentials = await listHttpCredentials(env.DB, userId);
  const results: { id: string; name: string; baseUrl: string }[] = [];
  for (const cred of credentials) {
    const row = await getCredentialConfig(env.DB, cred.id, userId);
    if (!row) continue;
    const config = await decryptHttpConfig(row.encrypted_config, env.JWT_SECRET);
    if (!config) continue;
    results.push({ id: cred.id, name: cred.name, baseUrl: config.baseUrl });
  }
  if (results.length === 0) {
    return respond({ content: [{ type: "text", text: "No HTTP data sources configured." }] });
  }
  const lines = results.map((r) => `- **${r.name}** (${r.id}): ${r.baseUrl}`);
  return respond({ content: [{ type: "text", text: lines.join("\n") }] });
}

async function handleReadData(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  uri: string,
  userId: string,
  env: Env,
): Promise<Response> {
  if (uri.startsWith("http-ds://")) {
    return handleReadHttpDs(respond, respondError, uri, userId, env);
  }

  if (uri.startsWith("r2://") || uri.startsWith("r2-s3compat://")) {
    return handleReadR2(respond, respondError, uri, userId, env);
  }

  return respondError(-32602, "Unsupported URI scheme. Supported: http-ds://, r2://");
}

async function handleReadHttpDs(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  uri: string,
  userId: string,
  env: Env,
): Promise<Response> {
  // http-ds://credentialId/path
  const rest = uri.slice("http-ds://".length);
  const slash = rest.indexOf("/");
  const credentialId = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/" : rest.slice(slash);

  const row = await getCredentialByNameOrId(env.DB, credentialId, userId);
  if (!row || row.type !== "http")
    return respondError(-32602, `HTTP credential not found: ${credentialId}`);

  const config = await decryptHttpConfig(row.encrypted_config, env.JWT_SECRET);
  if (!config) return respondError(-32603, "Failed to decrypt credential config");

  const url = config.baseUrl.replace(/\/$/, "") + path;

  const resolvedHeaders = resolveHeaderTemplates(config.headers, config.variables);

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: "GET", headers: resolvedHeaders });
  } catch {
    return respondError(-32603, "Failed to fetch from HTTP data source");
  }

  if (!upstream.ok) {
    return respondError(-32603, `HTTP data source returned ${upstream.status}`);
  }

  return readAndReturnJson(respond, respondError, upstream);
}

async function handleReadR2(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  uri: string,
  userId: string,
  env: Env,
): Promise<Response> {
  const scheme = uri.startsWith("r2://") ? "r2://" : "r2-s3compat://";
  const rest = uri.slice(scheme.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return respondError(-32602, "Invalid URI: missing key after backend name");

  const backendName = rest.slice(0, slash);
  const key = rest.slice(slash + 1);

  // Built-in R2 binding.
  if (backendName === "r2-bound" || backendName === "data-shack") {
    const obj = await env.R2.get(`users/${userId}/${key}`);
    if (!obj) return respondError(-32602, `Object not found: ${uri}`);
    if (obj.size > MAX_READ_BYTES) {
      return respondError(-32602, `Object too large (${obj.size} bytes, limit 1 MB)`);
    }
    const text = await obj.text();
    return parseAndRespond(respond, respondError, text, obj.httpMetadata?.contentType);
  }

  // Named backend via D1 lookup.
  const backend = await getStorageBackendByNameOrId(env.DB, backendName, userId);
  if (!backend) return respondError(-32602, `Storage backend not found: ${backendName}`);

  if (backend.type !== "r2-s3compat") {
    return respondError(-32602, `Direct read not supported for backend type: ${backend.type}`);
  }

  let s3Config: {
    bucket: string;
    region: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  try {
    s3Config = JSON.parse(
      await decryptConfig(backend.encrypted_config, env.JWT_SECRET),
    ) as typeof s3Config;
  } catch {
    return respondError(-32603, "Failed to decrypt backend config");
  }

  let signedUrl: string;
  let signedHeaders: Record<string, string>;
  try {
    const signed = await signS3Request({
      method: "GET",
      endpoint: s3Config.endpoint,
      bucket: s3Config.bucket,
      key,
      region: s3Config.region,
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
    });
    signedUrl = signed.url;
    signedHeaders = signed.headers;
  } catch {
    return respondError(-32603, "Failed to sign S3 request");
  }

  let upstream: Response;
  try {
    upstream = await fetch(signedUrl, { method: "GET", headers: signedHeaders });
  } catch {
    return respondError(-32603, "Failed to fetch from S3-compatible backend");
  }

  if (!upstream.ok) {
    return respondError(-32603, `Backend returned ${upstream.status}`);
  }

  return readAndReturnJson(respond, respondError, upstream);
}

async function readAndReturnJson(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  upstream: Response,
): Promise<Response> {
  const ct = upstream.headers.get("Content-Type") ?? "";
  const buf = await upstream.arrayBuffer();
  if (buf.byteLength > MAX_READ_BYTES) {
    return respondError(-32602, `Response too large (${buf.byteLength} bytes, limit 1 MB)`);
  }
  const text = new TextDecoder().decode(buf);
  return parseAndRespond(respond, respondError, text, ct);
}

function parseAndRespond(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  text: string,
  contentType?: string | null,
): Response {
  // Try to parse as JSON or NDJSON.
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return respond({ content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] });
    } catch {
      // Fall through to NDJSON.
    }
  }

  // Try NDJSON (one JSON object per line).
  const lines = trimmed.split("\n").filter((l) => l.trim());
  const objects: unknown[] = [];
  let parseError = false;
  for (const line of lines) {
    try {
      objects.push(JSON.parse(line));
    } catch {
      parseError = true;
      break;
    }
  }

  if (!parseError && objects.length > 0) {
    return respond({
      content: [{ type: "text", text: JSON.stringify(objects, null, 2) }],
    });
  }

  if (contentType && !contentType.includes("json") && !contentType.includes("text")) {
    return respondError(
      -32602,
      `Non-text content type: ${contentType}. Only JSON/NDJSON is supported.`,
    );
  }

  // Return raw text as fallback.
  return respond({ content: [{ type: "text", text: trimmed }] });
}
