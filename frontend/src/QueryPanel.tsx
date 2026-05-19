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
        // Sort longest-first so a URI that is a prefix of another doesn't
        // corrupt the longer one during substitution.
        for (const uri of [...uris].sort((a, b) => b.length - a.length)) {
          const url = data.urls[uri];
          if (url) resolvedSql = resolvedSql.replaceAll(uri, url);
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
    <div class="max-w-4xl mx-auto p-6 space-y-4">
      {dbError && (
        <div role="alert" class="alert alert-error">
          <span>DuckDB error: {dbError}</span>
        </div>
      )}
      {!dbReady && !dbError && (
        <div class="flex items-center gap-3 text-base-content/60 py-2">
          <span class="loading loading-spinner loading-sm" />
          <span>Initialising DuckDB…</span>
        </div>
      )}

      {/* URI resolver */}
      <div class="card bg-base-200">
        <div class="card-body gap-3">
          <h2 class="card-title text-base">Resolve Storage URIs</h2>
          <textarea
            class="textarea textarea-bordered font-mono text-sm w-full"
            placeholder={"Storage URIs (one per line)\ne.g. r2://data-shack-storage/sample.ndjson"}
            rows={3}
            value={uriInput}
            onInput={(e) => setUriInput((e.target as HTMLTextAreaElement).value)}
          />
          <div>
            <button
              type="button"
              class="btn btn-sm btn-outline"
              onClick={handleResolve}
              disabled={resolving || !uriInput.trim()}
            >
              {resolving && <span class="loading loading-spinner loading-xs" />}
              {resolving ? "Resolving…" : "Resolve"}
            </button>
          </div>
          {resolveError && (
            <div role="alert" class="alert alert-error py-2 text-sm">
              <span>{resolveError}</span>
            </div>
          )}
          {resolvedUris.length > 0 && (
            <div class="overflow-x-auto">
              <table class="table table-xs">
                <thead>
                  <tr>
                    <th>URI</th>
                    <th>Resolved URL</th>
                  </tr>
                </thead>
                <tbody>
                  {resolvedUris.map(({ uri, url }) => (
                    <tr key={uri}>
                      <td class="font-mono">{uri}</td>
                      <td class="font-mono text-base-content/60 max-w-xs truncate">{url}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* SQL editor */}
      <div class="card bg-base-200">
        <div class="card-body gap-3">
          <h2 class="card-title text-base">SQL Query</h2>
          <textarea
            class="textarea textarea-bordered font-mono text-sm w-full"
            placeholder={PLACEHOLDER_SQL}
            rows={6}
            value={sql}
            onInput={(e) => setSql((e.target as HTMLTextAreaElement).value)}
          />
          <div>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={handleRunQuery}
              disabled={querying || !dbReady}
            >
              {querying && <span class="loading loading-spinner loading-xs" />}
              {querying ? "Running…" : "Run Query"}
            </button>
          </div>
          {queryError && (
            <div role="alert" class="alert alert-error py-2 text-sm">
              <span>{queryError}</span>
            </div>
          )}
          {queryResult && (
            <div class="space-y-1">
              <p class="text-xs text-base-content/50">{queryResult.rows.length} rows</p>
              <div class="overflow-x-auto">
                <table class="table table-zebra table-sm">
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
                          <td key={j} class="font-mono text-sm">
                            {cell === null ? (
                              <em class="text-base-content/40">null</em>
                            ) : (
                              String(cell)
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
