import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { advanceNextRunAt, listDueLoadJobs, updateLoadJobOutcome } from "../src/db/load-jobs.ts";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_other", "other@example.com", Date.now())
    .run();
});

async function createCredential(): Promise<string> {
  const res = await SELF.fetch("http://localhost/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({
      name: "Test Cred",
      type: "http",
      config: { baseUrl: "http://localhost" },
    }),
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function createBackend(): Promise<string> {
  const res = await SELF.fetch("http://localhost/api/storage-backends", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({
      name: "Test R2",
      type: "r2-bound",
      config: { bucket: "data-shack-storage" },
    }),
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { id: string };
  return data.id;
}

// ── GET /api/load-jobs ────────────────────────────────────────────────────

describe("GET /api/load-jobs", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/load-jobs");
    expect(res.status).toBe(401);
  });

  it("returns empty array for a new user", async () => {
    const res = await SELF.fetch("http://localhost/api/load-jobs", { headers: DEV_HEADERS });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { jobs: unknown[] };
    expect(Array.isArray(data.jobs)).toBe(true);
  });
});

// ── POST /api/load-jobs ───────────────────────────────────────────────────

describe("POST /api/load-jobs", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/load-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when name is missing", async () => {
    const credId = await createCredential();
    const sbId = await createBackend();
    const res = await SELF.fetch("http://localhost/api/load-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ credential_id: credId, storage_backend_id: sbId, table_name: "txns" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when credential_id is missing", async () => {
    const sbId = await createBackend();
    const res = await SELF.fetch("http://localhost/api/load-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ name: "job", storage_backend_id: sbId, table_name: "txns" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when storage_backend_id is missing", async () => {
    const credId = await createCredential();
    const res = await SELF.fetch("http://localhost/api/load-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ name: "job", credential_id: credId, table_name: "txns" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when table_name is missing", async () => {
    const credId = await createCredential();
    const sbId = await createBackend();
    const res = await SELF.fetch("http://localhost/api/load-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({ name: "job", credential_id: credId, storage_backend_id: sbId }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid table_name (spaces)", async () => {
    const credId = await createCredential();
    const sbId = await createBackend();
    const res = await SELF.fetch("http://localhost/api/load-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "job",
        credential_id: credId,
        storage_backend_id: sbId,
        table_name: "bad name",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid table_name (starts with digit)", async () => {
    const credId = await createCredential();
    const sbId = await createBackend();
    const res = await SELF.fetch("http://localhost/api/load-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "job",
        credential_id: credId,
        storage_backend_id: sbId,
        table_name: "1bad",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a job and returns 201 with lj_ id and next_run_at set", async () => {
    const credId = await createCredential();
    const sbId = await createBackend();
    const res = await SELF.fetch("http://localhost/api/load-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "My Job",
        credential_id: credId,
        storage_backend_id: sbId,
        table_name: "transactions",
        cron_schedule: "0 * * * *",
      }),
    });
    expect(res.status).toBe(201);
    const job = (await res.json()) as { id: string; next_run_at: number | null };
    expect(job.id).toMatch(/^lj_/);
    expect(job.next_run_at).not.toBeNull();
    expect(typeof job.next_run_at).toBe("number");
  });

  it("created job appears in GET /api/load-jobs", async () => {
    const credId = await createCredential();
    const sbId = await createBackend();
    const createRes = await SELF.fetch("http://localhost/api/load-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "Listed Job",
        credential_id: credId,
        storage_backend_id: sbId,
        table_name: "listed_tbl",
      }),
    });
    const created = (await createRes.json()) as { id: string };

    const listRes = await SELF.fetch("http://localhost/api/load-jobs", { headers: DEV_HEADERS });
    const data = (await listRes.json()) as { jobs: { id: string }[] };
    expect(data.jobs.some((j) => j.id === created.id)).toBe(true);
  });
});

// ── PATCH /api/load-jobs/:id ──────────────────────────────────────────────

describe("PATCH /api/load-jobs/:id", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/load-jobs/lj_fake", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent id", async () => {
    const credId = await createCredential();
    const sbId = await createBackend();
    const res = await SELF.fetch("http://localhost/api/load-jobs/lj_doesnotexist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "x",
        credential_id: credId,
        storage_backend_id: sbId,
        table_name: "tbl",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("updates fields and returns updated job", async () => {
    const credId = await createCredential();
    const sbId = await createBackend();
    const createRes = await SELF.fetch("http://localhost/api/load-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "Original",
        credential_id: credId,
        storage_backend_id: sbId,
        table_name: "orig_tbl",
        cron_schedule: "0 * * * *",
      }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const patchRes = await SELF.fetch(`http://localhost/api/load-jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "Updated",
        credential_id: credId,
        storage_backend_id: sbId,
        table_name: "updated_tbl",
        table_path: "data/updated",
        http_path: "/v2/data",
        http_method: "GET",
        format: "json",
        cron_schedule: "0 2 * * *",
      }),
    });
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as {
      name: string;
      table_name: string;
      table_path: string;
      cron_schedule: string;
      next_run_at: number | null;
    };
    expect(updated.name).toBe("Updated");
    expect(updated.table_name).toBe("updated_tbl");
    expect(updated.table_path).toBe("data/updated");
    expect(updated.cron_schedule).toBe("0 2 * * *");
    expect(updated.next_run_at).not.toBeNull();
  });

  it("returns 404 when patching another user's job", async () => {
    const now = Date.now();
    const otherId = `lj_patchother_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.DB.prepare(
      `INSERT INTO load_jobs (id, user_id, name, credential_id, storage_backend_id, table_name,
       table_path, http_path, http_method, format, cron_schedule, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        otherId,
        "usr_other",
        "Other",
        "cred_x",
        "sb_x",
        "tbl",
        "",
        "/",
        "GET",
        "ndjson",
        "0 * * * *",
        now,
        now,
      )
      .run();

    const credId = await createCredential();
    const sbId = await createBackend();
    const res = await SELF.fetch(`http://localhost/api/load-jobs/${otherId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "Hijack",
        credential_id: credId,
        storage_backend_id: sbId,
        table_name: "tbl",
      }),
    });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/load-jobs/:id ─────────────────────────────────────────────

describe("DELETE /api/load-jobs/:id", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/load-jobs/lj_fake", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent id", async () => {
    const res = await SELF.fetch("http://localhost/api/load-jobs/lj_doesnotexist", {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("returns 204 on successful delete and job is absent from list", async () => {
    const credId = await createCredential();
    const sbId = await createBackend();
    const createRes = await SELF.fetch("http://localhost/api/load-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "Deletable",
        credential_id: credId,
        storage_backend_id: sbId,
        table_name: "del_tbl",
      }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const delRes = await SELF.fetch(`http://localhost/api/load-jobs/${id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(delRes.status).toBe(204);

    const listRes = await SELF.fetch("http://localhost/api/load-jobs", { headers: DEV_HEADERS });
    const data = (await listRes.json()) as { jobs: { id: string }[] };
    expect(data.jobs.some((j) => j.id === id)).toBe(false);
  });

  it("returns 404 when deleting another user's job", async () => {
    const now = Date.now();
    const otherId = `lj_other_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.DB.prepare(
      `INSERT INTO load_jobs (id, user_id, name, credential_id, storage_backend_id, table_name,
       http_path, http_method, format, cron_schedule, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        otherId,
        "usr_other",
        "Other Job",
        "cred_x",
        "sb_x",
        "other_tbl",
        "/",
        "GET",
        "ndjson",
        "0 * * * *",
        now,
        now,
      )
      .run();

    const res = await SELF.fetch(`http://localhost/api/load-jobs/${otherId}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(404);
  });
});

// ── POST /api/load-jobs/:id/trigger ──────────────────────────────────────

describe("POST /api/load-jobs/:id/trigger", () => {
  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/load-jobs/lj_fake/trigger", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent job", async () => {
    const res = await SELF.fetch("http://localhost/api/load-jobs/lj_doesnotexist/trigger", {
      method: "POST",
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("returns 202 and enqueues for a valid job", async () => {
    const credId = await createCredential();
    const sbId = await createBackend();
    const createRes = await SELF.fetch("http://localhost/api/load-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({
        name: "Triggerable",
        credential_id: credId,
        storage_backend_id: sbId,
        table_name: "trigger_tbl",
      }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const trigRes = await SELF.fetch(`http://localhost/api/load-jobs/${id}/trigger`, {
      method: "POST",
      headers: DEV_HEADERS,
    });
    expect(trigRes.status).toBe(202);
    const data = (await trigRes.json()) as { queued: boolean };
    expect(data.queued).toBe(true);
  });
});

// ── Scheduler / D1 path ───────────────────────────────────────────────────

describe("scheduler and outcome tracking", () => {
  it("listDueLoadJobs returns jobs with next_run_at in the past", async () => {
    const past = Date.now() - 1000;
    const jobId = `lj_due_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.DB.prepare(
      `INSERT INTO load_jobs (id, user_id, name, credential_id, storage_backend_id, table_name,
       http_path, http_method, format, cron_schedule, next_run_at, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        jobId,
        "usr_test",
        "Due Job",
        "cred_x",
        "sb_x",
        "due_tbl",
        "/",
        "GET",
        "ndjson",
        "0 * * * *",
        past,
        Date.now(),
        Date.now(),
      )
      .run();

    const due = await listDueLoadJobs(env.DB, Date.now());
    expect(due.some((j) => j.id === jobId)).toBe(true);
  });

  it("advanceNextRunAt removes job from due list", async () => {
    const past = Date.now() - 1000;
    const jobId = `lj_advance_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.DB.prepare(
      `INSERT INTO load_jobs (id, user_id, name, credential_id, storage_backend_id, table_name,
       http_path, http_method, format, cron_schedule, next_run_at, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        jobId,
        "usr_test",
        "Advance Job",
        "cred_x",
        "sb_x",
        "adv_tbl",
        "/",
        "GET",
        "ndjson",
        "0 * * * *",
        past,
        Date.now(),
        Date.now(),
      )
      .run();

    const future = Date.now() + 3_600_000;
    await advanceNextRunAt(env.DB, jobId, future, Date.now());

    const due = await listDueLoadJobs(env.DB, Date.now());
    expect(due.some((j) => j.id === jobId)).toBe(false);
  });

  it("updateLoadJobOutcome persists last_run_at, next_run_at, and clears last_error", async () => {
    const jobId = `lj_outcome_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO load_jobs (id, user_id, name, credential_id, storage_backend_id, table_name,
       http_path, http_method, format, cron_schedule, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        jobId,
        "usr_test",
        "Outcome Job",
        "cred_x",
        "sb_x",
        "out_tbl",
        "/",
        "GET",
        "ndjson",
        "0 * * * *",
        now,
        now,
      )
      .run();

    const future = now + 3_600_000;
    await updateLoadJobOutcome(env.DB, jobId, now, future);

    const row = await env.DB.prepare("SELECT * FROM load_jobs WHERE id = ?")
      .bind(jobId)
      .first<{ last_run_at: number; next_run_at: number; last_error: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.last_run_at).toBe(now);
    expect(row!.next_run_at).toBe(future);
    expect(row!.last_error).toBeNull();
  });
});
