import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DEV = { "X-Dev-Token": "test-token", "Content-Type": "application/json" };

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();
});

async function create(body: Record<string, unknown>, headers: Record<string, string> = DEV) {
  return SELF.fetch("http://localhost/api/tokens", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("API tokens", () => {
  it("requires auth", async () => {
    expect((await SELF.fetch("http://localhost/api/tokens")).status).toBe(401);
  });

  it("creates a token that authenticates requests", async () => {
    const res = await create({ name: "ci" });
    expect(res.status).toBe(201);
    const { token, id } = (await res.json()) as { token: string; id: string };
    expect(token.startsWith("dsk_")).toBe(true);

    const me = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { userId: string }).userId).toBe("usr_test");

    const list = (await (
      await SELF.fetch("http://localhost/api/tokens", { headers: DEV })
    ).json()) as {
      tokens: { id: string; last_used_at: number | null; token_hash?: string }[];
    };
    const row = list.tokens.find((t) => t.id === id);
    expect(row?.last_used_at).not.toBeNull();
    expect(row?.token_hash).toBeUndefined();
  });

  it("rejects invalid tokens", async () => {
    const res = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: "Bearer dsk_deadbeef" },
    });
    expect(res.status).toBe(401);
  });

  it("revoked tokens stop working", async () => {
    const { token, id } = (await (await create({ name: "temp" })).json()) as {
      token: string;
      id: string;
    };
    const del = await SELF.fetch(`http://localhost/api/tokens/${id}`, {
      method: "DELETE",
      headers: DEV,
    });
    expect(del.status).toBe(200);
    const me = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(401);
  });

  it("expired tokens are rejected", async () => {
    const { token, id } = (await (await create({ name: "exp", expires_in_days: 1 })).json()) as {
      token: string;
      id: string;
    };
    await env.DB.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, id)
      .run();
    const me = await SELF.fetch("http://localhost/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(401);
  });

  it("API tokens cannot mint tokens", async () => {
    const { token } = (await (await create({ name: "parent" })).json()) as { token: string };
    const res = await create(
      { name: "child" },
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    );
    expect(res.status).toBe(403);
  });

  it("validates input", async () => {
    expect((await create({})).status).toBe(400);
    expect((await create({ name: "x", expires_in_days: -5 })).status).toBe(400);
  });
});
