import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
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

interface CredentialRow {
  id: string;
  name: string;
  type: string;
}

const STORAGE_URI_REGEX = /(?:r2-s3compat|r2|http-ds):\/\/[^\s'"]+/g;
// Matches storage URIs that appear after a SQL TO keyword (COPY TO write destinations)
const WRITE_URI_REGEX = /\bTO\s+['"]?((?:r2-s3compat|r2):\/\/[^\s'"]+)/gi;
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
    initDuckDB()
      .then((db) => {
        dbRef.current = db;
        setDbReady(true);
      })
      .catch((err: unknown) => {
        setDbError(err instanceof Error ? err.message : "DuckDB failed to initialize");
      });
  }, []);

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
        body: JSON.stringify({ uris: uris.map((uri) => ({ uri, method: "GET" })) }),
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
      const writeUris = [
        ...new Set([...rawSql.matchAll(WRITE_URI_REGEX)].map((m) => m[1] as string)),
      ];
      const allUris = Array.from(new Set(rawSql.match(STORAGE_URI_REGEX) ?? []));
      const readUris = allUris.filter((u) => !writeUris.includes(u));

      // DuckDB WASM httpfs doesn't support HTTP PUT, so write URIs are redirected
      // to a virtual FS temp path; we upload the buffer ourselves after the query.
      const writeTempMap: Record<string, { tempPath: string; resolvedUrl: string }> = {};

      let resolvedSql = rawSql;

      if (allUris.length > 0) {
        const uriRequests = [
          ...readUris.map((uri) => ({ uri, method: "GET" as const })),
          ...writeUris.map((uri) => ({ uri, method: "PUT" as const })),
        ];
        const headers = await getAuthHeaders();
        const res = await fetch(`${workerBase}/api/storage/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ uris: uriRequests }),
        });
        if (!res.ok) throw new Error(`URI resolution failed: ${res.status}`);
        const data = (await res.json()) as { urls: Record<string, string> };

        writeUris.forEach((uri, i) => {
          const ext = uri.split(".").pop() ?? "parquet";
          writeTempMap[uri] = {
            tempPath: `/tmp/ds_write_${i}.${ext}`,
            resolvedUrl: data.urls[uri] ?? "",
          };
        });

        // Sort longest-first so a URI that is a prefix of another doesn't
        // corrupt the longer one during substitution.
        for (const uri of [...allUris].sort((a, b) => b.length - a.length)) {
          const write = writeTempMap[uri];
          if (write) {
            resolvedSql = resolvedSql.replaceAll(uri, write.tempPath);
          } else {
            const url = data.urls[uri];
            if (url) resolvedSql = resolvedSql.replaceAll(uri, url);
          }
        }
      }

      const result = await runQuery(db, resolvedSql);
      setQueryResult(result);

      // Upload files DuckDB wrote to virtual FS, then clean up
      for (const { tempPath, resolvedUrl } of Object.values(writeTempMap)) {
        if (!resolvedUrl) continue;
        const ext = tempPath.split(".").pop() ?? "";
        const contentType =
          ext === "parquet"
            ? "application/vnd.apache.parquet"
            : ext === "csv"
              ? "text/csv"
              : ext === "json" || ext === "ndjson"
                ? "application/json"
                : "application/octet-stream";
        const buffer = await db.copyFileToBuffer(tempPath);
        const uploadRes = await fetch(resolvedUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: buffer.buffer as ArrayBuffer,
        });
        if (!uploadRes.ok) throw new Error(`Storage upload failed: ${uploadRes.status}`);
        await db.dropFile(tempPath);
      }
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
