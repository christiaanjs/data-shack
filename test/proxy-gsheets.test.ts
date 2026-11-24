import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const DEV_HEADERS = { "X-Dev-Token": "test-token" };
const BACKEND = "gsheets-proxy-test";
const SPREADSHEET_ID = "sheet_abc";

function fakeS3Auth(accessKeyId: string): string {
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20240101/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fakesig`;
}

interface SheetsCall {
  method: string;
  url: string;
  body: string;
}

/** Replaces global fetch with a stub for Google's token + Sheets endpoints and records the Sheets calls. */
function stubGoogle(opts: { failClear?: boolean } = {}) {
  const calls: SheetsCall[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "at_test" });
    }
    if (req.url.startsWith("https://sheets.googleapis.com/")) {
      calls.push({ method: req.method, url: req.url, body: await req.text() });
      if (opts.failClear && req.url.endsWith(":clear")) {
        return new Response("clear failed", { status: 500 });
      }
      return Response.json({});
    }
    return saved(input, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = saved;
    },
  };
}

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind("usr_test", "test@example.com", Date.now())
    .run();

  const credRes = await SELF.fetch("http://localhost/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({
      name: "gsheets-proxy-cred",
      type: "google-sheets",
      config: { refreshToken: "rt_fake" },
    }),
  });
  const { id: credentialId } = (await credRes.json()) as { id: string };

  await SELF.fetch("http://localhost/api/storage-backends", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({
      name: BACKEND,
      type: "google-sheets",
      config: { spreadsheetId: SPREADSHEET_ID, sheetName: "Sheet1", credentialId },
    }),
  });
});

async function vendAuth(): Promise<string> {
  const res = await SELF.fetch("http://localhost/api/storage/proxy-credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...DEV_HEADERS },
    body: JSON.stringify({ backend: BACKEND, pathPrefix: "" }),
  });
  const { accessKeyId } = (await res.json()) as { accessKeyId: string };
  return fakeS3Auth(accessKeyId);
}

function proxy(path: string, auth: string, init: RequestInit = {}) {
  return SELF.fetch(`http://localhost/api/storage/s3proxy/${BACKEND}/${path}`, {
    ...init,
    headers: { Authorization: auth, ...(init.headers ?? {}) },
  });
}

const uploadIdOf = (xml: string) => /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1] ?? "";
const completeXml = (parts: Array<[number, string]>) =>
  `<CompleteMultipartUpload>${parts
    .map(([n, etag]) => `<Part><PartNumber>${n}</PartNumber><ETag>${etag}</ETag></Part>`)
    .join("")}</CompleteMultipartUpload>`;

const clearCall = (calls: SheetsCall[]) => calls.find((c) => c.url.endsWith(":clear"));
const putCall = (calls: SheetsCall[]) => calls.find((c) => c.method === "PUT");

describe("S3 proxy google-sheets PUT", () => {
  it("writes rows then clears anything below them", async () => {
    const stub = stubGoogle();
    restoreFetch = stub.restore;
    const auth = await vendAuth();

    const res = await proxy("unmatched.json", auth, {
      method: "PUT",
      body: JSON.stringify([
        { a: 1, b: "x" },
        { a: 2, b: "y" },
      ]),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"gsheets"');
    expect(JSON.parse(putCall(stub.calls)?.body ?? "{}")).toEqual({
      values: [
        ["a", "b"],
        ["1", "x"],
        ["2", "y"],
      ],
    });
    // header + 2 rows written, so everything from row 4 down is cleared.
    expect(decodeURIComponent(clearCall(stub.calls)?.url ?? "")).toContain(
      "'unmatched'!A4:ZZ:clear",
    );
  });

  it("clears the whole tab when the body has no rows", async () => {
    const stub = stubGoogle();
    restoreFetch = stub.restore;
    const auth = await vendAuth();

    const res = await proxy("unmatched.json", auth, { method: "PUT", body: "[]" });

    expect(res.status).toBe(200);
    expect(putCall(stub.calls)).toBeUndefined();
    expect(decodeURIComponent(clearCall(stub.calls)?.url ?? "")).toContain(
      "'unmatched'!A1:ZZ:clear",
    );
  });

  it("surfaces a failed clear as a 502", async () => {
    const stub = stubGoogle({ failClear: true });
    restoreFetch = stub.restore;
    const auth = await vendAuth();

    const res = await proxy("unmatched.json", auth, { method: "PUT", body: "[]" });

    expect(res.status).toBe(502);
  });

  it("rejects an unparseable body with 400", async () => {
    const stub = stubGoogle();
    restoreFetch = stub.restore;
    const auth = await vendAuth();

    const res = await proxy("unmatched.json", auth, { method: "PUT", body: "[{not json" });

    expect(res.status).toBe(400);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("S3 proxy google-sheets multipart upload", () => {
  async function initiate(auth: string, path = "multi.json") {
    const res = await proxy(`${path}?uploads=`, auth, { method: "POST" });
    expect(res.status).toBe(200);
    return uploadIdOf(await res.text());
  }

  it("buffers parts and writes the combined body on complete", async () => {
    const stub = stubGoogle();
    restoreFetch = stub.restore;
    const auth = await vendAuth();
    const uploadId = await initiate(auth);
    expect(uploadId).not.toBe("");

    // Split mid-document, and mid multi-byte character, to prove parts are joined as bytes.
    const body = new TextEncoder().encode(JSON.stringify([{ name: "café", n: 1 }]));
    const cut = body.indexOf(0xc3) + 1;
    const p1 = await proxy(`multi.json?partNumber=1&uploadId=${uploadId}`, auth, {
      method: "PUT",
      body: body.slice(0, cut),
    });
    const p2 = await proxy(`multi.json?partNumber=2&uploadId=${uploadId}`, auth, {
      method: "PUT",
      body: body.slice(cut),
    });
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    const etag1 = p1.headers.get("ETag") ?? "";
    const etag2 = p2.headers.get("ETag") ?? "";
    expect(etag1).not.toBe("");
    expect(stub.calls).toHaveLength(0); // nothing is written until complete

    const done = await proxy(`multi.json?uploadId=${uploadId}`, auth, {
      method: "POST",
      body: completeXml([
        [2, etag2],
        [1, etag1],
      ]),
    });

    expect(done.status).toBe(200);
    expect(await done.text()).toContain("<ETag>");
    expect(JSON.parse(putCall(stub.calls)?.body ?? "{}")).toEqual({
      values: [
        ["name", "n"],
        ["café", "1"],
      ],
    });
  });

  it("treats an upload with no parts as empty and clears the sheet", async () => {
    const stub = stubGoogle();
    restoreFetch = stub.restore;
    const auth = await vendAuth();
    const uploadId = await initiate(auth);

    const done = await proxy(`multi.json?uploadId=${uploadId}`, auth, {
      method: "POST",
      body: completeXml([]),
    });

    expect(done.status).toBe(200);
    expect(putCall(stub.calls)).toBeUndefined();
    expect(decodeURIComponent(clearCall(stub.calls)?.url ?? "")).toContain("'multi'!A1:ZZ:clear");
  });

  it("rejects parts and completion for an unknown upload", async () => {
    const stub = stubGoogle();
    restoreFetch = stub.restore;
    const auth = await vendAuth();

    const part = await proxy("multi.json?partNumber=1&uploadId=nope", auth, {
      method: "PUT",
      body: "[]",
    });
    const done = await proxy("multi.json?uploadId=nope", auth, {
      method: "POST",
      body: completeXml([]),
    });

    expect(part.status).toBe(404);
    expect(done.status).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses to complete an upload against a different key", async () => {
    const stub = stubGoogle();
    restoreFetch = stub.restore;
    const auth = await vendAuth();
    const uploadId = await initiate(auth, "one.json");

    const done = await proxy(`two.json?uploadId=${uploadId}`, auth, {
      method: "POST",
      body: completeXml([]),
    });

    expect(done.status).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });

  it("fails completion when a listed part was never uploaded", async () => {
    const stub = stubGoogle();
    restoreFetch = stub.restore;
    const auth = await vendAuth();
    const uploadId = await initiate(auth);

    const done = await proxy(`multi.json?uploadId=${uploadId}`, auth, {
      method: "POST",
      body: completeXml([[1, '"missing"']]),
    });

    expect(done.status).toBe(400);
    expect(stub.calls).toHaveLength(0);
  });

  it("abort discards the buffered upload", async () => {
    const stub = stubGoogle();
    restoreFetch = stub.restore;
    const auth = await vendAuth();
    const uploadId = await initiate(auth);
    await proxy(`multi.json?partNumber=1&uploadId=${uploadId}`, auth, {
      method: "PUT",
      body: "[]",
    });

    const aborted = await proxy(`multi.json?uploadId=${uploadId}`, auth, { method: "DELETE" });
    const afterAbort = await proxy(`multi.json?uploadId=${uploadId}`, auth, {
      method: "POST",
      body: completeXml([[1, '"x"']]),
    });

    expect(aborted.status).toBe(204);
    expect(afterAbort.status).toBe(404);
  });
});
