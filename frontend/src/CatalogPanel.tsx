import { useCallback, useEffect, useState } from "preact/hooks";

interface CatalogTable {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
}

interface CatalogSnapshot {
  id: string;
  table_id: string;
  uri: string;
  storage_backend: string;
  access_mode: string;
  format: string | null;
  created_at: number;
}

interface StorageBackend {
  id: string;
  name: string;
  type: string;
}

interface CredentialRow {
  id: string;
  name: string;
  type: string;
}

interface CatalogPanelProps {
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
}

const FORMAT_OPTIONS = [
  { value: "", label: "Auto — infer from URI extension" },
  { value: "ndjson", label: "NDJSON / JSON Lines (.ndjson, .jsonl)" },
  { value: "json", label: "JSON array (.json)" },
  { value: "parquet", label: "Parquet (.parquet)" },
  { value: "csv", label: "CSV (.csv)" },
];

function formatLabel(format: string | null, uri: string): string {
  if (format) return format;
  if (uri.endsWith(".parquet")) return "parquet (auto)";
  if (uri.endsWith(".csv")) return "csv (auto)";
  if (uri.endsWith(".ndjson") || uri.endsWith(".jsonl")) return "ndjson (auto)";
  return "json (auto)";
}

export function CatalogPanel({ workerBase, getAuthHeaders }: CatalogPanelProps) {
  const [tables, setTables] = useState<CatalogTable[]>([]);
  const [latestSnap, setLatestSnap] = useState<Record<string, CatalogSnapshot>>({});
  const [backends, setBackends] = useState<StorageBackend[]>([]);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Commit form
  const [cTable, setCTable] = useState("");
  const [cUri, setCUri] = useState("");
  const [cBackend, setCBackend] = useState("");
  const [cFormat, setCFormat] = useState("");
  const [cMessage, setCMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitSuccess, setCommitSuccess] = useState(false);

  // Pagination (http-ds:// only)
  const [cPagEnabled, setCPagEnabled] = useState(false);
  const [cPagCursorParam, setCPagCursorParam] = useState("cursor");
  const [cPagCursorPath, setCPagCursorPath] = useState("");
  const [cPagDataPath, setCPagDataPath] = useState("");

  // Inline edit
  const [editingSnapId, setEditingSnapId] = useState<string | null>(null);
  const [eUri, setEUri] = useState("");
  const [eFormat, setEFormat] = useState("");
  const [patching, setPatching] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);

  // Delete
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/catalog/tables`, { headers });
      if (!res.ok) throw new Error(`Catalog fetch failed: ${res.status}`);
      const { tables: tbls } = (await res.json()) as { tables: CatalogTable[] };
      setTables(tbls);

      const snaps: Record<string, CatalogSnapshot> = {};
      await Promise.all(
        tbls.map(async (t) => {
          const r = await fetch(`${workerBase}/catalog/snapshots/${encodeURIComponent(t.name)}`, {
            headers,
          });
          if (!r.ok) return;
          const { snapshots } = (await r.json()) as { snapshots: CatalogSnapshot[] };
          if (snapshots[0]) snaps[t.id] = snapshots[0] as CatalogSnapshot;
        }),
      );
      setLatestSnap(snaps);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [workerBase, getAuthHeaders]);

  const loadBackends = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/storage-backends`, { headers });
      if (!res.ok) return;
      const { backends: bs } = (await res.json()) as { backends: StorageBackend[] };
      setBackends(bs);
    } catch {
      // non-fatal
    }
  }, [workerBase, getAuthHeaders]);

  const loadCredentials = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/credentials`, { headers });
      if (!res.ok) return;
      const { credentials: creds } = (await res.json()) as { credentials: CredentialRow[] };
      setCredentials(creds.filter((c) => c.type === "http"));
    } catch {
      // non-fatal
    }
  }, [workerBase, getAuthHeaders]);

  useEffect(() => {
    load().catch(() => {});
    loadBackends().catch(() => {});
    loadCredentials().catch(() => {});
  }, [load, loadBackends, loadCredentials]);

  const isHttpDs = cUri.startsWith("http-ds://");

  // When URI is http-ds://, auto-derive the backend from the credential name in the URI.
  function resolvedBackend(): string {
    if (isHttpDs) {
      const withoutScheme = cUri.slice("http-ds://".length);
      const slashIdx = withoutScheme.indexOf("/");
      return slashIdx === -1 ? withoutScheme : withoutScheme.slice(0, slashIdx);
    }
    return cBackend;
  }

  async function handleCommit(e: Event) {
    e.preventDefault();
    setCommitting(true);
    setCommitError(null);
    setCommitSuccess(false);
    try {
      const headers = await getAuthHeaders();

      // Build URI — append pagination query params when enabled for http-ds://
      let finalUri = cUri;
      if (isHttpDs && cPagEnabled) {
        const params = new URLSearchParams();
        if (cPagCursorParam) params.set("_pag_cursor_param", cPagCursorParam);
        if (cPagCursorPath) params.set("_pag_cursor_path", cPagCursorPath);
        if (cPagDataPath) params.set("_pag_data_path", cPagDataPath);
        const qs = params.toString();
        if (qs) finalUri = `${cUri}${cUri.includes("?") ? "&" : "?"}${qs}`;
      }

      const body: Record<string, string> = {
        table: cTable,
        uri: finalUri,
        storageBackend: resolvedBackend(),
      };
      if (cFormat) body.format = cFormat;
      if (cMessage) body.message = cMessage;
      const res = await fetch(`${workerBase}/catalog/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || String(res.status));
      }
      setCTable("");
      setCUri("");
      setCBackend("");
      setCFormat("");
      setCMessage("");
      setCPagEnabled(false);
      setCPagCursorParam("cursor");
      setCPagCursorPath("");
      setCPagDataPath("");
      setCommitSuccess(true);
      await load();
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setCommitting(false);
    }
  }

  async function handleDelete(tableId: string) {
    setDeleting(true);
    setDeleteError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/catalog/tables/${tableId}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || String(res.status));
      }
      setConfirmDeleteId(null);
      await load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  function startEdit(snap: CatalogSnapshot) {
    setEditingSnapId(snap.id);
    setEUri(snap.uri);
    setEFormat(snap.format ?? "");
    setPatchError(null);
  }

  async function handlePatch() {
    if (!editingSnapId) return;
    setPatching(true);
    setPatchError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/catalog/snapshots/${editingSnapId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ uri: eUri, format: eFormat || null }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || String(res.status));
      }
      setEditingSnapId(null);
      await load();
    } catch (err) {
      setPatchError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setPatching(false);
    }
  }

  return (
    <div class="max-w-4xl mx-auto p-6 space-y-6">
      {/* URI convention callout */}
      <div class="card bg-base-200">
        <div class="card-body gap-2 py-4">
          <h2 class="card-title text-sm">URI conventions</h2>
          <div class="space-y-2 text-sm text-base-content/80">
            <p>
              <code class="font-mono text-xs bg-base-300 px-1 rounded">
                r2://bucket-name/path/to/file.parquet
              </code>{" "}
              — R2-bound storage. The bucket name is required but not validated — use the real
              bucket name as a convention (e.g.{" "}
              <code class="font-mono text-xs">data-shack-storage</code>). Everything{" "}
              <strong>after the first slash</strong> is the file path within your user namespace:{" "}
              <code class="font-mono text-xs">r2://bucket/folder/file.parquet</code> →{" "}
              <code class="font-mono text-xs">users/{"<you>"}/folder/file.parquet</code>.
            </p>
            <p>
              <code class="font-mono text-xs bg-base-300 px-1 rounded">
                r2-s3compat://backend-id/path/to/file.parquet
              </code>{" "}
              — S3-compatible backend. Use the backend ID shown in Settings → Storage Backends.
            </p>
            <p>
              <code class="font-mono text-xs bg-base-300 px-1 rounded">
                http-ds://credName/path
              </code>{" "}
              — Live HTTP data source. The credential name is embedded in the URI; the storage
              backend is auto-filled. Enable pagination below to append cursor parameters (
              <code class="font-mono text-xs">_pag_cursor_param</code>,{" "}
              <code class="font-mono text-xs">_pag_cursor_path</code>,{" "}
              <code class="font-mono text-xs">_pag_data_path</code>) to the committed URI.
            </p>
          </div>
        </div>
      </div>

      {/* Commit form */}
      <div class="card bg-base-200">
        <div class="card-body gap-3">
          <h2 class="card-title text-base">Commit Snapshot</h2>
          <form onSubmit={handleCommit} class="space-y-3">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <fieldset class="fieldset">
                <legend class="fieldset-legend">Table name</legend>
                <input
                  type="text"
                  class="input input-bordered input-sm w-full font-mono"
                  placeholder="transactions"
                  value={cTable}
                  onInput={(e) => setCTable((e.target as HTMLInputElement).value)}
                  required
                />
              </fieldset>
              <fieldset class="fieldset">
                <legend class="fieldset-legend">
                  {isHttpDs ? "Credential (auto-filled from URI)" : "Storage backend"}
                </legend>
                <input
                  class="input input-bordered input-sm w-full font-mono"
                  list={isHttpDs ? undefined : "backend-datalist"}
                  placeholder="primary-r2 or backend ID"
                  value={isHttpDs ? resolvedBackend() : cBackend}
                  onInput={(e) => {
                    if (!isHttpDs) setCBackend((e.target as HTMLInputElement).value);
                  }}
                  readOnly={isHttpDs}
                  required
                />
                {!isHttpDs && (
                  <datalist id="backend-datalist">
                    {backends.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.type})
                      </option>
                    ))}
                  </datalist>
                )}
              </fieldset>
            </div>
            <fieldset class="fieldset">
              <legend class="fieldset-legend">URI</legend>
              <input
                type="text"
                class="input input-bordered input-sm w-full font-mono"
                list="uri-credential-datalist"
                placeholder="r2://data-shack-storage/transactions/2026-05.parquet"
                value={cUri}
                onInput={(e) => setCUri((e.target as HTMLInputElement).value)}
                required
              />
              <datalist id="uri-credential-datalist">
                {credentials.map((c) => (
                  <option key={c.id} value={`http-ds://${c.id}/`} label={c.name} />
                ))}
              </datalist>
            </fieldset>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <fieldset class="fieldset">
                <legend class="fieldset-legend">Format</legend>
                <select
                  class="select select-bordered select-sm w-full"
                  value={cFormat}
                  onChange={(e) => setCFormat((e.target as HTMLSelectElement).value)}
                >
                  {FORMAT_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </fieldset>
              <fieldset class="fieldset">
                <legend class="fieldset-legend">Message (optional)</legend>
                <input
                  type="text"
                  class="input input-bordered input-sm w-full"
                  placeholder="initial load"
                  value={cMessage}
                  onInput={(e) => setCMessage((e.target as HTMLInputElement).value)}
                />
              </fieldset>
            </div>
            {/* Cursor pagination — only shown for http-ds:// URIs */}
            {isHttpDs && (
              <div class="border border-base-300 rounded-box p-3 space-y-3">
                <label class="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    checked={cPagEnabled}
                    onChange={(e) => setCPagEnabled((e.target as HTMLInputElement).checked)}
                  />
                  <span class="text-sm font-medium">Cursor pagination</span>
                </label>
                {cPagEnabled && (
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pl-6">
                    <fieldset class="fieldset">
                      <legend class="fieldset-legend">Cursor param</legend>
                      <input
                        type="text"
                        class="input input-bordered input-sm w-full font-mono"
                        value={cPagCursorParam}
                        onInput={(e) => setCPagCursorParam((e.target as HTMLInputElement).value)}
                        placeholder="cursor"
                      />
                    </fieldset>
                    <fieldset class="fieldset">
                      <legend class="fieldset-legend">Cursor path</legend>
                      <input
                        type="text"
                        class="input input-bordered input-sm w-full font-mono"
                        value={cPagCursorPath}
                        onInput={(e) => setCPagCursorPath((e.target as HTMLInputElement).value)}
                        placeholder="next"
                      />
                      <p class="text-xs text-base-content/50 mt-1">
                        Dot-notation path in the response for the next cursor value
                      </p>
                    </fieldset>
                    <fieldset class="fieldset sm:col-span-2">
                      <legend class="fieldset-legend">
                        Data path <span class="text-base-content/40 font-normal">(optional)</span>
                      </legend>
                      <input
                        type="text"
                        class="input input-bordered input-sm w-full font-mono"
                        value={cPagDataPath}
                        onInput={(e) => setCPagDataPath((e.target as HTMLInputElement).value)}
                        placeholder="items"
                      />
                      <p class="text-xs text-base-content/50 mt-1">
                        Dot-notation path to the data array. If omitted, the entire response body is
                        used.
                      </p>
                    </fieldset>
                  </div>
                )}
              </div>
            )}
            {commitError && (
              <div role="alert" class="alert alert-error py-2 text-sm">
                <span>{commitError}</span>
              </div>
            )}
            {commitSuccess && (
              <div role="alert" class="alert alert-success py-2 text-sm">
                <span>Snapshot committed.</span>
              </div>
            )}
            <div>
              <button type="submit" class="btn btn-primary btn-sm" disabled={committing}>
                {committing && <span class="loading loading-spinner loading-xs" />}
                {committing ? "Committing…" : "Commit"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Table list */}
      <div class="card bg-base-200">
        <div class="card-body gap-3">
          <div class="flex items-center justify-between">
            <h2 class="card-title text-base">Tables</h2>
            <button
              type="button"
              class="btn btn-xs btn-ghost"
              onClick={() => load().catch(() => {})}
              disabled={loading}
              title="Reload"
            >
              {loading ? <span class="loading loading-spinner loading-xs" /> : "↺"}
            </button>
          </div>
          {loadError && (
            <div role="alert" class="alert alert-error py-2 text-sm">
              <span>{loadError}</span>
            </div>
          )}
          {deleteError && (
            <div role="alert" class="alert alert-error py-2 text-sm">
              <span>{deleteError}</span>
            </div>
          )}
          {!loading && tables.length === 0 && !loadError && (
            <p class="text-sm text-base-content/50">No tables yet. Commit a snapshot above.</p>
          )}
          {tables.length > 0 && (
            <div class="overflow-x-auto">
              <table class="table table-sm">
                <thead>
                  <tr>
                    <th>Table</th>
                    <th>Latest snapshot URI</th>
                    <th>Format</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tables.map((t) => {
                    const snap = latestSnap[t.id];
                    const isEditing = editingSnapId === snap?.id;
                    return (
                      <tr key={t.id}>
                        <td class="font-mono font-semibold align-top pt-3">{t.name}</td>
                        {isEditing ? (
                          <>
                            <td>
                              <input
                                type="text"
                                class="input input-bordered input-xs w-full font-mono"
                                value={eUri}
                                onInput={(e) => setEUri((e.target as HTMLInputElement).value)}
                              />
                            </td>
                            <td>
                              <select
                                class="select select-bordered select-xs w-full"
                                value={eFormat}
                                onChange={(e) => setEFormat((e.target as HTMLSelectElement).value)}
                              >
                                {FORMAT_OPTIONS.map((f) => (
                                  <option key={f.value} value={f.value}>
                                    {f.value || "auto"}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td class="align-top pt-2">
                              <div class="flex gap-1">
                                <button
                                  type="button"
                                  class="btn btn-xs btn-primary"
                                  onClick={handlePatch}
                                  disabled={patching}
                                >
                                  {patching ? (
                                    <span class="loading loading-spinner loading-xs" />
                                  ) : (
                                    "Save"
                                  )}
                                </button>
                                <button
                                  type="button"
                                  class="btn btn-xs btn-ghost"
                                  onClick={() => setEditingSnapId(null)}
                                  disabled={patching}
                                >
                                  Cancel
                                </button>
                              </div>
                              {patchError && <p class="text-xs text-error mt-1">{patchError}</p>}
                            </td>
                          </>
                        ) : (
                          <>
                            <td class="font-mono text-xs text-base-content/70 max-w-xs truncate align-top pt-3">
                              {snap ? snap.uri : <em class="text-base-content/40">no snapshot</em>}
                            </td>
                            <td class="text-xs text-base-content/60 align-top pt-3">
                              {snap ? formatLabel(snap.format, snap.uri) : "—"}
                            </td>
                            <td class="align-top pt-2">
                              {confirmDeleteId === t.id ? (
                                <div class="flex gap-1">
                                  <button
                                    type="button"
                                    class="btn btn-xs btn-error"
                                    onClick={() => handleDelete(t.id)}
                                    disabled={deleting}
                                  >
                                    {deleting ? (
                                      <span class="loading loading-spinner loading-xs" />
                                    ) : (
                                      "Confirm"
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    class="btn btn-xs btn-ghost"
                                    onClick={() => setConfirmDeleteId(null)}
                                    disabled={deleting}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <div class="flex gap-1">
                                  {snap && (
                                    <button
                                      type="button"
                                      class="btn btn-xs btn-ghost"
                                      onClick={() => startEdit(snap)}
                                    >
                                      Edit
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    class="btn btn-xs btn-ghost text-error/70 hover:text-error"
                                    onClick={() => {
                                      setConfirmDeleteId(t.id);
                                      setEditingSnapId(null);
                                    }}
                                  >
                                    Delete
                                  </button>
                                </div>
                              )}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
