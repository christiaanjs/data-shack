import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
});

interface McpResponse {
  result?: { content: { text: string }[] };
  error?: { message: string };
}

async function callMcp(name: string, args: Record<string, unknown> = {}): Promise<McpResponse> {
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
  expect(res.status).toBe(200);
  return res.json() as Promise<McpResponse>;
}

async function createCredential(name: string): Promise<string> {
  const res = await SELF.fetch("http://localhost/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({ name, type: "http", config: { baseUrl: "http://localhost" } }),
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function createBackend(name: string): Promise<string> {
  const res = await SELF.fetch("http://localhost/api/storage-backends", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({ name, type: "r2-bound", config: { bucket: "data-shack-storage" } }),
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { id: string };
  return data.id;
}

// ── Load job tools ──────────────────────────────────────────────────────

describe("load job MCP tools", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_load_jobs", arguments: {} },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("create_load_job validates required fields", async () => {
    const data = await callMcp("create_load_job", { name: "job" });
    expect(data.error?.message).toMatch(/table_name/);
  });

  it("create_load_job resolves credential and storage backend by name, then list/update/trigger/pause/delete round-trips", async () => {
    const credName = `cred-${crypto.randomUUID().slice(0, 8)}`;
    const backendName = `backend-${crypto.randomUUID().slice(0, 8)}`;
    await createCredential(credName);
    await createBackend(backendName);

    const created = await callMcp("create_load_job", {
      name: "Fetch accounts",
      table_name: "accounts",
      credential: credName,
      storage_backend: backendName,
      http_path: "/v1/accounts",
      cron_schedule: "0 * * * *",
    });
    const createdText = created.result?.content[0]!.text ?? "";
    expect(createdText).toContain("Fetch accounts");
    const idMatch = /id: (lj_\w+)/.exec(createdText);
    expect(idMatch).not.toBeNull();
    const jobId = idMatch![1]!;

    const listed = await callMcp("list_load_jobs");
    expect(listed.result?.content[0]!.text).toContain("Fetch accounts");
    expect(listed.result?.content[0]!.text).toContain(jobId);

    const updated = await callMcp("update_load_job", {
      id: jobId,
      name: "Fetch accounts v2",
      http_path: "/v2/accounts",
    });
    expect(updated.result?.content[0]!.text).toContain("Fetch accounts v2");

    const disabled = await callMcp("set_load_job_enabled", { id: jobId, enabled: false });
    expect(disabled.result?.content[0]!.text).toContain("disabled");

    const triggered = await callMcp("trigger_load_job", { id: jobId });
    expect(triggered.result?.content[0]!.text).toContain("queued");

    const deleted = await callMcp("delete_load_job", { id: jobId });
    expect(deleted.result?.content[0]!.text).toContain("deleted");

    const afterDelete = await callMcp("update_load_job", { id: jobId, name: "gone" });
    expect(afterDelete.error?.message).toMatch(/not found/i);
  });

  it("create_load_job rejects unknown credential", async () => {
    const backendName = `backend-${crypto.randomUUID().slice(0, 8)}`;
    await createBackend(backendName);
    const data = await callMcp("create_load_job", {
      name: "job",
      table_name: "t",
      credential: "does-not-exist",
      storage_backend: backendName,
    });
    expect(data.error?.message).toMatch(/Credential not found/);
  });

  it("update_load_job requires at least one field", async () => {
    const credName = `cred-${crypto.randomUUID().slice(0, 8)}`;
    const backendName = `backend-${crypto.randomUUID().slice(0, 8)}`;
    await createCredential(credName);
    await createBackend(backendName);
    const created = await callMcp("create_load_job", {
      name: "job",
      table_name: "t",
      credential: credName,
      storage_backend: backendName,
    });
    const idMatch = /id: (lj_\w+)/.exec(created.result?.content[0]!.text ?? "");
    const jobId = idMatch![1]!;

    const data = await callMcp("update_load_job", { id: jobId });
    expect(data.error?.message).toMatch(/at least one field/);
  });
});

// ── Transform job + trigger tools ──────────────────────────────────────────

describe("transform job and trigger MCP tools", () => {
  it("create_transform_job validates required fields", async () => {
    const data = await callMcp("create_transform_job", { sql: "SELECT 1" });
    expect(data.error?.message).toMatch(/output_table/);
  });

  it("create/list/update/trigger/delete round-trip for transform jobs and triggers", async () => {
    const backendName = `backend-${crypto.randomUUID().slice(0, 8)}`;
    await createBackend(backendName);

    const created = await callMcp("create_transform_job", {
      name: "Compact transactions",
      sql: "SELECT * FROM transactions",
      output_table: "transactions_compact",
      output_uri: `r2://${backendName}/transactions_compact.parquet`,
      output_backend: backendName,
      format: "parquet",
    });
    const createdText = created.result?.content[0]!.text ?? "";
    expect(createdText).toContain("transactions_compact");
    const idMatch = /id: (tj_\w+)/.exec(createdText);
    expect(idMatch).not.toBeNull();
    const jobId = idMatch![1]!;

    const listed = await callMcp("list_transform_jobs");
    expect(listed.result?.content[0]!.text).toContain("transactions_compact");
    expect(listed.result?.content[0]!.text).toContain(jobId);

    const updated = await callMcp("update_transform_job", {
      id: jobId,
      name: "Compact transactions v2",
    });
    expect(updated.result?.content[0]!.text).toContain(jobId);

    const triggerCreated = await callMcp("create_trigger", {
      watches: ["transactions"],
      policy: "any",
      job_id: jobId,
    });
    const trigText = triggerCreated.result?.content[0]!.text ?? "";
    expect(trigText).toContain("transactions");
    const trigIdMatch = /id: (trg_\w+)/.exec(trigText);
    expect(trigIdMatch).not.toBeNull();
    const triggerId = trigIdMatch![1]!;

    const listedTriggers = await callMcp("list_triggers");
    expect(listedTriggers.result?.content[0]!.text).toContain(triggerId);
    expect(listedTriggers.result?.content[0]!.text).toContain(jobId);

    const triggeredJob = await callMcp("trigger_transform_job", { id: jobId });
    expect(triggeredJob.result?.content[0]!.text).toContain("queued");

    const deletedTrigger = await callMcp("delete_trigger", { id: triggerId });
    expect(deletedTrigger.result?.content[0]!.text).toContain("deleted");

    const deletedJob = await callMcp("delete_transform_job", { id: jobId });
    expect(deletedJob.result?.content[0]!.text).toContain("deleted");
  });

  it("create_trigger fails for unknown job_id", async () => {
    const data = await callMcp("create_trigger", { watches: ["foo"], job_id: "tj_doesnotexist" });
    expect(data.error?.message).toMatch(/not found/i);
  });
});
