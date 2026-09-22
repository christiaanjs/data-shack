import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
});

async function createToken(body: Record<string, unknown>): Promise<{
  id: string;
  name: string;
  token: string;
  created_at: number;
  expires_at: number | null;
}> {
  const res = await SELF.fetch("http://localhost/api/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe("POST /api/tokens", () => {
  it("creates a token with no expiry by default and returns the plaintext value once", async () => {
    const created = await createToken({ name: "my-container" });
    expect(created.id.startsWith("pat_")).toBe(true);
    expect(created.token.startsWith("dspat_")).toBe(true);
    expect(created.expires_at).toBeNull();
  });

  it("rejects a missing name", async () => {
    const res = await SELF.fetch("http://localhost/api/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...DEV_HEADERS },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("accepts an integer expiresInDays and computes expires_at", async () => {
    const before = Date.now();
    const created = await createToken({ name: "30-day-token", expiresInDays: 30 });
    expect(created.expires_at).not.toBeNull();
    const expected = before + 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs((created.expires_at as number) - expected)).toBeLessThan(5000);
  });

  it("rejects a non-integer or out-of-range expiresInDays", async () => {
    for (const bad of [0, -1, 1.5, 4000, "30"]) {
      const res = await SELF.fetch("http://localhost/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...DEV_HEADERS },
        body: JSON.stringify({ name: "bad", expiresInDays: bad }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("requires authentication", async () => {
    const res = await SELF.fetch("http://localhost/api/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "unauthed" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/tokens", () => {
  it("lists created tokens without exposing the token value", async () => {
    const created = await createToken({ name: "list-me" });
    const res = await SELF.fetch("http://localhost/api/tokens", { headers: DEV_HEADERS });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      tokens: Array<{
        id: string;
        name: string;
        created_at: number;
        last_used_at: number | null;
        expires_at: number | null;
      }>;
    };
    const found = data.tokens.find((t) => t.id === created.id);
    expect(found).toBeDefined();
    expect(found?.name).toBe("list-me");
    expect((found as Record<string, unknown>).token).toBeUndefined();
    expect((found as Record<string, unknown>).token_hash).toBeUndefined();
  });
});

describe("Bearer auth with a personal access token", () => {
  it("authenticates a REST request as the token's owner", async () => {
    const created = await createToken({ name: "bearer-test" });
    const res = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${created.token}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { userId: string };
    expect(data.userId).toBe("usr_test");
  });

  it("rejects an unknown or malformed token", async () => {
    const res = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: "Bearer dspat_doesnotexist" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a token past its expiry", async () => {
    const created = await createToken({ name: "expires-fast", expiresInDays: 1 });
    // Force it into the past directly in D1 — the API only accepts future expiry.
    await env.DB.prepare("UPDATE personal_access_tokens SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, created.id)
      .run();
    const res = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${created.token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/tokens/:id", () => {
  it("revokes a token so it can no longer authenticate", async () => {
    const created = await createToken({ name: "to-revoke" });

    const authedBefore = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${created.token}` },
    });
    expect(authedBefore.status).toBe(200);

    const del = await SELF.fetch(`http://localhost/api/tokens/${created.id}`, {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(del.status).toBe(204);

    const authedAfter = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${created.token}` },
    });
    expect(authedAfter.status).toBe(401);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await SELF.fetch("http://localhost/api/tokens/pat_doesnotexist", {
      method: "DELETE",
      headers: DEV_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("scopes deletion to the owning user", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .bind("usr_other", "other@example.com", Date.now())
      .run();
    const created = await createToken({ name: "owned-by-usr_test" });

    // A different authenticated user cannot delete usr_test's token — but the
    // only auth path in tests is the shared dev token, so assert scoping
    // directly against the DB helper the route uses instead of a second identity.
    const { deletePersonalAccessToken } = await import("../src/db/tokens.ts");
    const deleted = await deletePersonalAccessToken(env.DB, created.id, "usr_other");
    expect(deleted).toBe(false);

    const stillWorks = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${created.token}` },
    });
    expect(stillWorks.status).toBe(200);
  });
});
