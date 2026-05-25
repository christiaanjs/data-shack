import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
});

describe("GET /session/status", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/session/status");
    expect(res.status).toBe(401);
  });

  it("returns sessionCount 0 when no WebSocket is connected", async () => {
    const res = await SELF.fetch("http://localhost/session/status", { headers: DEV_HEADERS });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sessionCount: number };
    expect(data.sessionCount).toBe(0);
  });
});

describe("GET /session/ws", () => {
  it("returns 426 when not a WebSocket upgrade", async () => {
    const res = await SELF.fetch("http://localhost/session/ws", { headers: DEV_HEADERS });
    expect(res.status).toBe(426);
  });

  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/session/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /mcp - MCP server", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("initialize returns server capabilities", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test" } },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: {
        protocolVersion: string;
        capabilities: Record<string, unknown>;
        serverInfo: { name: string };
      };
    };
    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe(1);
    expect(data.result.protocolVersion).toBe("2025-03-26");
    expect(data.result.serverInfo.name).toBe("data-shack");
    expect(data.result.capabilities).toHaveProperty("tools");
  });

  it("notifications (no id) return 202", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
  });

  it("tools/list returns four tools", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(data.result.tools).toHaveLength(4);
    const names = data.result.tools.map((t) => t.name);
    expect(names).toContain("get_warehouse_schema");
    expect(names).toContain("run_query");
    expect(names).toContain("read_data");
    expect(names).toContain("list_data_sources");
  });

  it("get_warehouse_schema returns empty schema when no tables exist", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_warehouse_schema", arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(data.result.content[0]?.type).toBe("text");
    expect(data.result.content[0]?.text).toContain("No tables");
  });

  it("get_warehouse_schema lists committed tables", async () => {
    // Commit a table first.
    await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "mcp_test_table",
        uri: "r2://data-shack/mcp/file.parquet",
        storageBackend: "primary-r2",
        format: "parquet",
      }),
    });

    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_warehouse_schema", arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: { content: Array<{ text: string }> } };
    const text = data.result.content[0]?.text ?? "";
    expect(text).toContain("mcp_test_table");
    expect(text).toContain("r2://data-shack/mcp/file.parquet");
  });

  it("run_query returns no_session error when no browser connected", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "run_query", arguments: { sql: "SELECT 1" } },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result?: unknown; error?: { message: string } };
    // Should return an error result (no active session)
    const text = JSON.stringify(data);
    expect(text).toContain("session");
  });

  it("unknown tool returns method error", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "nonexistent_tool", arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { error?: { code: number } };
    expect(data.error?.code).toBe(-32601);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function mcpCall(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{
  result?: { content: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}> {
  const res = await SELF.fetch("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  return res.json();
}

// ── list_data_sources ─────────────────────────────────────────────────────────

describe("list_data_sources tool", () => {
  it("returns empty message when no HTTP credentials configured", async () => {
    const data = await mcpCall("list_data_sources", {});
    expect(data.result?.content[0]?.text).toContain("No HTTP data sources");
  });

  it("lists HTTP credentials with name and baseUrl after creating one", async () => {
    await SELF.fetch("http://localhost/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "my-sales-api",
        type: "http",
        config: { baseUrl: "https://api.example.com/v1" },
      }),
    });

    const data = await mcpCall("list_data_sources", {});
    const text = data.result?.content[0]?.text ?? "";
    expect(text).toContain("my-sales-api");
    expect(text).toContain("https://api.example.com/v1");
  });

  it("includes credential id so it can be used in http-ds:// URIs", async () => {
    const createRes = await SELF.fetch("http://localhost/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "another-source",
        type: "http",
        config: { baseUrl: "https://other.example.com" },
      }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const data = await mcpCall("list_data_sources", {});
    const text = data.result?.content[0]?.text ?? "";
    expect(text).toContain(id);
    expect(text).toContain("another-source");
  });
});

// ── read_data tool ────────────────────────────────────────────────────────────

describe("read_data tool", () => {
  it("returns error for unsupported URI scheme", async () => {
    const data = await mcpCall("read_data", { uri: "ftp://example.com/file.json" });
    expect(data.result?.content[0]?.text ?? data.error?.message).toMatch(/[Uu]nsupported/);
  });

  it("returns missing uri error when uri not provided", async () => {
    const data = await mcpCall("read_data", {});
    expect(data.error?.code).toBe(-32602);
  });

  it("returns error when http-ds credential not found", async () => {
    const data = await mcpCall("read_data", { uri: "http-ds://cred_doesnotexist/path" });
    const text = JSON.stringify(data);
    expect(text).toMatch(/not found|credential/i);
  });

  it("returns error for http-ds credential referenced by unknown name", async () => {
    const data = await mcpCall("read_data", { uri: "http-ds://no-such-name/path" });
    const text = JSON.stringify(data);
    expect(text).toMatch(/not found|credential/i);
  });

  it("reads JSON object from r2://data-shack/ URI", async () => {
    await env.R2.put(
      "users/usr_test/mcp-read/config.json",
      JSON.stringify({ version: 2, active: true }),
      {
        httpMetadata: { contentType: "application/json" },
      },
    );

    const data = await mcpCall("read_data", { uri: "r2://data-shack/mcp-read/config.json" });
    const text = data.result?.content[0]?.text ?? "";
    expect(text).toContain('"version"');
    expect(text).toContain("2");
    expect(text).toContain('"active"');
  });

  it("reads JSON array from r2://data-shack/ URI", async () => {
    await env.R2.put(
      "users/usr_test/mcp-read/list.json",
      JSON.stringify([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ]),
      { httpMetadata: { contentType: "application/json" } },
    );

    const data = await mcpCall("read_data", { uri: "r2://data-shack/mcp-read/list.json" });
    const text = data.result?.content[0]?.text ?? "";
    expect(text).toContain('"name"');
    expect(text).toContain("Alice");
    expect(text).toContain("Bob");
  });

  it("reads NDJSON from r2://data-shack/ URI", async () => {
    const ndjson = ['{"id":1,"event":"click"}', '{"id":2,"event":"view"}'].join("\n");
    await env.R2.put("users/usr_test/mcp-read/events.ndjson", ndjson, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });

    const data = await mcpCall("read_data", { uri: "r2://data-shack/mcp-read/events.ndjson" });
    const text = data.result?.content[0]?.text ?? "";
    expect(text).toContain('"event"');
    expect(text).toContain("click");
    expect(text).toContain("view");
  });

  it("returns error when R2 object does not exist", async () => {
    const data = await mcpCall("read_data", { uri: "r2://data-shack/mcp-read/nonexistent.json" });
    const text = JSON.stringify(data);
    expect(text).toMatch(/[Nn]ot found/);
  });

  it("returns error when R2 object exceeds 1 MB", async () => {
    const large = "x".repeat(1_100_000);
    await env.R2.put("users/usr_test/mcp-read/large.json", `"${large}"`);

    const data = await mcpCall("read_data", { uri: "r2://data-shack/mcp-read/large.json" });
    const text = JSON.stringify(data);
    expect(text).toMatch(/[Tt]oo large/);
  });

  it("can reference http-ds credential by name", async () => {
    // Credential with name "named-api" won't reach the upstream (loopback), but the
    // resolution by name should succeed and produce an upstream error, not a
    // "credential not found" error.
    await SELF.fetch("http://localhost/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "named-api",
        type: "http",
        config: { baseUrl: "http://localhost:1" },
      }),
    });

    const data = await mcpCall("read_data", { uri: "http-ds://named-api/test" });
    const text = JSON.stringify(data);
    // Should NOT say "credential not found" — name resolved, but upstream failed
    expect(text).not.toMatch(/credential not found/i);
    expect(text).toMatch(/[Ff]ail|[Ee]rror|connect/i);
  });

  it("reads JSON from r2-s3compat backend using SigV4-signed request", async () => {
    const createRes = await SELF.fetch("http://localhost/api/storage-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "my-s3-backend",
        type: "r2-s3compat",
        config: {
          endpoint: "https://test-account.r2.cloudflarestorage.com",
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
          bucket: "my-bucket",
          region: "auto",
        },
      }),
    });
    expect(createRes.status).toBe(201);

    const payload = JSON.stringify({ records: [{ id: 1, name: "test" }] });
    let capturedRequest: Request | null = null;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes("r2.cloudflarestorage.com")) {
        capturedRequest = new Request(url, init);
        return new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return savedFetch(input, init);
    };

    try {
      const data = await mcpCall("read_data", { uri: "r2://my-s3-backend/path/to/data.json" });
      const text = data.result?.content[0]?.text ?? "";
      expect(text).toContain('"records"');
      expect(text).toContain('"name"');
      expect(text).toContain("test");

      // Verify the request was SigV4-signed
      expect(capturedRequest).not.toBeNull();
      const authHeader = (capturedRequest as unknown as Request).headers.get("Authorization") ?? "";
      expect(authHeader).toContain("AWS4-HMAC-SHA256");
      expect(authHeader).toContain("test-access-key");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("returns error from r2-s3compat when backend returns non-200", async () => {
    await SELF.fetch("http://localhost/api/storage-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "my-s3-backend-404",
        type: "r2-s3compat",
        config: {
          endpoint: "https://test-account.r2.cloudflarestorage.com",
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
          bucket: "my-bucket",
          region: "auto",
        },
      }),
    });

    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes("r2.cloudflarestorage.com")) {
        return new Response("NoSuchKey", { status: 404 });
      }
      return savedFetch(input, init);
    };

    try {
      const data = await mcpCall("read_data", { uri: "r2://my-s3-backend-404/missing.json" });
      const text = JSON.stringify(data);
      expect(text).toMatch(/404|[Bb]ackend returned/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── Shared WebSocket helpers ──────────────────────────────────────────────────

async function connectMockBrowser(): Promise<WebSocket> {
  const wsRes = await SELF.fetch("http://localhost/session/ws", {
    headers: { Upgrade: "websocket", ...DEV_HEADERS },
  });
  expect(wsRes.status).toBe(101);
  const ws = wsRes.webSocket!;
  ws.accept();
  return ws;
}

function waitForWsMessage<T>(ws: WebSocket, type: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for "${type}" WS message`)),
      timeoutMs,
    );
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as { type: string };
      if (msg.type === type) {
        clearTimeout(timer);
        resolve(msg as unknown as T);
      }
    });
  });
}

function waitForTransformJob(
  ws: WebSocket,
  jobId: string,
  timeoutMs = 3000,
): Promise<{ type: "transform_job"; jobId: string; outputTable: string; outputBackend: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for transform_job ${jobId}`)),
      timeoutMs,
    );
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as { type: string; jobId?: string };
      if (msg.type === "transform_job" && msg.jobId === jobId) {
        clearTimeout(timer);
        resolve(
          msg as {
            type: "transform_job";
            jobId: string;
            outputTable: string;
            outputBackend: string;
          },
        );
      }
    });
  });
}

// ── run_query with mock browser session ───────────────────────────────────────

describe("run_query with mock browser session", () => {
  function mockQueryResponder(ws: WebSocket, columns: string[], rows: unknown[][]): Promise<void> {
    return new Promise((resolve) => {
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data as string) as { type: string; queryId: string };
        if (msg.type === "query") {
          ws.send(JSON.stringify({ type: "result", queryId: msg.queryId, columns, rows }));
          resolve();
        }
      });
    });
  }

  it("returns table-formatted results (default format)", async () => {
    const ws = await connectMockBrowser();
    const responded = mockQueryResponder(
      ws,
      ["name", "score"],
      [
        ["Alice", 95],
        ["Bob", 87],
      ],
    );

    const mcpPromise = mcpCall("run_query", { sql: "SELECT * FROM scores" });
    await Promise.all([mcpPromise, responded]).then(([data]) => {
      const text = (data as Awaited<ReturnType<typeof mcpCall>>).result?.content[0]?.text ?? "";
      expect(text).toContain("name\tscore");
      expect(text).toContain("Alice\t95");
      expect(text).toContain("Bob\t87");
    });

    ws.close();
  });

  it("returns JSON-formatted results when format=json", async () => {
    const ws = await connectMockBrowser();
    const responded = mockQueryResponder(ws, ["id", "value"], [[1, "hello"]]);

    const mcpPromise = mcpCall("run_query", { sql: "SELECT 1", format: "json" });
    await Promise.all([mcpPromise, responded]).then(([data]) => {
      const text = (data as Awaited<ReturnType<typeof mcpCall>>).result?.content[0]?.text ?? "";
      const parsed = JSON.parse(text) as Array<Record<string, unknown>>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({ id: 1, value: "hello" });
    });

    ws.close();
  });

  it("returns CSV-formatted results when format=csv", async () => {
    const ws = await connectMockBrowser();
    const responded = mockQueryResponder(
      ws,
      ["city", "pop"],
      [
        ["London", 9_000_000],
        ["Paris", 2_100_000],
      ],
    );

    const mcpPromise = mcpCall("run_query", { sql: "SELECT * FROM cities", format: "csv" });
    await Promise.all([mcpPromise, responded]).then(([data]) => {
      const text = (data as Awaited<ReturnType<typeof mcpCall>>).result?.content[0]?.text ?? "";
      expect(text).toContain("city,pop");
      expect(text).toContain("London,9000000");
      expect(text).toContain("Paris,2100000");
    });

    ws.close();
  });

  it("returns error content when browser reports a query error", async () => {
    const ws = await connectMockBrowser();

    const errorResponded = new Promise<void>((resolve) => {
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data as string) as { type: string; queryId: string };
        if (msg.type === "query") {
          ws.send(
            JSON.stringify({ type: "error", queryId: msg.queryId, error: "Table 'bad' not found" }),
          );
          resolve();
        }
      });
    });

    const mcpPromise = mcpCall("run_query", { sql: "SELECT * FROM bad" });
    await Promise.all([mcpPromise, errorResponded]).then(([data]) => {
      const text = JSON.stringify(data as Awaited<ReturnType<typeof mcpCall>>);
      expect(text).toMatch(/[Ee]rror|bad|fail/i);
    });

    ws.close();
  });

  it("truncates result rows to 1000 and notes truncation in table format", async () => {
    const ws = await connectMockBrowser();
    // Produce 1001 rows
    const rows: unknown[][] = Array.from({ length: 1001 }, (_, i) => [i]);
    const responded = mockQueryResponder(ws, ["n"], rows);

    const mcpPromise = mcpCall("run_query", { sql: "SELECT n FROM big" });
    await Promise.all([mcpPromise, responded]).then(([data]) => {
      const text = (data as Awaited<ReturnType<typeof mcpCall>>).result?.content[0]?.text ?? "";
      expect(text).toContain("truncated");
      // Row 1000 (0-indexed) should be absent; row 999 should be present
      expect(text).toContain("999");
      expect(text).not.toContain("1000\n");
    });

    ws.close();
  });

  it("sessionCount reflects connected browser", async () => {
    const ws = await connectMockBrowser();

    const statusRes = await SELF.fetch("http://localhost/session/status", {
      headers: DEV_HEADERS,
    });
    const { sessionCount } = (await statusRes.json()) as { sessionCount: number };
    expect(sessionCount).toBeGreaterThanOrEqual(1);

    ws.close();
  });
});

// ── Transform job dispatch ────────────────────────────────────────────────────

describe("transform job dispatch via WebSocket", () => {
  interface TransformJobMsg {
    type: "transform_job";
    jobId: string;
    sql: string;
    outputTable: string;
    outputUri: string;
    outputBackend: string;
    format?: string | null;
  }

  function waitForJobStatus(
    ws: WebSocket,
    jobId: string,
    status: string,
    timeoutMs = 3000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout waiting for job_status '${status}' for job ${jobId}`)),
        timeoutMs,
      );
      ws.addEventListener("message", function handler(event) {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          jobId?: string;
          status?: string;
        };
        if (msg.type === "job_status" && msg.jobId === jobId && msg.status === status) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve();
        }
      });
    });
  }

  async function pollJobStatus(
    jobId: string,
    expectedStatus: string,
    timeoutMs = 3000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await SELF.fetch("http://localhost/api/transform-jobs", { headers: DEV_HEADERS });
      const { jobs } = (await res.json()) as { jobs: Array<{ id: string; status: string }> };
      if (jobs.find((j) => j.id === jobId)?.status === expectedStatus) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Job ${jobId} did not reach status '${expectedStatus}' within ${timeoutMs}ms`);
  }

  async function createTransformJob(name: string): Promise<string> {
    const res = await SELF.fetch("http://localhost/api/transform-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name,
        sql: `COPY (SELECT 1 AS n) TO 'r2://data-shack/${name}.parquet'`,
        output_table: name,
        output_uri: `r2://data-shack/${name}.parquet`,
        output_backend: "data-shack",
        format: "parquet",
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    return id;
  }

  it("dispatches job to already-connected browser when Run button triggers it", async () => {
    // Browser connects first — no pending jobs at this point.
    const ws = await connectMockBrowser();

    const jobId = await createTransformJob("dispatch_on_trigger");
    const received = waitForTransformJob(ws, jobId);

    // Simulate clicking Run: sets job pending AND dispatches to connected browser.
    const triggerRes = await SELF.fetch(`http://localhost/api/transform-jobs/${jobId}/trigger`, {
      method: "POST",
      headers: DEV_HEADERS,
    });
    expect(triggerRes.status).toBe(204);

    // Should arrive without a page refresh.
    const msg = await received;
    expect(msg.outputTable).toBe("dispatch_on_trigger");

    ws.close();
  });

  it("dispatches pending jobs to browser immediately on connect", async () => {
    const jobId = await createTransformJob("dispatch_on_connect");

    // Set job to pending before browser connects.
    const triggerRes = await SELF.fetch(`http://localhost/api/transform-jobs/${jobId}/trigger`, {
      method: "POST",
      headers: DEV_HEADERS,
    });
    expect(triggerRes.status).toBe(204);

    // Connect browser — Session DO calls dispatchPendingJobs in waitUntil.
    const ws = await connectMockBrowser();
    const msg = await waitForTransformJob(ws, jobId);

    expect(msg.outputTable).toBe("dispatch_on_connect");
    expect(msg.outputBackend).toBe("data-shack");

    ws.close();
  });

  it("dispatches triggered jobs to already-connected browser after catalog commit", async () => {
    const jobId = await createTransformJob("dispatch_on_commit");

    // Create a trigger watching "dispatch_source" table.
    const trigRes = await SELF.fetch("http://localhost/api/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ watches: "dispatch_source", job_id: jobId }),
    });
    expect(trigRes.status).toBe(201);

    // Connect browser first (no pending jobs yet for this job).
    const ws = await connectMockBrowser();
    const received = waitForTransformJob(ws, jobId);

    // Commit to watched table — Worker relays triggeredJobIds to Session DO.
    const commitRes = await SELF.fetch("http://localhost/catalog/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        table: "dispatch_source",
        uri: "r2://data-shack/dispatch_source/data.parquet",
        storageBackend: "data-shack",
        format: "parquet",
      }),
    });
    expect(commitRes.status).toBe(201);
    const commitData = (await commitRes.json()) as { triggeredJobIds: string[] };
    expect(commitData.triggeredJobIds).toContain(jobId);

    const msg = await received;
    expect(msg.outputTable).toBe("dispatch_on_commit");

    ws.close();
  });

  it("job_claimed transitions job to running status", async () => {
    const jobId = await createTransformJob("lifecycle_claim");

    await SELF.fetch(`http://localhost/api/transform-jobs/${jobId}/trigger`, {
      method: "POST",
      headers: DEV_HEADERS,
    });

    const ws = await connectMockBrowser();
    await waitForTransformJob(ws, jobId);

    // Browser claims the job; wait for DO to echo job_status: running.
    ws.send(JSON.stringify({ type: "job_claimed", jobId }));
    await waitForJobStatus(ws, jobId, "running");

    const jobsRes = await SELF.fetch("http://localhost/api/transform-jobs", {
      headers: DEV_HEADERS,
    });
    const { jobs } = (await jobsRes.json()) as { jobs: Array<{ id: string; status: string }> };
    const job = jobs.find((j) => j.id === jobId);
    expect(job?.status).toBe("running");

    ws.close();
  });

  it("job_complete marks job done and commits output to catalog", async () => {
    const jobId = await createTransformJob("lifecycle_complete");

    await SELF.fetch(`http://localhost/api/transform-jobs/${jobId}/trigger`, {
      method: "POST",
      headers: DEV_HEADERS,
    });

    const ws = await connectMockBrowser();
    await waitForTransformJob(ws, jobId);

    ws.send(JSON.stringify({ type: "job_claimed", jobId }));
    await waitForJobStatus(ws, jobId, "running");

    // Browser completes the job; wait for DO to echo job_status: done.
    ws.send(JSON.stringify({ type: "job_complete", jobId }));
    await waitForJobStatus(ws, jobId, "done");

    const jobsRes = await SELF.fetch("http://localhost/api/transform-jobs", {
      headers: DEV_HEADERS,
    });
    const { jobs } = (await jobsRes.json()) as { jobs: Array<{ id: string; status: string }> };
    const job = jobs.find((j) => j.id === jobId);
    expect(job?.status).toBe("done");

    // Session DO also commits the output URI to the catalog.
    const tablesRes = await SELF.fetch("http://localhost/catalog/tables", {
      headers: DEV_HEADERS,
    });
    const { tables } = (await tablesRes.json()) as { tables: Array<{ name: string }> };
    expect(tables.some((t) => t.name === "lifecycle_complete")).toBe(true);

    ws.close();
  });

  it("job_error marks job failed and stores error message", async () => {
    const jobId = await createTransformJob("lifecycle_error");

    await SELF.fetch(`http://localhost/api/transform-jobs/${jobId}/trigger`, {
      method: "POST",
      headers: DEV_HEADERS,
    });

    const ws = await connectMockBrowser();
    await waitForTransformJob(ws, jobId);

    ws.send(JSON.stringify({ type: "job_claimed", jobId }));
    await waitForJobStatus(ws, jobId, "running");

    ws.send(JSON.stringify({ type: "job_error", jobId, error: "DuckDB out of memory" }));
    await waitForJobStatus(ws, jobId, "failed");

    const jobsRes = await SELF.fetch("http://localhost/api/transform-jobs", {
      headers: DEV_HEADERS,
    });
    const { jobs } = (await jobsRes.json()) as {
      jobs: Array<{ id: string; status: string; error: string | null }>;
    };
    const job = jobs.find((j) => j.id === jobId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("DuckDB out of memory");

    ws.close();
  });

  it("socket close resets running jobs back to pending", async () => {
    const jobId = await createTransformJob("lifecycle_reset");

    await SELF.fetch(`http://localhost/api/transform-jobs/${jobId}/trigger`, {
      method: "POST",
      headers: DEV_HEADERS,
    });

    const ws = await connectMockBrowser();
    await waitForTransformJob(ws, jobId);

    // Claim the job; wait for DO to confirm it's running.
    ws.send(JSON.stringify({ type: "job_claimed", jobId }));
    await waitForJobStatus(ws, jobId, "running");

    // Close socket while job is still running; poll until DO resets it.
    ws.close();
    await pollJobStatus(jobId, "pending");
  });

  it("does not reset a running job that is still claimed by an active socket", async () => {
    const jobId = await createTransformJob("orphan_no_reset");

    await SELF.fetch(`http://localhost/api/transform-jobs/${jobId}/trigger`, {
      method: "POST",
      headers: DEV_HEADERS,
    });

    // ws1 claims the job — it's now running and tracked in ws1's inflightJobIds.
    const ws1 = await connectMockBrowser();
    await waitForTransformJob(ws1, jobId);
    ws1.send(JSON.stringify({ type: "job_claimed", jobId }));
    await waitForJobStatus(ws1, jobId, "running");

    // ws2 connects — dispatchPendingJobs runs reset-orphaned with ws1's claimedJobIds,
    // so the running job must NOT be reset and must NOT be dispatched to ws2.
    const ws2 = await connectMockBrowser();
    const notDispatched = await Promise.race([
      waitForTransformJob(ws2, jobId).then(() => "dispatched" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 600)),
    ]);
    expect(notDispatched).toBe("timeout");

    ws1.close();
    ws2.close();
  });

  it("re-dispatches a running job that has no active socket claiming it on reconnect", async () => {
    const jobId = await createTransformJob("orphan_reset");

    await SELF.fetch(`http://localhost/api/transform-jobs/${jobId}/trigger`, {
      method: "POST",
      headers: DEV_HEADERS,
    });

    // ws1 claims the job, then closes. webSocketClose resets the job to pending —
    // this is the normal cleanup path. The orphan-reset in dispatchPendingJobs is a
    // second safety net for when webSocketClose doesn't fire (DO restart, eviction).
    const ws1 = await connectMockBrowser();
    await waitForTransformJob(ws1, jobId);
    ws1.send(JSON.stringify({ type: "job_claimed", jobId }));
    await waitForJobStatus(ws1, jobId, "running");
    ws1.close();
    await pollJobStatus(jobId, "pending");

    // Reconnect — dispatchPendingJobs: reset-orphaned (no active sockets → reset all
    // running jobs) then dispatch pending. The job was already reset by webSocketClose,
    // so this also verifies the two cleanup paths don't conflict.
    const ws2 = await connectMockBrowser();
    const msg = await waitForTransformJob(ws2, jobId);
    expect(msg.outputTable).toBe("orphan_reset");

    ws2.close();
  });
});
