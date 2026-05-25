import { Fragment } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import type { JobEvent } from "./sessionWs.ts";

interface TransformJobsPanelProps {
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  setJobListener?: (listener: ((ev: JobEvent) => void) | null) => void;
}

interface TransformJob {
  id: string;
  name: string | null;
  sql: string;
  output_table: string;
  output_uri: string;
  output_backend: string;
  format: string | null;
  status: string;
  requires_browser: number;
  created_at: number;
  updated_at: number;
  error: string | null;
}

interface Trigger {
  id: string;
  watches: string;
  job_id: string;
  created_at: number;
}

interface StorageBackend {
  id: string;
  name: string;
  type: string;
}

function formatTs(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "pending":
      return "badge badge-warning badge-sm";
    case "running":
      return "badge badge-info badge-sm";
    case "done":
      return "badge badge-success badge-sm";
    case "failed":
      return "badge badge-error badge-sm";
    default:
      return "badge badge-ghost badge-sm";
  }
}

export function TransformJobsPanel({
  workerBase,
  getAuthHeaders,
  setJobListener,
}: TransformJobsPanelProps) {
  const [jobs, setJobs] = useState<TransformJob[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [backends, setBackends] = useState<StorageBackend[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formMode, setFormMode] = useState<null | "create" | TransformJob>(null);

  // Job form fields
  const [formName, setFormName] = useState("");
  const [formSql, setFormSql] = useState("");
  const [formOutputTable, setFormOutputTable] = useState("");
  const [formOutputUri, setFormOutputUri] = useState("");
  const [formOutputBackend, setFormOutputBackend] = useState("");
  const [formFormat, setFormFormat] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // New trigger form
  const [newTriggerWatch, setNewTriggerWatch] = useState("");
  const [addingTrigger, setAddingTrigger] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoadError(null);
    try {
      const headers = await getAuthHeaders();
      const [jobsRes, triggersRes, backendsRes] = await Promise.all([
        fetch(`${workerBase}/api/transform-jobs`, { headers }),
        fetch(`${workerBase}/api/triggers`, { headers }),
        fetch(`${workerBase}/api/storage-backends`, { headers }),
      ]);
      if (!jobsRes.ok) throw new Error("Failed to load transform jobs");
      const jobsData = (await jobsRes.json()) as { jobs: TransformJob[] };
      setJobs(jobsData.jobs);
      if (triggersRes.ok) {
        const tData = (await triggersRes.json()) as { triggers: Trigger[] };
        setTriggers(tData.triggers);
      }
      if (backendsRes.ok) {
        const bData = (await backendsRes.json()) as { backends: StorageBackend[] };
        setBackends(bData.backends);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Load failed");
    }
  }, [workerBase, getAuthHeaders]);

  useEffect(() => {
    fetchAll().catch(() => {});
  }, [fetchAll]);

  useEffect(() => {
    if (!setJobListener) return;
    setJobListener((ev) => {
      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== ev.jobId) return j;
          const now = Date.now();
          if (ev.status === "running") return { ...j, status: "running", updated_at: now };
          if (ev.status === "done") return { ...j, status: "done", error: null, updated_at: now };
          return { ...j, status: "failed", error: ev.error, updated_at: now };
        }),
      );
    });
    return () => setJobListener(null);
  }, [setJobListener]);

  function openCreate() {
    setFormMode("create");
    setFormName("");
    setFormSql("");
    setFormOutputTable("");
    setFormOutputUri("");
    setFormOutputBackend("");
    setFormFormat("");
    setFormError(null);
    setNewTriggerWatch("");
    setTriggerError(null);
  }

  function openEdit(job: TransformJob) {
    setFormMode(job);
    setFormName(job.name ?? "");
    setFormSql(job.sql);
    setFormOutputTable(job.output_table);
    setFormOutputUri(job.output_uri);
    setFormOutputBackend(job.output_backend);
    setFormFormat(job.format ?? "");
    setFormError(null);
    setNewTriggerWatch("");
    setTriggerError(null);
  }

  function closeForm() {
    setFormMode(null);
    setFormError(null);
    setTriggerError(null);
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    const isEdit = formMode !== null && formMode !== "create";
    const url = isEdit
      ? `${workerBase}/api/transform-jobs/${(formMode as TransformJob).id}`
      : `${workerBase}/api/transform-jobs`;
    try {
      const headers = await getAuthHeaders();
      const body: Record<string, string> = {
        sql: formSql,
        output_table: formOutputTable,
        output_uri: formOutputUri,
        output_backend: formOutputBackend,
      };
      if (formName.trim()) body.name = formName.trim();
      if (formFormat) body.format = formFormat;
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
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

  async function triggerJob(jobId: string) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/transform-jobs/${jobId}/trigger`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `Error ${res.status}`);
      }
      await fetchAll();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Trigger failed");
    }
  }

  async function deleteJob(jobId: string) {
    if (!confirm("Delete this transform job?")) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/transform-jobs/${jobId}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      if (formMode !== null && formMode !== "create" && (formMode as TransformJob).id === jobId) {
        closeForm();
      }
      await fetchAll();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function addTrigger(jobId: string) {
    if (!newTriggerWatch.trim()) return;
    setAddingTrigger(true);
    setTriggerError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/triggers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ watches: newTriggerWatch.trim(), job_id: jobId }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `Failed: ${res.status}`);
      }
      setNewTriggerWatch("");
      await fetchAll();
    } catch (err) {
      setTriggerError(err instanceof Error ? err.message : "Failed to add trigger");
    } finally {
      setAddingTrigger(false);
    }
  }

  async function deleteTrigger(triggerId: string) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/triggers/${triggerId}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      await fetchAll();
    } catch (err) {
      setTriggerError(err instanceof Error ? err.message : "Delete trigger failed");
    }
  }

  const editingJob = formMode !== null && formMode !== "create" ? (formMode as TransformJob) : null;
  const jobTriggers = editingJob ? triggers.filter((t) => t.job_id === editingJob.id) : [];

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
            <h2 class="card-title">Transform Jobs</h2>
            <button
              type="button"
              class="btn btn-sm btn-primary"
              onClick={() => (formMode !== null ? closeForm() : openCreate())}
            >
              {formMode !== null ? "Cancel" : "New Job"}
            </button>
          </div>

          {/* Job table */}
          {jobs.length === 0 && formMode === null ? (
            <p class="text-sm text-base-content/50">
              No transform jobs yet. Create one to get started.
            </p>
          ) : jobs.length > 0 ? (
            <div class="overflow-x-auto">
              <table class="table table-sm">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>SQL</th>
                    <th>Output Table</th>
                    <th>Status</th>
                    <th>Last updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <Fragment key={job.id}>
                      <tr>
                        <td class="font-medium">
                          {job.name ?? <em class="text-base-content/40">unnamed</em>}
                        </td>
                        <td class="font-mono text-xs text-base-content/70 max-w-xs truncate">
                          {job.sql.length > 60 ? `${job.sql.slice(0, 60)}…` : job.sql}
                        </td>
                        <td class="font-mono text-xs">{job.output_table}</td>
                        <td>
                          <span class={statusBadgeClass(job.status)}>{job.status}</span>
                        </td>
                        <td class="text-xs text-base-content/70">{formatTs(job.updated_at)}</td>
                        <td class="flex gap-1 items-center">
                          <button
                            type="button"
                            class="btn btn-ghost btn-xs"
                            disabled={job.status === "running"}
                            onClick={() => triggerJob(job.id).catch(() => {})}
                            title={job.status === "running" ? "Already running" : "Run now"}
                          >
                            Run
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
                      {job.status === "failed" && job.error && (
                        <tr key={`${job.id}-error`}>
                          <td colSpan={6} class="pt-0 pb-2 pl-4">
                            <span class="text-xs text-error">{job.error}</span>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* Create / edit form */}
          {formMode !== null && (
            <form
              class="space-y-3 border border-base-300 rounded-box p-4"
              onSubmit={(e) => handleSubmit(e).catch(() => {})}
            >
              <h3 class="font-semibold text-sm">
                {formMode === "create" ? "New Transform Job" : "Edit Transform Job"}
              </h3>
              {formError && (
                <div role="alert" class="alert alert-error py-2 text-sm">
                  <span>{formError}</span>
                </div>
              )}

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">
                    Name <span class="text-base-content/40 font-normal">(optional)</span>
                  </legend>
                  <input
                    type="text"
                    class="input input-bordered input-sm w-full"
                    value={formName}
                    onInput={(e) => setFormName((e.target as HTMLInputElement).value)}
                    placeholder="My transform"
                  />
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Output Table</legend>
                  <input
                    type="text"
                    required
                    pattern="[a-zA-Z_][a-zA-Z0-9_]*"
                    class="input input-bordered input-sm w-full font-mono"
                    value={formOutputTable}
                    onInput={(e) => setFormOutputTable((e.target as HTMLInputElement).value)}
                    placeholder="transformed_events"
                  />
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Output URI</legend>
                  <input
                    type="text"
                    required
                    class="input input-bordered input-sm w-full font-mono"
                    value={formOutputUri}
                    onInput={(e) => setFormOutputUri((e.target as HTMLInputElement).value)}
                    placeholder="r2://data-shack-storage/transforms/output.parquet"
                  />
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Output Backend</legend>
                  <input
                    required
                    class="input input-bordered input-sm w-full font-mono"
                    list="transform-backend-datalist"
                    value={formOutputBackend}
                    onInput={(e) => setFormOutputBackend((e.target as HTMLInputElement).value)}
                    placeholder="primary-r2 or backend name"
                  />
                  <datalist id="transform-backend-datalist">
                    {backends.map((b) => (
                      <option key={b.id} value={b.name}>
                        {b.name} ({b.type})
                      </option>
                    ))}
                  </datalist>
                </fieldset>
                <fieldset class="fieldset sm:col-span-2">
                  <legend class="fieldset-legend">Format</legend>
                  <select
                    class="select select-bordered select-sm w-full"
                    value={formFormat}
                    onChange={(e) => setFormFormat((e.target as HTMLSelectElement).value)}
                  >
                    <option value="">auto — infer from URI extension</option>
                    <option value="parquet">parquet</option>
                    <option value="json">json</option>
                    <option value="ndjson">ndjson</option>
                    <option value="csv">csv</option>
                  </select>
                </fieldset>
              </div>

              <fieldset class="fieldset">
                <legend class="fieldset-legend">SQL</legend>
                <textarea
                  required
                  class="textarea textarea-bordered w-full font-mono text-xs"
                  rows={6}
                  value={formSql}
                  onInput={(e) => setFormSql((e.target as HTMLTextAreaElement).value)}
                  placeholder="SELECT * FROM source_table WHERE ..."
                />
              </fieldset>

              <div class="flex gap-2">
                <button
                  type="submit"
                  class="btn btn-sm btn-primary"
                  disabled={
                    submitting ||
                    !formSql.trim() ||
                    !formOutputTable.trim() ||
                    !formOutputUri.trim() ||
                    !formOutputBackend.trim()
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
                <button type="button" class="btn btn-sm btn-ghost" onClick={closeForm}>
                  Cancel
                </button>
              </div>

              {/* Triggers section — shown when editing an existing job */}
              {editingJob && (
                <div class="border border-base-300 rounded-box p-3 space-y-3 mt-2">
                  <h4 class="font-semibold text-sm">Triggers</h4>
                  {triggerError && (
                    <div role="alert" class="alert alert-error py-2 text-sm">
                      <span>{triggerError}</span>
                    </div>
                  )}
                  {jobTriggers.length === 0 ? (
                    <p class="text-xs text-base-content/50">No triggers for this job.</p>
                  ) : (
                    <div class="space-y-1">
                      {jobTriggers.map((t) => (
                        <div key={t.id} class="flex items-center justify-between gap-2">
                          <span class="font-mono text-xs">
                            watches: <strong>{t.watches}</strong>
                          </span>
                          <button
                            type="button"
                            class="btn btn-ghost btn-xs text-error"
                            onClick={() => deleteTrigger(t.id).catch(() => {})}
                          >
                            Delete
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div class="flex gap-2 items-end">
                    <fieldset class="fieldset flex-1">
                      <legend class="fieldset-legend">Watch table</legend>
                      <input
                        type="text"
                        class="input input-bordered input-sm w-full font-mono"
                        value={newTriggerWatch}
                        onInput={(e) => setNewTriggerWatch((e.target as HTMLInputElement).value)}
                        placeholder="source_table"
                      />
                    </fieldset>
                    <button
                      type="button"
                      class="btn btn-sm btn-outline mb-0.5"
                      disabled={addingTrigger || !newTriggerWatch.trim()}
                      onClick={() => addTrigger(editingJob.id).catch(() => {})}
                    >
                      {addingTrigger && <span class="loading loading-spinner loading-xs" />}
                      Add
                    </button>
                  </div>
                </div>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
