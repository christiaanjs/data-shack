import {
  getDashboardByIdOrSlug,
  insertDashboard,
  listDashboards,
  resolveUniqueSlug,
  slugify,
  snapshotDashboard,
  updateDashboard,
} from "../db/dashboards.ts";
import {
  deleteLoadJob,
  getLoadJob,
  insertLoadJob,
  listLoadJobs,
  setLoadJobEnabled,
  updateLoadJob,
} from "../db/load-jobs.ts";
import {
  getCredentialByNameOrId,
  getCredentialConfig,
  getStorageBackendByNameOrId,
  listHttpCredentials,
} from "../db/settings.ts";
import { decryptHttpConfig, resolveHeaderTemplates } from "../http-config.ts";
import { validateDateRangeConfig, validatePaginationConfig } from "../loaders/config-types.ts";
import {
  fetchStorageUri,
  inferSnapshotFormat,
  isProxyReadableFormat,
  isProxyReadableUri,
  resolveTableSnapshot,
} from "../storage/catalog-fetch.ts";
import type { Env } from "../types.ts";

const PROTOCOL_VERSION = "2025-03-26";
const MAX_RESULT_ROWS = 1000;
const MAX_READ_BYTES = 1_048_576; // 1 MB
const SAFE_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const VALID_HTTP_METHODS = ["GET", "POST"] as const;
const VALID_FORMATS = ["json", "ndjson", "csv", "parquet"] as const;

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
      "Read JSON or NDJSON data directly from a URI without requiring a browser session. Supports http-ds://credentialId/path for HTTP data sources, r2://backendName/key for R2 storage (both r2-bound and r2-s3compat backends), and catalog://tableName to read the latest snapshot of a catalog table from its storage backend. Size limit: 1 MB.",
    inputSchema: {
      type: "object",
      properties: {
        uri: {
          type: "string",
          description:
            "URI to read from. Examples: http-ds://cred_abc/accounts, r2://data-shack/reference/config.json, catalog://transactions",
        },
      },
      required: ["uri"],
    },
  },
  {
    name: "submit_dashboard",
    description:
      "Persist a React dashboard artifact with bound SQL queries so it survives beyond this conversation. Call this once you and the user have finalised a visualisation. The component named `Dashboard` receives `props.data`: an array where `data[i]` is an array of row objects (plain key/value pairs) for `queries[i]`. Can use React hooks and Recharts (BarChart, LineChart, PieChart, AreaChart, etc.) which are pre-loaded in the rendering environment.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Dashboard title shown in the UI",
        },
        artifact_source: {
          type: "string",
          description:
            "JSX source for a React component. Must be the default export: `export default function Dashboard({ data }) { ... }`. `data[i]` is an array of row objects for `queries[i]`. Use standard ES module imports — `import { useState } from 'react'`, `import { BarChart, RadarChart } from 'recharts'`, etc. Any named export from `react`, `react-dom`, or `recharts` is importable.",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            "SQL queries executed against the warehouse. Results are passed as `data[0]`, `data[1]`, etc.",
        },
        slug: {
          type: "string",
          description:
            "URL-friendly slug for referencing the dashboard (e.g. spending-breakdown). Auto-generated from the title if omitted.",
        },
      },
      required: ["title", "artifact_source", "queries"],
    },
  },
  {
    name: "list_dashboards",
    description: "List all saved dashboards. Returns id, slug, title, and creation date for each.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_dashboard",
    description:
      "Retrieve the full source code and queries of a saved dashboard by its id or slug. Use this before updating a dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        id_or_slug: {
          type: "string",
          description: "Dashboard id (dash_...) or URL slug (e.g. spending-breakdown)",
        },
      },
      required: ["id_or_slug"],
    },
  },
  {
    name: "update_dashboard",
    description:
      "Update an existing dashboard's title, artifact source, queries, or slug. The previous version is automatically snapshotted. At least one field must be provided.",
    inputSchema: {
      type: "object",
      properties: {
        id_or_slug: {
          type: "string",
          description: "Dashboard id (dash_...) or slug to update",
        },
        title: { type: "string", description: "New title" },
        artifact_source: {
          type: "string",
          description:
            "New JSX source for the Dashboard component. Same ES module import rules as submit_dashboard.",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "New SQL queries. Replaces the existing queries array.",
        },
        slug: {
          type: "string",
          description:
            "New URL slug. Will be slugified and made unique. Pass empty string to clear the slug.",
        },
      },
      required: ["id_or_slug"],
    },
  },
  {
    name: "list_load_jobs",
    description:
      "List all load job definitions with their schedule, source type, and last-run status. No browser session required.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_load_job",
    description:
      "Define a new cron-triggered load job that pulls from an HTTP API or Google Sheet and writes to a storage backend, committing the result to the catalog. Runs entirely server-side — no browser session required.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable job name" },
        table_name: {
          type: "string",
          description: "Catalog table name to commit results to. Must match [a-zA-Z_][a-zA-Z0-9_]*",
        },
        credential: {
          type: "string",
          description:
            "Name or id of the credential to use — an http credential for source_type 'http', or a google-sheets credential for source_type 'google-sheets'",
        },
        storage_backend: {
          type: "string",
          description: "Name or id of the storage backend to write output to",
        },
        source_type: {
          type: "string",
          enum: ["http", "google-sheets"],
          description: "Data source type. Defaults to 'http'.",
        },
        table_path: {
          type: "string",
          description: "Optional custom directory within the backend (defaults to table name)",
        },
        http_path: {
          type: "string",
          description:
            "Path appended to the HTTP credential's base URL (source_type 'http' only). Defaults to '/'.",
        },
        http_method: {
          type: "string",
          enum: ["GET", "POST"],
          description: "HTTP method for source_type 'http'. Defaults to GET.",
        },
        format: {
          type: "string",
          enum: ["json", "ndjson", "csv", "parquet"],
          description: "Output file format. Defaults to ndjson.",
        },
        cron_schedule: {
          type: "string",
          description:
            "Standard 5-field cron expression, e.g. '0 * * * *' for hourly. Defaults to hourly.",
        },
        source_config: {
          type: "object",
          description:
            "Source-specific config. Required for source_type 'google-sheets': { spreadsheetId, sheetName?, range? }.",
        },
        date_range_config: {
          type: "object",
          description:
            "Optional date-range parameterization: { param_from, param_to, format: 'iso'|'iso_date'|'unix'|'unix_ms', lookback_days }",
        },
        pagination_config: {
          type: "object",
          description:
            "Optional cursor-based pagination: { type: 'cursor', cursor_param, cursor_path, data_path? }. Requires format json or ndjson.",
        },
      },
      required: ["name", "table_name", "credential", "storage_backend"],
    },
  },
  {
    name: "update_load_job",
    description:
      "Edit an existing load job. Only the fields provided are changed. Pass null for date_range_config or pagination_config to clear them.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Load job id (lj_...)" },
        name: { type: "string", description: "Human-readable job name" },
        table_name: {
          type: "string",
          description: "Catalog table name to commit results to. Must match [a-zA-Z_][a-zA-Z0-9_]*",
        },
        credential: { type: "string", description: "Name or id of the credential to use" },
        storage_backend: {
          type: "string",
          description: "Name or id of the storage backend to write output to",
        },
        source_type: { type: "string", enum: ["http", "google-sheets"] },
        table_path: { type: "string", description: "Custom directory within the backend" },
        http_path: {
          type: "string",
          description: "Path appended to the HTTP credential's base URL",
        },
        http_method: { type: "string", enum: ["GET", "POST"] },
        format: { type: "string", enum: ["json", "ndjson", "csv", "parquet"] },
        cron_schedule: { type: "string", description: "Standard 5-field cron expression" },
        source_config: {
          type: "object",
          description: "Source-specific config, e.g. { spreadsheetId, sheetName?, range? }",
        },
        date_range_config: {
          type: "object",
          description:
            "{ param_from, param_to, format: 'iso'|'iso_date'|'unix'|'unix_ms', lookback_days }, or null to clear",
        },
        pagination_config: {
          type: "object",
          description:
            "{ type: 'cursor', cursor_param, cursor_path, data_path? }, or null to clear",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_load_job",
    description: "Permanently delete a load job.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Load job id (lj_...)" } },
      required: ["id"],
    },
  },
  {
    name: "set_load_job_enabled",
    description:
      "Enable or disable a load job's cron schedule without deleting it. A disabled job is skipped by the scheduler but can still be run with trigger_load_job.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Load job id (lj_...)" },
        enabled: { type: "boolean", description: "true to enable, false to pause" },
      },
      required: ["id", "enabled"],
    },
  },
  {
    name: "trigger_load_job",
    description: "Run a load job immediately without waiting for its cron schedule.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Load job id (lj_...)" } },
      required: ["id"],
    },
  },
  {
    name: "list_transform_jobs",
    description:
      "List all transform job definitions with their SQL, output table, and status. Execution requires an active browser session.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_transform_job",
    description:
      "Define a derived table: a SQL query run against warehouse views in the browser DuckDB session, written to a storage backend, and committed to the catalog. Use create_trigger to run it automatically when its input tables change, or trigger_transform_job to run it once.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable job name" },
        sql: {
          type: "string",
          description: "DuckDB SQL to run against warehouse views, e.g. catalog table names",
        },
        output_table: {
          type: "string",
          description: "Catalog table name for the result. Must match [a-zA-Z_][a-zA-Z0-9_]*",
        },
        output_uri: {
          type: "string",
          description: "Destination URI, e.g. r2://backendName/path/output.parquet",
        },
        output_backend: {
          type: "string",
          description: "Name of the storage backend to write the output to",
        },
        format: {
          type: "string",
          description: "Output format, e.g. parquet. Inferred from output_uri if omitted.",
        },
      },
      required: ["sql", "output_table", "output_uri", "output_backend"],
    },
  },
  {
    name: "update_transform_job",
    description:
      "Edit an existing transform job. Only the fields provided are changed. Cannot edit a job that is currently running.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Transform job id (tj_...)" },
        name: { type: "string" },
        sql: { type: "string" },
        output_table: {
          type: "string",
          description: "Must match [a-zA-Z_][a-zA-Z0-9_]*",
        },
        output_uri: { type: "string" },
        output_backend: { type: "string" },
        format: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_transform_job",
    description:
      "Permanently delete a transform job and any triggers that reference it. Cannot delete a job that is currently running.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Transform job id (tj_...)" } },
      required: ["id"],
    },
  },
  {
    name: "trigger_transform_job",
    description:
      "Queue a transform job to run immediately. It executes the next time a browser session is connected.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Transform job id (tj_...)" } },
      required: ["id"],
    },
  },
  {
    name: "list_triggers",
    description: "List all triggers mapping watched catalog tables to transform jobs.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_trigger",
    description:
      "Watch one or more catalog tables and automatically queue a transform job to run when they commit new data. policy 'any' fires whenever any watched table commits; 'all' fires only once every watched table has a commit newer than the job's last completion.",
    inputSchema: {
      type: "object",
      properties: {
        watches: {
          type: "array",
          items: { type: "string" },
          description: "Catalog table name(s) to watch. A single string is also accepted.",
        },
        policy: {
          type: "string",
          enum: ["any", "all"],
          description: "Defaults to 'any'.",
        },
        job_id: {
          type: "string",
          description: "Transform job id (tj_...) to run when the trigger fires",
        },
      },
      required: ["watches", "job_id"],
    },
  },
  {
    name: "delete_trigger",
    description: "Remove a trigger.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Trigger id (trg_...)" } },
      required: ["id"],
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
      return handleReadData(respond, respondError, uri, userId, env, catalogStub);
    }

    if (toolName === "submit_dashboard") {
      return handleSubmitDashboard(respond, respondError, args, userId, env);
    }

    if (toolName === "list_dashboards") {
      return handleListDashboards(respond, userId, env);
    }

    if (toolName === "get_dashboard") {
      const idOrSlug = args.id_or_slug;
      if (typeof idOrSlug !== "string" || !idOrSlug.trim()) {
        return respondError(-32602, "id_or_slug is required");
      }
      return handleGetDashboard(respond, respondError, idOrSlug.trim(), userId, env);
    }

    if (toolName === "update_dashboard") {
      return handleUpdateDashboard(respond, respondError, args, userId, env);
    }

    if (toolName === "list_load_jobs") {
      return handleListLoadJobs(respond, userId, env);
    }

    if (toolName === "create_load_job") {
      return handleCreateLoadJob(respond, respondError, args, userId, env);
    }

    if (toolName === "update_load_job") {
      return handleUpdateLoadJob(respond, respondError, args, userId, env);
    }

    if (toolName === "delete_load_job") {
      const jobId = args.id;
      if (typeof jobId !== "string" || !jobId.trim()) return respondError(-32602, "id is required");
      const deleted = await deleteLoadJob(env.DB, userId, jobId.trim());
      if (!deleted) return respondError(-32602, `Load job not found: ${jobId}`);
      return respond({ content: [{ type: "text", text: `Load job ${jobId} deleted.` }] });
    }

    if (toolName === "set_load_job_enabled") {
      const jobId = args.id;
      if (typeof jobId !== "string" || !jobId.trim()) return respondError(-32602, "id is required");
      if (typeof args.enabled !== "boolean")
        return respondError(-32602, "enabled must be a boolean");
      const job = await setLoadJobEnabled(env.DB, userId, jobId.trim(), args.enabled);
      if (!job) return respondError(-32602, `Load job not found: ${jobId}`);
      return respond({
        content: [
          {
            type: "text",
            text: `Load job "${job.name}" ${args.enabled ? "enabled" : "disabled"}.`,
          },
        ],
      });
    }

    if (toolName === "trigger_load_job") {
      const jobId = args.id;
      if (typeof jobId !== "string" || !jobId.trim()) return respondError(-32602, "id is required");
      const job = await getLoadJob(env.DB, userId, jobId.trim());
      if (!job) return respondError(-32602, `Load job not found: ${jobId}`);
      await env.LOAD_JOB_QUEUE.send({ jobId: job.id });
      return respond({
        content: [{ type: "text", text: `Load job "${job.name}" queued to run now.` }],
      });
    }

    if (toolName === "list_transform_jobs") {
      return handleListTransformJobs(respond, respondError, catalogStub);
    }

    if (toolName === "create_transform_job") {
      return handleCreateTransformJob(respond, respondError, args, catalogStub);
    }

    if (toolName === "update_transform_job") {
      return handleUpdateTransformJob(respond, respondError, args, catalogStub);
    }

    if (toolName === "delete_transform_job") {
      const jobId = args.id;
      if (typeof jobId !== "string" || !jobId.trim()) return respondError(-32602, "id is required");
      const res = await catalogStub.fetch(`http://do/jobs/${encodeURIComponent(jobId.trim())}`, {
        method: "DELETE",
      });
      if (!res.ok) return respondError(-32602, await res.text());
      return respond({ content: [{ type: "text", text: `Transform job ${jobId} deleted.` }] });
    }

    if (toolName === "trigger_transform_job") {
      return handleTriggerTransformJob(
        respond,
        respondError,
        args,
        userId,
        catalogStub,
        sessionStub,
      );
    }

    if (toolName === "list_triggers") {
      return handleListTriggers(respond, respondError, catalogStub);
    }

    if (toolName === "create_trigger") {
      return handleCreateTrigger(respond, respondError, args, catalogStub);
    }

    if (toolName === "delete_trigger") {
      const triggerId = args.id;
      if (typeof triggerId !== "string" || !triggerId.trim())
        return respondError(-32602, "id is required");
      const res = await catalogStub.fetch(
        `http://do/triggers/${encodeURIComponent(triggerId.trim())}`,
        { method: "DELETE" },
      );
      if (!res.ok) return respondError(-32602, await res.text());
      return respond({ content: [{ type: "text", text: `Trigger ${triggerId} deleted.` }] });
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
    const effectiveFormat = inferSnapshotFormat(latest.format, latest.uri);
    const directAccess = isProxyReadableFormat(effectiveFormat) && isProxyReadableUri(latest.uri);
    lines.push(`  Latest snapshot: ${latest.uri}`);
    if (latest.format) lines.push(`  Format: ${latest.format}`);
    lines.push(`  Backend: ${latest.storage_backend}`);
    lines.push(
      `  Direct access (no browser session): ${directAccess ? `yes — use read_data with uri catalog://${table.name}` : "no — requires run_query with active browser session"}`,
    );
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
  catalogStub: ReturnType<DurableObjectNamespace["get"]>,
): Promise<Response> {
  if (uri.startsWith("http-ds://")) {
    return handleReadHttpDs(respond, respondError, uri, userId, env);
  }

  if (uri.startsWith("r2://") || uri.startsWith("r2-s3compat://")) {
    return readStorageUri(respond, respondError, uri, userId, env);
  }

  if (uri.startsWith("catalog://")) {
    const tableName = uri.slice("catalog://".length).trim();
    if (!tableName) return respondError(-32602, "catalog:// URI must include a table name");
    const snap = await resolveTableSnapshot(tableName, catalogStub);
    if (!snap) return respondError(-32602, `Table not found in catalog: ${tableName}`);
    if (!isProxyReadableUri(snap.uri)) {
      return respondError(-32602, `Storage scheme not supported for direct read: ${snap.uri}`);
    }
    return readStorageUri(respond, respondError, snap.uri, userId, env);
  }

  return respondError(-32602, "Unsupported URI scheme. Supported: http-ds://, r2://, catalog://");
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

async function readStorageUri(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  uri: string,
  userId: string,
  env: Env,
): Promise<Response> {
  const dataRes = await fetchStorageUri(uri, userId, env);
  if (!dataRes.ok) {
    if (dataRes.status === 404) return respondError(-32602, `Object not found: ${uri}`);
    return respondError(-32603, `Storage fetch failed (${dataRes.status})`);
  }
  return readAndReturnJson(respond, respondError, dataRes);
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

async function handleSubmitDashboard(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  args: Record<string, unknown>,
  userId: string,
  env: Env,
): Promise<Response> {
  const title = args.title;
  const artifactSource = args.artifact_source;
  const queries = args.queries;

  if (typeof title !== "string" || !title.trim()) {
    return respondError(-32602, "title is required");
  }
  if (typeof artifactSource !== "string" || !artifactSource.trim()) {
    return respondError(-32602, "artifact_source is required");
  }
  if (!Array.isArray(queries) || queries.some((q) => typeof q !== "string")) {
    return respondError(-32602, "queries must be an array of strings");
  }
  if (new TextEncoder().encode(artifactSource).length > 50_000) {
    return respondError(-32602, "artifact_source exceeds 50 KB limit");
  }

  // Resolve slug: use provided value or auto-generate from title.
  let slug: string | undefined;
  if (typeof args.slug === "string" && args.slug.trim()) {
    slug = await resolveUniqueSlug(env.DB, userId, slugify(args.slug));
  } else if (args.slug === undefined) {
    slug = await resolveUniqueSlug(env.DB, userId, slugify(title.trim()));
  }
  // args.slug === null or empty string → no slug

  const { id } = await insertDashboard(env.DB, {
    userId,
    title: title.trim(),
    artifactSource,
    queries: queries as string[],
    slug,
  });

  return respond({
    content: [
      {
        type: "text",
        text: `Dashboard "${title.trim()}" saved (id: ${id}${slug ? `, slug: ${slug}` : ""}). Open the Dashboards tab in the browser to view it.`,
      },
    ],
  });
}

async function handleListDashboards(
  respond: (r: unknown) => Response,
  userId: string,
  env: Env,
): Promise<Response> {
  const dashboards = await listDashboards(env.DB, userId);
  if (dashboards.length === 0) {
    return respond({ content: [{ type: "text", text: "No dashboards saved yet." }] });
  }
  const lines = dashboards.map((d) => {
    const date = new Date(d.created_at).toISOString().slice(0, 10);
    return `- **${d.title}** — id: \`${d.id}\`${d.slug ? `, slug: \`${d.slug}\`` : ""} (${date})`;
  });
  return respond({ content: [{ type: "text", text: lines.join("\n") }] });
}

async function handleGetDashboard(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  idOrSlug: string,
  userId: string,
  env: Env,
): Promise<Response> {
  const row = await getDashboardByIdOrSlug(env.DB, idOrSlug, userId);
  if (!row) return respondError(-32602, `Dashboard not found: ${idOrSlug}`);
  const queries = JSON.parse(row.queries) as string[];
  const lines: string[] = [`# ${row.title}`, `**id:** ${row.id}`];
  if (row.slug) lines.push(`**slug:** ${row.slug}`);
  lines.push(`**updated:** ${new Date(row.updated_at).toISOString()}`);
  if (queries.length > 0) {
    lines.push("", "## Queries");
    queries.forEach((q, i) => lines.push(`${i + 1}. \`${q}\``));
  }
  lines.push("", "## Artifact Source", "```jsx", row.artifact_source, "```");
  return respond({ content: [{ type: "text", text: lines.join("\n") }] });
}

async function handleUpdateDashboard(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  args: Record<string, unknown>,
  userId: string,
  env: Env,
): Promise<Response> {
  const idOrSlug = args.id_or_slug;
  if (typeof idOrSlug !== "string" || !idOrSlug.trim()) {
    return respondError(-32602, "id_or_slug is required");
  }

  const row = await getDashboardByIdOrSlug(env.DB, idOrSlug.trim(), userId);
  if (!row) return respondError(-32602, `Dashboard not found: ${idOrSlug}`);

  const updates: {
    title?: string;
    artifactSource?: string;
    queries?: string[];
    slug?: string | null;
  } = {};

  if (args.title !== undefined) {
    if (typeof args.title !== "string" || !args.title.trim()) {
      return respondError(-32602, "title must be a non-empty string");
    }
    updates.title = args.title.trim();
  }

  if (args.artifact_source !== undefined) {
    if (typeof args.artifact_source !== "string" || !args.artifact_source.trim()) {
      return respondError(-32602, "artifact_source must be a non-empty string");
    }
    if (new TextEncoder().encode(args.artifact_source).length > 50_000) {
      return respondError(-32602, "artifact_source exceeds 50 KB limit");
    }
    updates.artifactSource = args.artifact_source;
  }

  if (args.queries !== undefined) {
    if (
      !Array.isArray(args.queries) ||
      (args.queries as unknown[]).some((q) => typeof q !== "string")
    ) {
      return respondError(-32602, "queries must be an array of strings");
    }
    updates.queries = args.queries as string[];
  }

  if (args.slug !== undefined) {
    if (typeof args.slug === "string" && args.slug.trim()) {
      updates.slug = await resolveUniqueSlug(env.DB, userId, slugify(args.slug), row.id);
    } else if (args.slug === "" || args.slug === null) {
      updates.slug = null;
    } else {
      return respondError(-32602, "slug must be a string or empty string to clear");
    }
  }

  if (Object.keys(updates).length === 0) {
    return respondError(
      -32602,
      "at least one field (title, artifact_source, queries, slug) is required",
    );
  }

  await snapshotDashboard(env.DB, row, userId, "update");
  await updateDashboard(env.DB, row.id, userId, updates);

  const newTitle = updates.title ?? row.title;
  const newSlug = updates.slug !== undefined ? updates.slug : row.slug;
  const ref = newSlug ?? row.id;
  return respond({
    content: [
      {
        type: "text",
        text: `Dashboard "${newTitle}" updated (id: ${row.id}${newSlug ? `, slug: ${newSlug}` : ""}). View at /dashboards/${ref}.`,
      },
    ],
  });
}

// ── Load job tools ────────────────────────────────────────────────────────

async function handleListLoadJobs(
  respond: (r: unknown) => Response,
  userId: string,
  env: Env,
): Promise<Response> {
  const jobs = await listLoadJobs(env.DB, userId);
  if (jobs.length === 0) {
    return respond({ content: [{ type: "text", text: "No load jobs configured." }] });
  }
  const lines = jobs.map((j) => {
    const status = j.enabled ? "enabled" : "disabled";
    const last = j.last_run_at ? new Date(j.last_run_at).toISOString() : "never";
    const next = j.next_run_at ? new Date(j.next_run_at).toISOString() : "n/a";
    const err = j.last_error ? ` — last error: ${j.last_error}` : "";
    return `- **${j.name}** (${j.id}) → \`${j.table_name}\` [${j.source_type}, ${status}]\n  cron: ${j.cron_schedule}, last run: ${last}, next run: ${next}${err}`;
  });
  return respond({ content: [{ type: "text", text: lines.join("\n") }] });
}

async function handleCreateLoadJob(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  args: Record<string, unknown>,
  userId: string,
  env: Env,
): Promise<Response> {
  const name = args.name;
  if (typeof name !== "string" || !name.trim()) return respondError(-32602, "name is required");

  const tableName = args.table_name;
  if (typeof tableName !== "string" || !SAFE_TABLE_NAME.test(tableName)) {
    return respondError(-32602, "table_name must match [a-zA-Z_][a-zA-Z0-9_]*");
  }

  const credentialArg = args.credential;
  if (typeof credentialArg !== "string" || !credentialArg.trim()) {
    return respondError(-32602, "credential is required");
  }
  const cred = await getCredentialByNameOrId(env.DB, credentialArg.trim(), userId);
  if (!cred) return respondError(-32602, `Credential not found: ${credentialArg}`);

  const backendArg = args.storage_backend;
  if (typeof backendArg !== "string" || !backendArg.trim()) {
    return respondError(-32602, "storage_backend is required");
  }
  const backend = await getStorageBackendByNameOrId(env.DB, backendArg.trim(), userId);
  if (!backend) return respondError(-32602, `Storage backend not found: ${backendArg}`);

  if (
    args.http_method !== undefined &&
    !VALID_HTTP_METHODS.includes(args.http_method as (typeof VALID_HTTP_METHODS)[number])
  ) {
    return respondError(-32602, "http_method must be GET or POST");
  }
  if (
    args.format !== undefined &&
    !VALID_FORMATS.includes(args.format as (typeof VALID_FORMATS)[number])
  ) {
    return respondError(-32602, "format must be json, ndjson, csv, or parquet");
  }

  let dateRangeConfig: string | null = null;
  if (args.date_range_config !== undefined && args.date_range_config !== null) {
    const parsed = validateDateRangeConfig(args.date_range_config);
    if (!parsed) return respondError(-32602, "invalid date_range_config");
    dateRangeConfig = JSON.stringify(parsed);
  }
  let paginationConfig: string | null = null;
  if (args.pagination_config !== undefined && args.pagination_config !== null) {
    const parsed = validatePaginationConfig(args.pagination_config);
    if (!parsed) return respondError(-32602, "invalid pagination_config");
    const fmt = typeof args.format === "string" ? args.format : "ndjson";
    if (!["json", "ndjson"].includes(fmt)) {
      return respondError(-32602, "pagination_config requires output format json or ndjson");
    }
    paginationConfig = JSON.stringify(parsed);
  }

  let job: Awaited<ReturnType<typeof insertLoadJob>>;
  try {
    job = await insertLoadJob(env.DB, userId, {
      name: name.trim(),
      credential_id: cred.id,
      storage_backend_id: backend.id,
      table_name: tableName,
      table_path: typeof args.table_path === "string" ? args.table_path : undefined,
      http_path: typeof args.http_path === "string" ? args.http_path : undefined,
      http_method: typeof args.http_method === "string" ? args.http_method : undefined,
      format: typeof args.format === "string" ? args.format : undefined,
      cron_schedule: typeof args.cron_schedule === "string" ? args.cron_schedule : undefined,
      date_range_config: dateRangeConfig,
      pagination_config: paginationConfig,
      source_type: typeof args.source_type === "string" ? args.source_type : undefined,
      source_config:
        args.source_config !== undefined && args.source_config !== null
          ? JSON.stringify(args.source_config)
          : undefined,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid cron_schedule")) {
      return respondError(-32602, err.message);
    }
    throw err;
  }

  return respond({
    content: [
      {
        type: "text",
        text: `Load job "${job.name}" created (id: ${job.id}) → table \`${job.table_name}\`, cron: ${job.cron_schedule}.`,
      },
    ],
  });
}

async function handleUpdateLoadJob(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  args: Record<string, unknown>,
  userId: string,
  env: Env,
): Promise<Response> {
  const jobId = args.id;
  if (typeof jobId !== "string" || !jobId.trim()) return respondError(-32602, "id is required");

  const existing = await getLoadJob(env.DB, userId, jobId.trim());
  if (!existing) return respondError(-32602, `Load job not found: ${jobId}`);

  const patch: Parameters<typeof updateLoadJob>[3] = {
    name: existing.name,
    credential_id: existing.credential_id,
    storage_backend_id: existing.storage_backend_id,
    table_name: existing.table_name,
    table_path: existing.table_path,
    http_path: existing.http_path,
    http_method: existing.http_method,
    format: existing.format,
    cron_schedule: existing.cron_schedule,
    date_range_config: existing.date_range_config,
    pagination_config: existing.pagination_config,
    source_type: existing.source_type,
    source_config: existing.source_config,
  };
  let changed = false;

  if ("name" in args) {
    if (typeof args.name !== "string" || !args.name.trim()) {
      return respondError(-32602, "name must be a non-empty string");
    }
    patch.name = args.name.trim();
    changed = true;
  }
  if ("table_name" in args) {
    if (typeof args.table_name !== "string" || !SAFE_TABLE_NAME.test(args.table_name)) {
      return respondError(-32602, "table_name must match [a-zA-Z_][a-zA-Z0-9_]*");
    }
    patch.table_name = args.table_name;
    changed = true;
  }
  if ("credential" in args) {
    if (typeof args.credential !== "string" || !args.credential.trim()) {
      return respondError(-32602, "credential must be a non-empty string");
    }
    const cred = await getCredentialByNameOrId(env.DB, args.credential.trim(), userId);
    if (!cred) return respondError(-32602, `Credential not found: ${args.credential}`);
    patch.credential_id = cred.id;
    changed = true;
  }
  if ("storage_backend" in args) {
    if (typeof args.storage_backend !== "string" || !args.storage_backend.trim()) {
      return respondError(-32602, "storage_backend must be a non-empty string");
    }
    const backend = await getStorageBackendByNameOrId(env.DB, args.storage_backend.trim(), userId);
    if (!backend) return respondError(-32602, `Storage backend not found: ${args.storage_backend}`);
    patch.storage_backend_id = backend.id;
    changed = true;
  }
  if ("source_type" in args) {
    if (typeof args.source_type !== "string" || !args.source_type.trim()) {
      return respondError(-32602, "source_type must be a non-empty string");
    }
    patch.source_type = args.source_type;
    changed = true;
  }
  if ("table_path" in args) {
    if (typeof args.table_path !== "string")
      return respondError(-32602, "table_path must be a string");
    patch.table_path = args.table_path;
    changed = true;
  }
  if ("http_path" in args) {
    if (typeof args.http_path !== "string")
      return respondError(-32602, "http_path must be a string");
    patch.http_path = args.http_path;
    changed = true;
  }
  if ("http_method" in args) {
    if (!VALID_HTTP_METHODS.includes(args.http_method as (typeof VALID_HTTP_METHODS)[number])) {
      return respondError(-32602, "http_method must be GET or POST");
    }
    patch.http_method = args.http_method as string;
    changed = true;
  }
  if ("format" in args) {
    if (!VALID_FORMATS.includes(args.format as (typeof VALID_FORMATS)[number])) {
      return respondError(-32602, "format must be json, ndjson, csv, or parquet");
    }
    patch.format = args.format as string;
    changed = true;
  }
  if ("cron_schedule" in args) {
    if (typeof args.cron_schedule !== "string" || !args.cron_schedule.trim()) {
      return respondError(-32602, "cron_schedule must be a non-empty string");
    }
    patch.cron_schedule = args.cron_schedule;
    changed = true;
  }
  if ("source_config" in args) {
    patch.source_config = args.source_config === null ? null : JSON.stringify(args.source_config);
    changed = true;
  }
  if ("date_range_config" in args) {
    if (args.date_range_config === null) {
      patch.date_range_config = null;
    } else {
      const parsed = validateDateRangeConfig(args.date_range_config);
      if (!parsed) return respondError(-32602, "invalid date_range_config");
      patch.date_range_config = JSON.stringify(parsed);
    }
    changed = true;
  }
  if ("pagination_config" in args) {
    if (args.pagination_config === null) {
      patch.pagination_config = null;
    } else {
      const parsed = validatePaginationConfig(args.pagination_config);
      if (!parsed) return respondError(-32602, "invalid pagination_config");
      const fmt = patch.format ?? "ndjson";
      if (!["json", "ndjson"].includes(fmt)) {
        return respondError(-32602, "pagination_config requires output format json or ndjson");
      }
      patch.pagination_config = JSON.stringify(parsed);
    }
    changed = true;
  }

  if (!changed) {
    return respondError(-32602, "at least one field must be provided to update");
  }

  let updated: Awaited<ReturnType<typeof updateLoadJob>>;
  try {
    updated = await updateLoadJob(env.DB, userId, jobId.trim(), patch);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid cron_schedule")) {
      return respondError(-32602, err.message);
    }
    throw err;
  }
  if (!updated) return respondError(-32602, `Load job not found: ${jobId}`);

  return respond({
    content: [{ type: "text", text: `Load job "${updated.name}" updated (id: ${updated.id}).` }],
  });
}

// ── Transform job tools ──────────────────────────────────────────────────

interface TransformJobRow {
  id: string;
  name: string | null;
  sql: string;
  output_table: string;
  output_uri: string;
  output_backend: string;
  format: string | null;
  status: string;
  last_completed_at: number | null;
  error: string | null;
}

async function handleListTransformJobs(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  catalogStub: ReturnType<DurableObjectNamespace["get"]>,
): Promise<Response> {
  const res = await catalogStub.fetch("http://do/jobs");
  if (!res.ok) return respondError(-32603, "Failed to list transform jobs");
  const { jobs } = (await res.json()) as { jobs: TransformJobRow[] };
  if (jobs.length === 0) {
    return respond({ content: [{ type: "text", text: "No transform jobs configured." }] });
  }
  const lines = jobs.map((j) => {
    const last = j.last_completed_at ? new Date(j.last_completed_at).toISOString() : "never";
    const err = j.error ? ` — error: ${j.error}` : "";
    return `- **${j.name ?? j.output_table}** (${j.id}) → \`${j.output_table}\` [${j.status}]\n  output: ${j.output_uri} (backend: ${j.output_backend}${j.format ? `, format: ${j.format}` : ""}), last completed: ${last}${err}\n  sql: \`${j.sql}\``;
  });
  return respond({ content: [{ type: "text", text: lines.join("\n") }] });
}

async function handleCreateTransformJob(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  args: Record<string, unknown>,
  catalogStub: ReturnType<DurableObjectNamespace["get"]>,
): Promise<Response> {
  const res = await catalogStub.fetch("http://do/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: args.name,
      sql: args.sql,
      output_table: args.output_table,
      output_uri: args.output_uri,
      output_backend: args.output_backend,
      format: args.format,
    }),
  });
  if (!res.ok) return respondError(-32602, await res.text());
  const job = (await res.json()) as TransformJobRow;
  return respond({
    content: [
      {
        type: "text",
        text: `Transform job created (id: ${job.id}) → table \`${job.output_table}\`. Use create_trigger to run it automatically on catalog commits, or trigger_transform_job to run it once.`,
      },
    ],
  });
}

async function handleUpdateTransformJob(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  args: Record<string, unknown>,
  catalogStub: ReturnType<DurableObjectNamespace["get"]>,
): Promise<Response> {
  const jobId = args.id;
  if (typeof jobId !== "string" || !jobId.trim()) return respondError(-32602, "id is required");

  const patch: Record<string, unknown> = {};
  for (const key of ["name", "sql", "output_table", "output_uri", "output_backend", "format"]) {
    if (key in args) patch[key] = args[key];
  }

  const res = await catalogStub.fetch(`http://do/jobs/${encodeURIComponent(jobId.trim())}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return respondError(-32602, await res.text());
  const job = (await res.json()) as TransformJobRow;
  return respond({
    content: [
      {
        type: "text",
        text: `Transform job ${job.id} updated (output table: \`${job.output_table}\`).`,
      },
    ],
  });
}

async function handleTriggerTransformJob(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  args: Record<string, unknown>,
  userId: string,
  catalogStub: ReturnType<DurableObjectNamespace["get"]>,
  sessionStub: ReturnType<DurableObjectNamespace["get"]>,
): Promise<Response> {
  const jobId = args.id;
  if (typeof jobId !== "string" || !jobId.trim()) return respondError(-32602, "id is required");

  const res = await catalogStub.fetch(
    `http://do/jobs/${encodeURIComponent(jobId.trim())}/trigger`,
    {
      method: "POST",
    },
  );
  if (!res.ok) return respondError(-32602, await res.text());

  try {
    await sessionStub.fetch("http://do/dispatch-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
  } catch {
    // Best-effort: the job stays pending and will be dispatched on next browser connect.
  }

  return respond({
    content: [
      {
        type: "text",
        text: `Transform job ${jobId} queued. It will run on the next connected browser session.`,
      },
    ],
  });
}

// ── Trigger tools ────────────────────────────────────────────────────────

interface TriggerRow {
  id: string;
  watches: string[];
  policy: string;
  job_id: string;
  created_at: number;
}

async function handleListTriggers(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  catalogStub: ReturnType<DurableObjectNamespace["get"]>,
): Promise<Response> {
  const res = await catalogStub.fetch("http://do/triggers");
  if (!res.ok) return respondError(-32603, "Failed to list triggers");
  const { triggers } = (await res.json()) as { triggers: TriggerRow[] };
  if (triggers.length === 0) {
    return respond({ content: [{ type: "text", text: "No triggers configured." }] });
  }
  const lines = triggers.map(
    (t) => `- ${t.id}: watches [${t.watches.join(", ")}] (policy: ${t.policy}) → job ${t.job_id}`,
  );
  return respond({ content: [{ type: "text", text: lines.join("\n") }] });
}

async function handleCreateTrigger(
  respond: (r: unknown) => Response,
  respondError: (code: number, msg: string) => Response,
  args: Record<string, unknown>,
  catalogStub: ReturnType<DurableObjectNamespace["get"]>,
): Promise<Response> {
  const res = await catalogStub.fetch("http://do/triggers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      watches: args.watches,
      policy: args.policy,
      job_id: args.job_id,
    }),
  });
  if (!res.ok) return respondError(-32602, await res.text());
  const trigger = (await res.json()) as TriggerRow;
  return respond({
    content: [
      {
        type: "text",
        text: `Trigger created (id: ${trigger.id}): watches [${trigger.watches.join(", ")}] (policy: ${trigger.policy}).`,
      },
    ],
  });
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
