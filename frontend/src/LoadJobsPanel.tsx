import { useCallback, useEffect, useState } from "preact/hooks";

interface LoadJobsPanelProps {
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
}

interface CredentialRow {
  id: string;
  name: string;
  type: string;
}

interface StorageBackendRow {
  id: string;
  name: string;
  type: string;
}

interface LoadJob {
  id: string;
  name: string;
  credential_id: string;
  storage_backend_id: string;
  table_name: string;
  table_path: string;
  http_path: string;
  http_method: string;
  format: string;
  cron_schedule: string;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  enabled: number;
  date_range_config: string | null;
  pagination_config: string | null;
}

function formatTs(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export function LoadJobsPanel({ workerBase, getAuthHeaders }: LoadJobsPanelProps) {
  const [jobs, setJobs] = useState<LoadJob[]>([]);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [backends, setBackends] = useState<StorageBackendRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState<Record<string, boolean>>({});
  const [triggerResults, setTriggerResults] = useState<Record<string, string>>({});
  const [formMode, setFormMode] = useState<null | "create" | LoadJob>(null);

  // Core form state
  const [formName, setFormName] = useState("");
  const [formCredId, setFormCredId] = useState("");
  const [formSbId, setFormSbId] = useState("");
  const [formTable, setFormTable] = useState("");
  const [formTablePath, setFormTablePath] = useState("");
  const [formPath, setFormPath] = useState("/");
  const [formMethod, setFormMethod] = useState("GET");
  const [formFormat, setFormFormat] = useState("ndjson");
  const [formCron, setFormCron] = useState("0 * * * *");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Date range config state
  const [formDrEnabled, setFormDrEnabled] = useState(false);
  const [formDrParamFrom, setFormDrParamFrom] = useState("start");
  const [formDrParamTo, setFormDrParamTo] = useState("end");
  const [formDrFormat, setFormDrFormat] = useState("iso_date");
  const [formDrLookbackDays, setFormDrLookbackDays] = useState("7");

  // Pagination config state
  const [formPagEnabled, setFormPagEnabled] = useState(false);
  const [formPagCursorParam, setFormPagCursorParam] = useState("cursor");
  const [formPagCursorPath, setFormPagCursorPath] = useState("cursor.next");
  const [formPagDataPath, setFormPagDataPath] = useState("");

  function openCreate() {
    setFormMode("create");
    setFormName("");
    setFormCredId("");
    setFormSbId("");
    setFormTable("");
    setFormTablePath("");
    setFormPath("/");
    setFormMethod("GET");
    setFormFormat("ndjson");
    setFormCron("0 * * * *");
    setFormError(null);
    setFormDrEnabled(false);
    setFormDrParamFrom("start");
    setFormDrParamTo("end");
    setFormDrFormat("iso_date");
    setFormDrLookbackDays("7");
    setFormPagEnabled(false);
    setFormPagCursorParam("cursor");
    setFormPagCursorPath("cursor.next");
    setFormPagDataPath("");
  }

  function openEdit(job: LoadJob) {
    setFormMode(job);
    setFormName(job.name);
    setFormCredId(job.credential_id);
    setFormSbId(job.storage_backend_id);
    setFormTable(job.table_name);
    setFormTablePath(job.table_path);
    setFormPath(job.http_path);
    setFormMethod(job.http_method);
    setFormFormat(job.format);
    setFormCron(job.cron_schedule);
    setFormError(null);

    const dr = job.date_range_config
      ? (JSON.parse(job.date_range_config) as {
          param_from: string;
          param_to: string;
          format: string;
          lookback_days: number;
        })
      : null;
    setFormDrEnabled(dr !== null);
    setFormDrParamFrom(dr?.param_from ?? "start");
    setFormDrParamTo(dr?.param_to ?? "end");
    setFormDrFormat(dr?.format ?? "iso_date");
    setFormDrLookbackDays(String(dr?.lookback_days ?? 7));

    const pag = job.pagination_config
      ? (JSON.parse(job.pagination_config) as {
          cursor_param: string;
          cursor_path: string;
          data_path?: string;
        })
      : null;
    setFormPagEnabled(pag !== null);
    setFormPagCursorParam(pag?.cursor_param ?? "cursor");
    setFormPagCursorPath(pag?.cursor_path ?? "cursor.next");
    setFormPagDataPath(pag?.data_path ?? "");
  }

  const fetchAll = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const [jobsRes, credRes, backendRes] = await Promise.all([
        fetch(`${workerBase}/api/load-jobs`, { headers }),
        fetch(`${workerBase}/api/credentials`, { headers }),
        fetch(`${workerBase}/api/storage-backends`, { headers }),
      ]);
      if (!jobsRes.ok) throw new Error("Failed to load jobs");
      const jobsData = (await jobsRes.json()) as { jobs: LoadJob[] };
      setJobs(jobsData.jobs);
      if (credRes.ok) {
        const cd = (await credRes.json()) as { credentials: CredentialRow[] };
        setCredentials(cd.credentials.filter((c) => c.type === "http"));
      }
      if (backendRes.ok) {
        const bd = (await backendRes.json()) as { backends: StorageBackendRow[] };
        setBackends(bd.backends.filter((b) => b.type === "r2-bound" || b.type === "r2-s3compat"));
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Load failed");
    }
  }, [workerBase, getAuthHeaders]);

  useEffect(() => {
    fetchAll().catch(() => {});
  }, [fetchAll]);

  async function triggerJob(jobId: string) {
    setTriggering((t: Record<string, boolean>) => ({ ...t, [jobId]: true }));
    setTriggerResults((r: Record<string, string>) => ({ ...r, [jobId]: "" }));
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/load-jobs/${jobId}/trigger`, {
        method: "POST",
        headers,
      });
      if (res.ok) {
        setTriggerResults((r: Record<string, string>) => ({ ...r, [jobId]: "Queued" }));
      } else {
        setTriggerResults((r: Record<string, string>) => ({
          ...r,
          [jobId]: `Error ${res.status}`,
        }));
      }
    } catch {
      setTriggerResults((r: Record<string, string>) => ({ ...r, [jobId]: "Request failed" }));
    } finally {
      setTriggering((t: Record<string, boolean>) => ({ ...t, [jobId]: false }));
    }
  }

  async function deleteJob(jobId: string) {
    const headers = await getAuthHeaders();
    const res = await fetch(`${workerBase}/api/load-jobs/${jobId}`, {
      method: "DELETE",
      headers,
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    await fetchAll();
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    const isEdit = formMode !== null && formMode !== "create";
    const url = isEdit
      ? `${workerBase}/api/load-jobs/${(formMode as LoadJob).id}`
      : `${workerBase}/api/load-jobs`;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          name: formName,
          credential_id: formCredId,
          storage_backend_id: formSbId,
          table_name: formTable,
          table_path: formTablePath || undefined,
          http_path: formPath,
          http_method: formMethod,
          format: formFormat,
          cron_schedule: formCron,
          date_range_config: formDrEnabled
            ? {
                param_from: formDrParamFrom,
                param_to: formDrParamTo,
                format: formDrFormat,
                lookback_days: Number(formDrLookbackDays),
              }
            : null,
          pagination_config: formPagEnabled
            ? {
                type: "cursor",
                cursor_param: formPagCursorParam,
                cursor_path: formPagCursorPath,
                ...(formPagDataPath ? { data_path: formPagDataPath } : {}),
              }
            : null,
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `Failed: ${res.status}`);
      }
      setFormMode(null);
      await fetchAll();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="max-w-5xl mx-auto p-6 space-y-4">
      {loadError && (
        <div role="alert" class="alert alert-error">
          <span>{loadError}</span>
        </div>
      )}

      <div class="card bg-base-200">
        <div class="card-body gap-4">
          <div class="flex items-center justify-between">
            <h2 class="card-title">Load Jobs</h2>
            <button
              type="button"
              class="btn btn-sm btn-primary"
              onClick={() => (formMode !== null ? setFormMode(null) : openCreate())}
            >
              {formMode !== null ? "Cancel" : "New job"}
            </button>
          </div>

          {formMode !== null && (
            <form
              class="space-y-3 border border-base-300 rounded-box p-4"
              onSubmit={(e) => handleSubmit(e).catch(() => {})}
            >
              <h3 class="font-semibold text-sm">
                {formMode === "create" ? "New Load Job" : "Edit Load Job"}
              </h3>
              {formError && (
                <div role="alert" class="alert alert-error py-2 text-sm">
                  <span>{formError}</span>
                </div>
              )}
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Name</legend>
                  <input
                    type="text"
                    required
                    class="input input-bordered input-sm w-full"
                    value={formName}
                    onInput={(e) => setFormName((e.target as HTMLInputElement).value)}
                  />
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Table name</legend>
                  <input
                    type="text"
                    required
                    pattern="[a-zA-Z_][a-zA-Z0-9_]*"
                    class="input input-bordered input-sm w-full font-mono"
                    value={formTable}
                    onInput={(e) => setFormTable((e.target as HTMLInputElement).value)}
                  />
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">
                    Storage path <span class="text-base-content/40 font-normal">(optional)</span>
                  </legend>
                  <input
                    type="text"
                    class="input input-bordered input-sm w-full font-mono"
                    value={formTablePath}
                    onInput={(e) => setFormTablePath((e.target as HTMLInputElement).value)}
                    placeholder={formTable || "tables/accounts"}
                  />
                  <p class="text-xs text-base-content/50 mt-1">
                    Directory for files within the storage backend. Defaults to the table name. For
                    r2-bound, this is relative to your user namespace; for r2-s3compat, relative to
                    the bucket root.
                  </p>
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">HTTP Credential</legend>
                  <select
                    required
                    class="select select-bordered select-sm w-full"
                    value={formCredId}
                    onChange={(e) => setFormCredId((e.target as HTMLSelectElement).value)}
                  >
                    <option value="">— select —</option>
                    {credentials.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Storage Backend</legend>
                  <select
                    required
                    class="select select-bordered select-sm w-full"
                    value={formSbId}
                    onChange={(e) => setFormSbId((e.target as HTMLSelectElement).value)}
                  >
                    <option value="">— select —</option>
                    {backends.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.type})
                      </option>
                    ))}
                  </select>
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">HTTP Path</legend>
                  <input
                    type="text"
                    class="input input-bordered input-sm w-full font-mono"
                    value={formPath}
                    onInput={(e) => setFormPath((e.target as HTMLInputElement).value)}
                  />
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Method</legend>
                  <select
                    class="select select-bordered select-sm w-full"
                    value={formMethod}
                    onChange={(e) => setFormMethod((e.target as HTMLSelectElement).value)}
                  >
                    <option>GET</option>
                    <option>POST</option>
                  </select>
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Format</legend>
                  <select
                    class="select select-bordered select-sm w-full"
                    value={formFormat}
                    onChange={(e) => setFormFormat((e.target as HTMLSelectElement).value)}
                  >
                    <option value="ndjson">ndjson</option>
                    <option value="json">json</option>
                    <option value="csv" disabled={formPagEnabled}>
                      csv{formPagEnabled ? " (unavailable with pagination)" : ""}
                    </option>
                    <option value="parquet" disabled={formPagEnabled}>
                      parquet{formPagEnabled ? " (unavailable with pagination)" : ""}
                    </option>
                  </select>
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Cron schedule</legend>
                  <input
                    type="text"
                    class="input input-bordered input-sm w-full font-mono"
                    value={formCron}
                    onInput={(e) => setFormCron((e.target as HTMLInputElement).value)}
                    placeholder="0 * * * *"
                  />
                </fieldset>
              </div>

              {/* Date range config */}
              <div class="border border-base-300 rounded-box p-3 space-y-3">
                <label class="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    checked={formDrEnabled}
                    onChange={(e) =>
                      setFormDrEnabled((e.target as HTMLInputElement).checked)
                    }
                  />
                  <span class="text-sm font-medium">Date range windowing</span>
                </label>
                {formDrEnabled && (
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pl-6">
                    <fieldset class="fieldset">
                      <legend class="fieldset-legend">From param</legend>
                      <input
                        type="text"
                        required
                        class="input input-bordered input-sm w-full font-mono"
                        value={formDrParamFrom}
                        onInput={(e) =>
                          setFormDrParamFrom((e.target as HTMLInputElement).value)
                        }
                        placeholder="start_date"
                      />
                    </fieldset>
                    <fieldset class="fieldset">
                      <legend class="fieldset-legend">To param</legend>
                      <input
                        type="text"
                        required
                        class="input input-bordered input-sm w-full font-mono"
                        value={formDrParamTo}
                        onInput={(e) =>
                          setFormDrParamTo((e.target as HTMLInputElement).value)
                        }
                        placeholder="end_date"
                      />
                    </fieldset>
                    <fieldset class="fieldset">
                      <legend class="fieldset-legend">Date format</legend>
                      <select
                        class="select select-bordered select-sm w-full"
                        value={formDrFormat}
                        onChange={(e) =>
                          setFormDrFormat((e.target as HTMLSelectElement).value)
                        }
                      >
                        <option value="iso">iso (full ISO 8601)</option>
                        <option value="iso_date">iso_date (YYYY-MM-DD)</option>
                        <option value="unix">unix (seconds)</option>
                        <option value="unix_ms">unix_ms (milliseconds)</option>
                      </select>
                    </fieldset>
                    <fieldset class="fieldset">
                      <legend class="fieldset-legend">Lookback days</legend>
                      <input
                        type="number"
                        required
                        min="1"
                        class="input input-bordered input-sm w-full"
                        value={formDrLookbackDays}
                        onInput={(e) =>
                          setFormDrLookbackDays((e.target as HTMLInputElement).value)
                        }
                      />
                    </fieldset>
                  </div>
                )}
              </div>

              {/* Cursor pagination config */}
              <div class="border border-base-300 rounded-box p-3 space-y-3">
                <label class="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    checked={formPagEnabled}
                    onChange={(e) => {
                      const enabled = (e.target as HTMLInputElement).checked;
                      setFormPagEnabled(enabled);
                      if (enabled && formFormat !== "json" && formFormat !== "ndjson") {
                        setFormFormat("ndjson");
                      }
                    }}
                  />
                  <span class="text-sm font-medium">Cursor pagination</span>
                </label>
                {formPagEnabled && (
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pl-6">
                    <fieldset class="fieldset">
                      <legend class="fieldset-legend">Cursor param</legend>
                      <input
                        type="text"
                        required
                        class="input input-bordered input-sm w-full font-mono"
                        value={formPagCursorParam}
                        onInput={(e) =>
                          setFormPagCursorParam((e.target as HTMLInputElement).value)
                        }
                        placeholder="cursor"
                      />
                    </fieldset>
                    <fieldset class="fieldset">
                      <legend class="fieldset-legend">Cursor path</legend>
                      <input
                        type="text"
                        required
                        class="input input-bordered input-sm w-full font-mono"
                        value={formPagCursorPath}
                        onInput={(e) =>
                          setFormPagCursorPath((e.target as HTMLInputElement).value)
                        }
                        placeholder="cursor.next"
                      />
                      <p class="text-xs text-base-content/50 mt-1">
                        Dot-notation path in the response for the next cursor value
                      </p>
                    </fieldset>
                    <fieldset class="fieldset sm:col-span-2">
                      <legend class="fieldset-legend">
                        Data path{" "}
                        <span class="text-base-content/40 font-normal">(optional)</span>
                      </legend>
                      <input
                        type="text"
                        class="input input-bordered input-sm w-full font-mono"
                        value={formPagDataPath}
                        onInput={(e) =>
                          setFormPagDataPath((e.target as HTMLInputElement).value)
                        }
                        placeholder="items"
                      />
                      <p class="text-xs text-base-content/50 mt-1">
                        Dot-notation path to the data array. If omitted, the entire response body
                        is used.
                      </p>
                    </fieldset>
                  </div>
                )}
              </div>

              <button
                type="submit"
                class="btn btn-sm btn-primary"
                disabled={
                  submitting || !formName.trim() || !formCredId || !formSbId || !formTable.trim()
                }
              >
                {submitting && <span class="loading loading-spinner loading-xs" />}
                {submitting
                  ? formMode === "create"
                    ? "Creating…"
                    : "Saving…"
                  : formMode === "create"
                    ? "Create"
                    : "Save"}
              </button>
            </form>
          )}

          {jobs.length === 0 && formMode === null ? (
            <p class="text-sm text-base-content/50">No load jobs yet. Create one to get started.</p>
          ) : jobs.length > 0 ? (
            <div class="overflow-x-auto">
              <table class="table table-sm">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Table</th>
                    <th>Cron</th>
                    <th>Next run</th>
                    <th>Last run</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id}>
                      <td class="font-medium">{job.name}</td>
                      <td class="font-mono text-xs">{job.table_name}</td>
                      <td class="font-mono text-xs">{job.cron_schedule}</td>
                      <td class="text-xs text-base-content/70">{formatTs(job.next_run_at)}</td>
                      <td class="text-xs text-base-content/70">{formatTs(job.last_run_at)}</td>
                      <td>
                        {job.last_error ? (
                          <span class="badge badge-error badge-sm" title={job.last_error}>
                            Error
                          </span>
                        ) : job.last_run_at ? (
                          <span class="badge badge-success badge-sm">OK</span>
                        ) : (
                          <span class="badge badge-ghost badge-sm">Pending</span>
                        )}
                      </td>
                      <td class="flex gap-1 items-center">
                        {triggerResults[job.id] && (
                          <span class="text-xs text-base-content/60">{triggerResults[job.id]}</span>
                        )}
                        <button
                          type="button"
                          class="btn btn-ghost btn-xs"
                          disabled={triggering[job.id]}
                          onClick={() => triggerJob(job.id).catch(() => {})}
                        >
                          {triggering[job.id] ? (
                            <span class="loading loading-spinner loading-xs" />
                          ) : (
                            "Run now"
                          )}
                        </button>
                        <button
                          type="button"
                          class="btn btn-ghost btn-xs"
                          onClick={() => openEdit(job)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          class="btn btn-ghost btn-xs text-error"
                          onClick={() => deleteJob(job.id).catch(() => {})}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
