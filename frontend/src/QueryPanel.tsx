import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { useEffect, useRef, useState } from "preact/hooks";
import { initDuckDB, runQuery } from "./duckdb.ts";

interface QueryPanelProps {
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
}

interface ResolvedUri {
  uri: string;
  url: string;
}

interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

const R2_URI_REGEX = /r2:\/\/[^\s'"]+/g;
const PLACEHOLDER_SQL = "SELECT * FROM read_json('r2://data-shack-storage/sample.ndjson') LIMIT 10";

export function QueryPanel({ workerBase, getAuthHeaders }: QueryPanelProps) {
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const dbRef = useRef<AsyncDuckDB | null>(null);

  const [uriInput, setUriInput] = useState("");
  const [resolvedUris, setResolvedUris] = useState<ResolvedUri[]>([]);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const [sql, setSql] = useState("");
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(false);

  useEffect(() => {
    initDuckDB()
      .then((db) => {
        dbRef.current = db;
        setDbReady(true);
      })
      .catch((err: unknown) => {
        setDbError(err instanceof Error ? err.message : "DuckDB failed to initialize");
      });
  }, []);

  async function handleResolve() {
    const uris = uriInput
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!uris.length) return;
    setResolving(true);
    setResolveError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/storage/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ uris }),
      });
      if (!res.ok) throw new Error(`Resolve failed: ${res.status}`);
      const data = (await res.json()) as { urls: Record<string, string> };
      setResolvedUris(uris.map((uri) => ({ uri, url: data.urls[uri] ?? "" })));
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Resolve failed");
    } finally {
      setResolving(false);
    }
  }

  async function handleRunQuery() {
    const db = dbRef.current;
    if (!db) return;
    const rawSql = sql || PLACEHOLDER_SQL;
    setQuerying(true);
    setQueryError(null);
    setQueryResult(null);

    try {
      const uris = Array.from(new Set(rawSql.match(R2_URI_REGEX) ?? []));
      let resolvedSql = rawSql;

      if (uris.length > 0) {
        const headers = await getAuthHeaders();
        const res = await fetch(`${workerBase}/api/storage/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ uris }),
        });
        if (!res.ok) throw new Error(`URI resolution failed: ${res.status}`);
        const data = (await res.json()) as { urls: Record<string, string> };
        for (const uri of uris) {
          const url = data.urls[uri];
          if (url) {
            resolvedSql = resolvedSql.replaceAll(uri, url);
          }
        }
      }

      const result = await runQuery(db, resolvedSql);
      setQueryResult(result);
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : "Query failed");
    } finally {
      setQuerying(false);
    }
  }

  return (
    <div class="query-panel">
      {dbError && <div class="error-banner">DuckDB error: {dbError}</div>}
      {!dbReady && !dbError && <div class="loading">Initializing DuckDB…</div>}

      <section class="panel-section">
        <h3>Resolve Storage URIs</h3>
        <textarea
          class="uri-input"
          placeholder="Storage URIs (one per line, e.g. r2://data-shack-storage/sample.ndjson)"
          rows={3}
          value={uriInput}
          onInput={(e) => setUriInput((e.target as HTMLTextAreaElement).value)}
        />
        <button type="button" onClick={handleResolve} disabled={resolving || !uriInput.trim()}>
          {resolving ? "Resolving…" : "Resolve"}
        </button>
        {resolveError && <div class="error-banner">{resolveError}</div>}
        {resolvedUris.length > 0 && (
          <table class="resolved-table">
            <thead>
              <tr>
                <th>URI</th>
                <th>Resolved URL</th>
              </tr>
            </thead>
            <tbody>
              {resolvedUris.map(({ uri, url }) => (
                <tr key={uri}>
                  <td class="mono">{uri}</td>
                  <td class="mono url-cell">{url}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section class="panel-section">
        <h3>SQL Query</h3>
        <textarea
          class="sql-input"
          placeholder={PLACEHOLDER_SQL}
          rows={6}
          value={sql}
          onInput={(e) => setSql((e.target as HTMLTextAreaElement).value)}
        />
        <button type="button" onClick={handleRunQuery} disabled={querying || !dbReady}>
          {querying ? "Running…" : "Run Query"}
        </button>
        {queryError && <div class="error-banner">{queryError}</div>}
        {queryResult && (
          <div class="results-container">
            <p class="row-count">{queryResult.rows.length} rows</p>
            <div class="results-scroll">
              <table class="results-table">
                <thead>
                  <tr>
                    {queryResult.columns.map((col) => (
                      <th key={col}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queryResult.rows.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no stable key
                    <tr key={i}>
                      {row.map((cell, j) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: column cells keyed by position
                        <td key={j}>{cell === null ? <em>null</em> : String(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
