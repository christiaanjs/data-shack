import type { QueryResult } from "./workbench-types.ts";

export function ResultGrid({
  result,
  running,
}: { result: QueryResult | null | undefined; running: boolean }) {
  if (running)
    return (
      <div class="wb-result-empty">
        <span class="loading loading-sm" style={{ verticalAlign: "-3px", marginRight: 8 }} />
        Running…
      </div>
    );
  if (!result)
    return (
      <div class="wb-result-empty">
        Run the query (<span class="wb-kbd">⌘↵</span>) to see results here.
      </div>
    );
  if (result.error)
    return (
      <div class="wb-result-empty" style={{ color: "var(--color-error)" }}>
        {result.error}
      </div>
    );
  return (
    <div>
      <div class="wb-result-bar">
        <span>
          {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
        </span>
        {result.ms != null && <span>· {result.ms} ms</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
          {result.columns.length} cols
        </span>
      </div>
      <table class="table table-sm table-zebra">
        <thead>
          <tr>
            <th
              style={{
                width: 34,
                textAlign: "right",
                color: "color-mix(in oklch,var(--color-base-content) 35%,transparent)",
              }}
            >
              #
            </th>
            {result.columns.map((c) => (
              <th key={c} class="font-mono">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: row index is the correct key for result grids
            <tr key={i}>
              <td
                style={{
                  textAlign: "right",
                  color: "color-mix(in oklch,var(--color-base-content) 35%,transparent)",
                  fontFamily: "var(--font-mono,monospace)",
                  fontSize: 11,
                }}
              >
                {i + 1}
              </td>
              {(row as unknown[]).map((cell, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cell column index is stable
                <td key={j} class="font-mono">
                  {cell === null ? <em class="wb-null">null</em> : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
