import { useCallback, useEffect, useState } from "preact/hooks";
import type { CatalogTableWithSnapshot } from "./catalogViews.ts";
import { initDuckDB, runQuery } from "./duckdb.ts";
import { resolveStorageUris } from "./resolveQuery.ts";

interface QueryPanelProps {
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  // Catalog state — managed by App, kept alive across tab switches.
  catalogTables: CatalogTableWithSnapshot[];
  catalogLoading: boolean;
  catalogError: string | null;
  catalogFailed: string[];
  onRefreshCatalog: () => void;
  // DuckDB state — managed by App.
  dbReady: boolean;
  dbError: string | null;
}

interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

interface CredentialRow {
  id: string;
  name: string;
  type: string;
}

const PLACEHOLDER_SQL = "SELECT * FROM read_json('r2://data-shack-storage/sample.ndjson') LIMIT 10";

export function QueryPanel({
  workerBase,
  getAuthHeaders,
  catalogTables,
  catalogLoading,
  catalogError,
  catalogFailed,
  onRefreshCatalog,
  dbReady,
  dbError,
}: QueryPanelProps) {
  const [sql, setSql] = useState("");
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(false);

  const [httpCredentials, setHttpCredentials] = useState<CredentialRow[]>([]);
  const [selectedCredId, setSelectedCredId] = useState("");
  const [dsPath, setDsPath] = useState("/");
  const [dsFetching, setDsFetching] = useState(false);
  const [dsResponse, setDsResponse] = useState<{ status: number; body: string } | null>(null);
  const [dsError, setDsError] = useState<string | null>(null);

  const fetchHttpCredentials = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/credentials`, { headers });
      if (!res.ok) return;
      const data = (await res.json()) as { credentials: CredentialRow[] };
      const http = data.credentials.filter((c) => c.type === "http");
      setHttpCredentials(http);
      if (http.length > 0 && !selectedCredId) setSelectedCredId(http[0]?.id ?? "");
    } catch {
      // non-fatal
    }
  }, [workerBase, getAuthHeaders, selectedCredId]);

  useEffect(() => {
    fetchHttpCredentials().catch(() => {});
  }, [fetchHttpCredentials]);

  async function handleDsFetch() {
    if (!selectedCredId) return;
    setDsFetching(true);
    setDsError(null);
    setDsResponse(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/data-sources/${selectedCredId}/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ path: dsPath }),
      });
      const text = await res.text();
      setDsResponse({ status: res.status, body: text.slice(0, 3000) });
    } catch (err) {
      setDsError(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setDsFetching(false);
    }
  }

  async function handleRunQuery() {
    if (!dbReady) return;
    const rawSql = sql || PLACEHOLDER_SQL;
    setQuerying(true);
    setQueryError(null);
    setQueryResult(null);

    try {
      const db = await initDuckDB();
      const { sql: resolvedSql, preamble } = await resolveStorageUris(
        rawSql,
        workerBase,
        getAuthHeaders,
      );
      const result = await runQuery(db, resolvedSql, preamble.length > 0 ? preamble : undefined);
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

      {/* Catalog tables */}
      <div class="card bg-base-200">
        <div class="card-body gap-3">
          <div class="flex items-center justify-between">
            <h2 class="card-title text-base">Catalog</h2>
            <button
              type="button"
              class="btn btn-xs btn-ghost"
              onClick={() => onRefreshCatalog()}
              disabled={catalogLoading || !dbReady}
              title="Reload catalog and re-register views"
            >
              {catalogLoading ? <span class="loading loading-spinner loading-xs" /> : "↺"}
            </button>
          </div>
          {catalogError && (
            <div role="alert" class="alert alert-error py-2 text-sm">
              <span>{catalogError}</span>
            </div>
          )}
          {catalogLoading && (
            <div class="flex items-center gap-2 text-base-content/60 text-sm">
              <span class="loading loading-spinner loading-xs" />
              <span>Loading catalog…</span>
            </div>
          )}
          {!catalogLoading && catalogTables.length === 0 && !catalogError && (
            <p class="text-sm text-base-content/50">
              No tables yet. Use <code class="font-mono">POST /catalog/commit</code> to register
              one.
            </p>
          )}
          {catalogTables.length > 0 && (
            <div class="flex flex-wrap gap-2">
              {catalogTables.map((t) => {
                const failed = catalogFailed.includes(t.name);
                return (
                  <button
                    key={t.id || t.name}
                    type="button"
                    class={`badge badge-outline font-mono cursor-pointer ${failed ? "badge-warning" : "hover:badge-primary"}`}
                    onClick={() => setSql(`SELECT * FROM "${t.name}" LIMIT 100`)}
                    title={
                      failed
                        ? "View unavailable — file not found in storage"
                        : `Click to query ${t.name}`
                    }
                  >
                    {t.name}
                    {failed && " ⚠"}
                  </button>
                );
              })}
            </div>
          )}
          {catalogTables.length > 0 && catalogFailed.length === 0 && (
            <p class="text-xs text-base-content/40">
              Views registered — query tables by name directly in SQL.
            </p>
          )}
          {catalogFailed.length > 0 && (
            <p class="text-xs text-warning/70">
              {catalogFailed.length === catalogTables.length ? "No" : "Some"} views could not be
              registered — the snapshot file may not exist in storage yet.
            </p>
          )}
        </div>
      </div>

      {/* HTTP data source tester */}
      {httpCredentials.length > 0 && (
        <div class="card bg-base-200">
          <div class="card-body gap-3">
            <h2 class="card-title text-base">Test HTTP Data Source</h2>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <fieldset class="fieldset sm:col-span-1">
                <legend class="fieldset-legend">Credential</legend>
                <select
                  class="select select-bordered select-sm w-full"
                  value={selectedCredId}
                  onChange={(e) => setSelectedCredId((e.target as HTMLSelectElement).value)}
                >
                  {httpCredentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </fieldset>
              <fieldset class="fieldset sm:col-span-2">
                <legend class="fieldset-legend">Path</legend>
                <input
                  type="text"
                  class="input input-bordered input-sm w-full font-mono"
                  value={dsPath}
                  onInput={(e) => setDsPath((e.target as HTMLInputElement).value)}
                  placeholder="/accounts"
                />
              </fieldset>
            </div>
            {selectedCredId && (
              <p class="text-xs text-base-content/50 font-mono">
                DuckDB URI:{" "}
                <span class="select-all">
                  http-ds://{selectedCredId}
                  {dsPath.startsWith("/") ? dsPath : `/${dsPath}`}
                </span>
              </p>
            )}
            <div>
              <button
                type="button"
                class="btn btn-sm btn-outline"
                onClick={() => handleDsFetch().catch(() => {})}
                disabled={dsFetching || !selectedCredId}
              >
                {dsFetching && <span class="loading loading-spinner loading-xs" />}
                {dsFetching ? "Fetching…" : "Fetch"}
              </button>
            </div>
            {dsError && (
              <div role="alert" class="alert alert-error py-2 text-sm">
                <span>{dsError}</span>
              </div>
            )}
            {dsResponse && (
              <div class="space-y-1">
                <p class="text-xs text-base-content/50">Status: {dsResponse.status}</p>
                <pre class="bg-base-300 rounded p-3 text-xs overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                  {dsResponse.body}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

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
