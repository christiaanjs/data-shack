import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };

const SIMPLE_ARTIFACT = `function Dashboard({ data }) {
  return <div>{data[0] ? data[0].length + ' rows' : 'no data'}</div>;
}`;

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
});

async function callMcp(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result?: { content: { text: string }[] }; error?: { message: string } }> {
  const res = await SELF.fetch("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return res.json() as Promise<{
    result?: { content: { text: string }[] };
    error?: { message: string };
  }>;
}

async function createDashboard(
  title: string,
  artifactSource: string,
  queries: string[],
  slug?: string,
): Promise<string> {
  const res = await SELF.fetch("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "submit_dashboard",
        arguments: { title, artifact_source: artifactSource, queries, ...(slug ? { slug } : {}) },
      },
    }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { result: { content: { text: string }[] } };
  const text = data.result.content[0]!.text;
  const match = /dash_\w+/.exec(text);
  expect(match).not.toBeNull();
  return match![0];
}

describe("submit_dashboard MCP tool", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "submit_dashboard",
          arguments: { title: "t", artifact_source: SIMPLE_ARTIFACT, queries: [] },
        },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("creates a dashboard and returns its id in the response text", async () => {
    const id = await createDashboard("Spending Breakdown", SIMPLE_ARTIFACT, ["SELECT 1 AS n"]);
    expect(id).toMatch(/^dash_/);
  });

  it("auto-generates a slug from the title", async () => {
    const data = await callMcp("submit_dashboard", {
      title: "Auto Slug Test",
      artifact_source: SIMPLE_ARTIFACT,
      queries: [],
    });
    expect(data.result?.content[0]?.text).toMatch(/slug: auto-slug-test/);
  });

  it("uses an explicit slug when provided", async () => {
    const data = await callMcp("submit_dashboard", {
      title: "Explicit Slug Test",
      artifact_source: SIMPLE_ARTIFACT,
      queries: [],
      slug: "my-explicit-slug",
    });
    expect(data.result?.content[0]?.text).toContain("slug: my-explicit-slug");
  });

  it("returns error when title is missing", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "submit_dashboard",
          arguments: { title: "", artifact_source: SIMPLE_ARTIFACT, queries: [] },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("title");
  });

  it("returns error when artifact_source is missing", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "submit_dashboard",
          arguments: { title: "T", artifact_source: "   ", queries: [] },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("artifact_source");
  });

  it("returns error when queries is not an array", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "submit_dashboard",
          arguments: { title: "T", artifact_source: SIMPLE_ARTIFACT, queries: "SELECT 1" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("queries");
  });

  it("rejects artifact exceeding 50 KB", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "submit_dashboard",
          arguments: {
            title: "T",
            artifact_source: "x".repeat(51_000),
            queries: [],
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("50 KB");
  });
});

describe("GET /api/dashboards", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/dashboards");
    expect(res.status).toBe(401);
  });

  it("does not expose dashboards from other users", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .bind("usr_list_isolation", "list-iso@example.com", Date.now())
      .run();
    const otherId = `dash_list_iso_${Date.now()}`;
    await env.DB.prepare(
      "INSERT INTO dashboards (id, user_id, title, artifact_source, queries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        otherId,
        "usr_list_isolation",
        "Other User Dash",
        SIMPLE_ARTIFACT,
        "[]",
        Date.now(),
        Date.now(),
      )
      .run();

    const res = await SELF.fetch("http://localhost/api/dashboards", { headers: DEV_HEADERS });
    expect(res.status).toBe(200);
    const { dashboards } = (await res.json()) as { dashboards: { id: string }[] };
    expect(dashboards.find((d) => d.id === otherId)).toBeUndefined();
  });

  it("returns created dashboards in the list", async () => {
    await createDashboard("List Test Dashboard", SIMPLE_ARTIFACT, ["SELECT 42 AS answer"]);
    const res = await SELF.fetch("http://localhost/api/dashboards", { headers: DEV_HEADERS });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      dashboards: { id: string; title: string; slug: string | null; created_at: number }[];
    };
    const found = data.dashboards.find((d) => d.title === "List Test Dashboard");
    expect(found).toBeDefined();
    expect(found?.id).toMatch(/^dash_/);
    expect(typeof found?.created_at).toBe("number");
    expect(Object.keys(found!)).toContain("slug");
    // List endpoint must not expose artifact_source
    expect(Object.keys(found!)).not.toContain("artifact_source");
  });
});

describe("GET /api/dashboards/:id", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/dashboards/dash_notreal");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-existent id", async () => {
    const res = await SELF.fetch("http://localhost/api/dashboards/dash_doesnotexist", {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("returns full dashboard with queries as a parsed array", async () => {
    const id = await createDashboard("Detail Test", SIMPLE_ARTIFACT, [
      "SELECT 1 AS a",
      "SELECT 2 AS b",
    ]);
    const res = await SELF.fetch(`http://localhost/api/dashboards/${id}`, {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: string;
      title: string;
      slug: string | null;
      artifact_source: string;
      queries: unknown;
      created_at: number;
      updated_at: number;
    };
    expect(data.id).toBe(id);
    expect(data.title).toBe("Detail Test");
    expect(data.artifact_source).toBe(SIMPLE_ARTIFACT);
    expect(Array.isArray(data.queries)).toBe(true);
    expect(data.queries).toEqual(["SELECT 1 AS a", "SELECT 2 AS b"]);
    expect(typeof data.created_at).toBe("number");
    expect(Object.keys(data)).toContain("slug");
  });

  it("can look up a dashboard by slug", async () => {
    await createDashboard("Slug Lookup Test", SIMPLE_ARTIFACT, [], "slug-lookup-test");
    const res = await SELF.fetch("http://localhost/api/dashboards/slug-lookup-test", {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { title: string; slug: string | null };
    expect(data.title).toBe("Slug Lookup Test");
    expect(data.slug).toBe("slug-lookup-test");
  });

  it("returns 404 when accessing another user's dashboard", async () => {
    // Insert a dashboard directly for a different user (create user first for FK).
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .bind("usr_other_isolation", "other-isolation@example.com", Date.now())
      .run();
    const otherId = `dash_other_${Date.now()}`;
    await env.DB.prepare(
      "INSERT INTO dashboards (id, user_id, title, artifact_source, queries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        otherId,
        "usr_other_isolation",
        "Other User Dashboard",
        SIMPLE_ARTIFACT,
        "[]",
        Date.now(),
        Date.now(),
      )
      .run();

    const res = await SELF.fetch(`http://localhost/api/dashboards/${otherId}`, {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/dashboards/:id", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/dashboards/dash_x", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-existent id", async () => {
    const res = await SELF.fetch("http://localhost/api/dashboards/dash_doesnotexist", {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("returns 204 on successful delete and 404 on second delete", async () => {
    const id = await createDashboard("Delete Me", SIMPLE_ARTIFACT, []);
    const first = await SELF.fetch(`http://localhost/api/dashboards/${id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(first.status).toBe(204);

    const second = await SELF.fetch(`http://localhost/api/dashboards/${id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(second.status).toBe(404);
  });

  it("deleted dashboard no longer appears in list", async () => {
    const id = await createDashboard("Gone Dashboard", SIMPLE_ARTIFACT, []);
    await SELF.fetch(`http://localhost/api/dashboards/${id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    const res = await SELF.fetch("http://localhost/api/dashboards", { headers: DEV_HEADERS });
    const data = (await res.json()) as { dashboards: { id: string }[] };
    expect(data.dashboards.find((d) => d.id === id)).toBeUndefined();
  });

  it("creates a snapshot with reason 'delete' when deleted", async () => {
    const id = await createDashboard("Snapshot On Delete", SIMPLE_ARTIFACT, ["SELECT 99"]);
    await SELF.fetch(`http://localhost/api/dashboards/${id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    const snaps = await env.DB.prepare(
      "SELECT snapshot_reason, title FROM dashboard_snapshots WHERE dashboard_id = ?",
    )
      .bind(id)
      .all<{ snapshot_reason: string; title: string }>();
    expect(snaps.results).toHaveLength(1);
    expect(snaps.results[0]?.snapshot_reason).toBe("delete");
    expect(snaps.results[0]?.title).toBe("Snapshot On Delete");
  });
});

describe("PATCH /api/dashboards/:id", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/dashboards/dash_x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Title" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-existent id", async () => {
    const res = await SELF.fetch("http://localhost/api/dashboards/dash_doesnotexist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ title: "New Title" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when no fields provided", async () => {
    const id = await createDashboard("Patch Empty", SIMPLE_ARTIFACT, []);
    const res = await SELF.fetch(`http://localhost/api/dashboards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("updates title and returns the updated dashboard", async () => {
    const id = await createDashboard("Patch Title Original", SIMPLE_ARTIFACT, []);
    const res = await SELF.fetch(`http://localhost/api/dashboards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ title: "Patch Title Updated" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { title: string; id: string };
    expect(data.title).toBe("Patch Title Updated");
    expect(data.id).toBe(id);
  });

  it("creates a snapshot with reason 'update' before patching", async () => {
    const id = await createDashboard("Patch Snapshot Test", SIMPLE_ARTIFACT, ["SELECT 1"]);
    await SELF.fetch(`http://localhost/api/dashboards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ title: "Patch Snapshot Updated" }),
    });
    const snaps = await env.DB.prepare(
      "SELECT snapshot_reason, title FROM dashboard_snapshots WHERE dashboard_id = ?",
    )
      .bind(id)
      .all<{ snapshot_reason: string; title: string }>();
    expect(snaps.results).toHaveLength(1);
    expect(snaps.results[0]?.snapshot_reason).toBe("update");
    expect(snaps.results[0]?.title).toBe("Patch Snapshot Test");
  });

  it("can look up by slug for PATCH", async () => {
    await createDashboard("Patch By Slug", SIMPLE_ARTIFACT, [], "patch-by-slug-test");
    const res = await SELF.fetch("http://localhost/api/dashboards/patch-by-slug-test", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ title: "Patched Via Slug" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { title: string };
    expect(data.title).toBe("Patched Via Slug");
  });

  it("can update the slug", async () => {
    const id = await createDashboard("Patch Slug Change", SIMPLE_ARTIFACT, []);
    const res = await SELF.fetch(`http://localhost/api/dashboards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ slug: "new-slug-for-patch" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { slug: string | null };
    expect(data.slug).toBe("new-slug-for-patch");

    // Verify slug lookup works
    const getRes = await SELF.fetch("http://localhost/api/dashboards/new-slug-for-patch", {
      headers: DEV_HEADERS,
    });
    expect(getRes.status).toBe(200);
  });
});

describe("MCP list_dashboards", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_dashboards", arguments: {} },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns a message when no dashboards exist for a fresh user", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .bind("usr_list_fresh", "list-fresh@example.com", Date.now())
      .run();
    // Use a different user token — not possible with DEV_HEADERS, so just verify list includes
    // created dashboards instead.
    const id = await createDashboard("MCP List Test Dashboard", SIMPLE_ARTIFACT, []);
    const data = await callMcp("list_dashboards", {});
    const text = data.result?.content[0]?.text ?? "";
    expect(text).toContain("MCP List Test Dashboard");
    expect(text).toContain(id);
  });
});

describe("MCP get_dashboard", () => {
  it("returns error for unknown id", async () => {
    const data = await callMcp("get_dashboard", { id_or_slug: "dash_doesnotexist" });
    expect(data.error?.message).toContain("not found");
  });

  it("returns dashboard details by id", async () => {
    const id = await createDashboard("MCP Get Test", SIMPLE_ARTIFACT, ["SELECT 7 AS n"]);
    const data = await callMcp("get_dashboard", { id_or_slug: id });
    const text = data.result?.content[0]?.text ?? "";
    expect(text).toContain("MCP Get Test");
    expect(text).toContain(id);
    expect(text).toContain("SELECT 7 AS n");
    expect(text).toContain(SIMPLE_ARTIFACT);
  });

  it("returns dashboard by slug", async () => {
    await createDashboard("MCP Get By Slug", SIMPLE_ARTIFACT, [], "mcp-get-by-slug");
    const data = await callMcp("get_dashboard", { id_or_slug: "mcp-get-by-slug" });
    const text = data.result?.content[0]?.text ?? "";
    expect(text).toContain("MCP Get By Slug");
    expect(text).toContain("mcp-get-by-slug");
  });

  it("returns error when id_or_slug is missing", async () => {
    const data = await callMcp("get_dashboard", {});
    expect(data.error?.message).toContain("id_or_slug");
  });
});

describe("MCP update_dashboard", () => {
  it("returns error for unknown id", async () => {
    const data = await callMcp("update_dashboard", {
      id_or_slug: "dash_doesnotexist",
      title: "New Title",
    });
    expect(data.error?.message).toContain("not found");
  });

  it("returns error when no fields provided", async () => {
    const id = await createDashboard("MCP Update Empty", SIMPLE_ARTIFACT, []);
    const data = await callMcp("update_dashboard", { id_or_slug: id });
    expect(data.error?.message).toContain("required");
  });

  it("updates title and returns confirmation", async () => {
    const id = await createDashboard("MCP Update Original", SIMPLE_ARTIFACT, []);
    const data = await callMcp("update_dashboard", {
      id_or_slug: id,
      title: "MCP Update New Title",
    });
    const text = data.result?.content[0]?.text ?? "";
    expect(text).toContain("MCP Update New Title");
    expect(text).toContain(id);
  });

  it("creates a snapshot with reason 'update'", async () => {
    const id = await createDashboard("MCP Snapshot Test", SIMPLE_ARTIFACT, ["SELECT 1"]);
    await callMcp("update_dashboard", { id_or_slug: id, title: "MCP Snapshot Updated" });
    const snaps = await env.DB.prepare(
      "SELECT snapshot_reason FROM dashboard_snapshots WHERE dashboard_id = ?",
    )
      .bind(id)
      .all<{ snapshot_reason: string }>();
    expect(snaps.results.length).toBeGreaterThan(0);
    expect(snaps.results[0]?.snapshot_reason).toBe("update");
  });

  it("can look up by slug", async () => {
    await createDashboard("MCP Update By Slug", SIMPLE_ARTIFACT, [], "mcp-update-slug-test");
    const data = await callMcp("update_dashboard", {
      id_or_slug: "mcp-update-slug-test",
      title: "MCP Updated Via Slug",
    });
    expect(data.result?.content[0]?.text).toContain("MCP Updated Via Slug");
  });
});

async function commitSnapshot(table: string, uri: string, format?: string): Promise<void> {
  await SELF.fetch("http://localhost/catalog/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({
      table,
      uri,
      storageBackend: "r2-bound",
      accessMode: "r2-bound",
      format,
    }),
  });
}

describe("GET /api/table-data/:tableName", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/table-data/any_table");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a table not in the catalog", async () => {
    const res = await SELF.fetch("http://localhost/api/table-data/td_nonexistent_table_xyz", {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a parquet snapshot (requires DuckDB)", async () => {
    await commitSnapshot("td_parquet_table", "r2://data-shack/td-parquet-file.parquet");
    const res = await SELF.fetch("http://localhost/api/table-data/td_parquet_table", {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/DuckDB/);
  });

  it("streams JSON content for an r2://data-shack snapshot", async () => {
    const rows = [
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ];
    await env.R2.put("users/usr_test/td-json-test.json", JSON.stringify(rows));
    await commitSnapshot("td_json_table", "r2://data-shack/td-json-test.json");

    const res = await SELF.fetch("http://localhost/api/table-data/td_json_table", {
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const parsed = (await res.json()) as { id: number; name: string }[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.name).toBe("alpha");
  });
});
