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

  it("notifications/initialized returns 200", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(200);
  });

  it("tools/list returns three tools", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(data.result.tools).toHaveLength(3);
    const names = data.result.tools.map((t) => t.name);
    expect(names).toContain("get_warehouse_schema");
    expect(names).toContain("run_query");
    expect(names).toContain("read_data");
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

  it("SSE response format when Accept: text/event-stream", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...DEV_HEADERS,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text.startsWith("data:")).toBe(true);
    const jsonPart = text.replace(/^data: /, "").trim();
    const parsed = JSON.parse(jsonPart) as { result: { tools: unknown[] } };
    expect(parsed.result.tools).toHaveLength(3);
  });
});
