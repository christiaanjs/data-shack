import { describe, expect, it } from "vitest";
import {
  applyExisting,
  applyWatermarks,
  buildHistoryRelation,
  findExisting,
  findHistoryCalls,
  findWatermarks,
  hasTemplates,
  sampleSnapshots,
  selectSnapshots,
} from "../frontend/src/historySql.ts";

const H = 3_600_000;
const snap = (n: number, at: number) => ({
  id: `s${n}`,
  uri: `r2://b/raw/load-${n}.json`,
  format: "json",
  created_at: at,
});

describe("historySql templates", () => {
  it("detects templates", () => {
    expect(hasTemplates("SELECT 1")).toBe(false);
    expect(hasTemplates("SELECT * FROM my_history('x')")).toBe(false);
    expect(hasTemplates("SELECT * FROM history('t')")).toBe(true);
    expect(hasTemplates("WHERE x > {{watermark('t','c')}}")).toBe(true);
  });

  it("parses history args incl. watermark-expanded since", () => {
    const sql = "FROM history('transactions_raw', since => epoch_ms(1700), sample_hours => 12) h";
    const [call] = findHistoryCalls(sql);
    expect(call).toMatchObject({ table: "transactions_raw", sinceMs: 1700, sampleHours: 12 });
    const [ts] = findHistoryCalls("history('t', since => TIMESTAMP '2026-01-01 00:00:00')");
    expect(ts?.sinceMs).toBe(Date.UTC(2026, 0, 1));
  });

  it("applies watermarks, defaulting to epoch 0", () => {
    const sql = "since => {{watermark('out','_at')}} / {{ watermark('other','c') }}";
    expect(findWatermarks(sql)).toHaveLength(2);
    expect(applyWatermarks(sql, new Map([["out._at", 42]]))).toBe(
      "since => epoch_ms(42) / epoch_ms(0)",
    );
  });

  it("expands existing() to the temp table or an empty fallback", () => {
    const sql = "SELECT * FROM {{existing('out','new_rows')}}";
    expect(findExisting(sql)).toEqual([{ table: "out", fallback: "new_rows" }]);
    expect(applyExisting(sql, new Set(["out"]))).toBe('SELECT * FROM "_prev_out"');
    expect(applyExisting(sql, new Set())).toBe(
      'SELECT * FROM (SELECT * FROM "new_rows" WHERE false)',
    );
  });

  it("selects snapshots by since and sampling, oldest first", () => {
    const snaps = [snap(3, 30 * H), snap(1, 1 * H), snap(2, 2 * H), snap(4, 31 * H)];
    const [call] = findHistoryCalls(`history('t', since => epoch_ms(${2 * H}))`);
    expect(selectSnapshots(snaps, call!).map((s) => s.id)).toEqual(["s2", "s3", "s4"]);
    expect(
      sampleSnapshots(snaps, 12)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["s2", "s4"]);
  });

  it("builds a relation joining snapshot metadata and rejects empty/unsupported input", () => {
    const rel = buildHistoryRelation("t", [{ ...snap(1, 5), url: "s3://b/raw/load-1.json" }]);
    expect(rel).toContain("read_json(['s3://b/raw/load-1.json']");
    expect(rel).toContain("epoch_ms(5)");
    expect(rel).toContain("_snapshot_at");
    expect(() => buildHistoryRelation("t", [])).toThrow(/no snapshots/);
    expect(() =>
      buildHistoryRelation("t", [{ ...snap(1, 5), format: "csv", url: "s3://b/x.csv" }]),
    ).toThrow(/unsupported/);
  });
});
