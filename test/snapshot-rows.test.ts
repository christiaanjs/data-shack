import { describe, expect, it } from "vitest";
import { toSnapshotRow } from "../frontend/src/snapshotRows.ts";

describe("toSnapshotRow", () => {
  it("maps r2:// and r2-s3compat:// URIs to readable s3:// URLs with their backend", () => {
    const a = toSnapshotRow("t", {
      id: "s1",
      uri: "r2://my-backend/raw/a.json",
      format: "json",
      created_at: 5,
    });
    expect(a).toMatchObject({
      url: "s3://my-backend/raw/a.json",
      backend: "my-backend",
      created_ms: 5,
    });
    const b = toSnapshotRow("t", {
      id: "s2",
      uri: "r2-s3compat://sb_1/raw/b.json",
      format: null,
      created_at: 6.9,
    });
    expect(b).toMatchObject({
      url: "s3://sb_1/raw/b.json",
      backend: "sb_1",
      format: "json",
      created_ms: 6,
    });
  });

  it("infers format from the extension when the snapshot has none", () => {
    const f = (uri: string) =>
      toSnapshotRow("t", { id: "s", uri, format: null, created_at: 0 }).format;
    expect(f("r2://b/x.parquet")).toBe("parquet");
    expect(f("r2://b/x.ndjson")).toBe("ndjson");
    expect(f("r2://b/x.csv")).toBe("csv");
    expect(f("r2://b/x.json")).toBe("json");
  });

  it("leaves url/backend null for schemes DuckDB cannot read directly", () => {
    const r = toSnapshotRow("t", {
      id: "s",
      uri: "http-ds://cred/path",
      format: "json",
      created_at: 1,
    });
    expect(r.url).toBeNull();
    expect(r.backend).toBeNull();
  });
});
