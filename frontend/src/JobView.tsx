import { useEffect, useState } from "preact/hooks";
import { WORKER_BASE, authHeaders, fmtAgo } from "./wb-api.ts";
import { JobIcon, SaveIcon, SettingsIcon } from "./wbIcons.tsx";
import type { WbCtx, WbTab } from "./workbench-types.ts";

interface LoadJobFull {
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
  source_type: string;
  source_config: string | null;
}

interface JvLookup {
  id: string;
  name: string;
  type: string;
}

export function JobView({ tab }: { tab: WbTab; ctx: WbCtx }) {
  const initial = tab.item as { id?: string } | null;
  const jobId = initial?.id ?? null;
  const isNew = !jobId;

  const [job, setJob] = useState<LoadJobFull | null>(null);
  const [credentials, setCredentials] = useState<JvLookup[]>([]);
  const [backends, setBackends] = useState<JvLookup[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "create">(isNew ? "create" : "view");
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  // Form fields
  const [fName, setFName] = useState("");
  const [fCredId, setFCredId] = useState("");
  const [fSbId, setFSbId] = useState("");
  const [fTable, setFTable] = useState("");
  const [fTablePath, setFTablePath] = useState("");
  const [fSrcType, setFSrcType] = useState<"http" | "google-sheets">("http");
  const [fPath, setFPath] = useState("/");
  const [fMethod, setFMethod] = useState("GET");
  const [fSpreadsheetId, setFSpreadsheetId] = useState("");
  const [fSheetName, setFSheetName] = useState("");
  const [fRange, setFRange] = useState("");
  const [fFormat, setFFormat] = useState("ndjson");
  const [fCron, setFCron] = useState("0 * * * *");

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const headers = await authHeaders();
        const [credRes, sbRes] = await Promise.all([
          fetch(`${WORKER_BASE}/api/credentials`, { headers }),
          fetch(`${WORKER_BASE}/api/storage-backends`, { headers }),
        ]);
        if (credRes.ok) {
          const d = (await credRes.json()) as { credentials: JvLookup[] };
          setCredentials(
            d.credentials.filter((c) => c.type === "http" || c.type === "google-sheets"),
          );
        }
        if (sbRes.ok) {
          const d = (await sbRes.json()) as { backends: JvLookup[] };
          setBackends(d.backends);
        }
        if (jobId) {
          const jobsRes = await fetch(`${WORKER_BASE}/api/load-jobs`, { headers });
          if (jobsRes.ok) {
            const d = (await jobsRes.json()) as { jobs: LoadJobFull[] };
            const found = d.jobs.find((j) => j.id === jobId);
            if (found) setJob(found);
          }
        }
      } catch (err) {
        setLoadErr(err instanceof Error ? err.message : "Load failed");
      } finally {
        setLoading(false);
      }
    };
    load().catch(() => {});
  }, [jobId]);

  function populateForm(j: LoadJobFull) {
    setFName(j.name ?? "");
    setFCredId(j.credential_id ?? "");
    setFSbId(j.storage_backend_id ?? "");
    setFTable(j.table_name ?? "");
    setFTablePath(j.table_path ?? "");
    setFFormat(j.format ?? "ndjson");
    setFCron(j.cron_schedule ?? "0 * * * *");
    const srcType = (j.source_type ?? "http") as "http" | "google-sheets";
    setFSrcType(srcType);
    if (srcType === "http") {
      setFPath(j.http_path ?? "/");
      setFMethod(j.http_method ?? "GET");
    } else if (j.source_config) {
      try {
        const sc = JSON.parse(j.source_config) as {
          spreadsheetId?: string;
          sheetName?: string;
          range?: string;
        };
        setFSpreadsheetId(sc.spreadsheetId ?? "");
        setFSheetName(sc.sheetName ?? "");
        setFRange(sc.range ?? "");
      } catch {
        /* keep defaults */
      }
    }
  }

  async function runNow() {
    if (!job) return;
    setRunning(true);
    setRunMsg(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${WORKER_BASE}/api/load-jobs/${job.id}/trigger`, {
        method: "POST",
        headers,
      });
      setRunMsg(res.ok ? "Queued — check console for progress." : `Error ${res.status}`);
    } catch {
      setRunMsg("Request failed");
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    setSaving(true);
    setSaveErr(null);
    try {
      const headers = { ...(await authHeaders()), "Content-Type": "application/json" };
      const isEdit = mode === "edit" && job !== null;
      const url = isEdit
        ? `${WORKER_BASE}/api/load-jobs/${job.id}`
        : `${WORKER_BASE}/api/load-jobs`;
      const body: Record<string, unknown> = {
        name: fName,
        credential_id: fCredId,
        storage_backend_id: fSbId,
        table_name: fTable,
        ...(fTablePath ? { table_path: fTablePath } : {}),
        format: fFormat,
        cron_schedule: fCron,
        source_type: fSrcType,
        ...(fSrcType === "google-sheets"
          ? {
              source_config: {
                spreadsheetId: fSpreadsheetId,
                ...(fSheetName ? { sheetName: fSheetName } : {}),
                ...(fRange ? { range: fRange } : {}),
              },
            }
          : { http_path: fPath, http_method: fMethod }),
      };
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? `Failed: ${res.status}`);
      }
      // Re-fetch updated job list to get fresh data
      const refreshRes = await fetch(`${WORKER_BASE}/api/load-jobs`, {
        headers: await authHeaders(),
      });
      if (refreshRes.ok) {
        const d = (await refreshRes.json()) as { jobs: LoadJobFull[] };
        const updated = d.jobs.find((j) => j.id === (job?.id ?? "")) ?? d.jobs[d.jobs.length - 1];
        if (updated) setJob(updated);
      }
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
      if (isEdit) setMode("view");
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  // Resolved display values
  const credName =
    credentials.find((c) => c.id === job?.credential_id)?.name ?? job?.credential_id ?? "—";
  const backendName =
    backends.find((b) => b.id === job?.storage_backend_id)?.name ?? job?.storage_backend_id ?? "—";
  let sourcePath = "—";
  if (job?.source_type === "google-sheets" && job.source_config) {
    try {
      const sc = JSON.parse(job.source_config) as { spreadsheetId?: string; sheetName?: string };
      sourcePath = sc.spreadsheetId ?? "—";
      if (sc.sheetName) sourcePath += ` / ${sc.sheetName}`;
    } catch {
      /* sourcePath stays "—" */
    }
  } else if (job?.http_path) {
    sourcePath = job.http_path;
  }
  const sourceSub = job
    ? `${credName}${job.source_type === "http" ? job.http_path : ""} → ${job.table_name}`
    : "Cron-triggered HTTP / Google Sheets → storage ETL.";

  const configRows: [string, string][] = job
    ? [
        ["Output table", job.table_name],
        ["Credential", credName],
        ["Source", sourcePath],
        ["Backend", backendName],
        ["Format", job.format],
        ["Schedule (cron)", job.cron_schedule],
      ]
    : [];

  const dimStyle = { color: "color-mix(in oklch, var(--color-base-content) 55%, transparent)" };

  const formSection = (
    <div class="wb-form-grid">
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Name</legend>
        <input
          type="text"
          required
          class="input input-sm w-full"
          value={fName}
          onInput={(e) => setFName((e.target as HTMLInputElement).value)}
        />
      </fieldset>
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Source type</legend>
        <select
          class="select select-sm w-full"
          value={fSrcType}
          onChange={(e) => {
            setFSrcType((e.target as HTMLSelectElement).value as "http" | "google-sheets");
            setFCredId("");
          }}
        >
          <option value="http">HTTP</option>
          <option value="google-sheets">Google Sheets</option>
        </select>
      </fieldset>
      <fieldset class="fieldset">
        <legend class="fieldset-legend">
          {fSrcType === "google-sheets" ? "Google Sheets credential" : "HTTP credential"}
        </legend>
        <select
          required
          class="select select-sm w-full"
          value={fCredId}
          onChange={(e) => setFCredId((e.target as HTMLSelectElement).value)}
        >
          <option value="">— select —</option>
          {credentials
            .filter((c) => c.type === fSrcType)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </fieldset>
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Storage backend</legend>
        <select
          required
          class="select select-sm w-full"
          value={fSbId}
          onChange={(e) => setFSbId((e.target as HTMLSelectElement).value)}
        >
          <option value="">— select —</option>
          {backends.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.type})
            </option>
          ))}
        </select>
      </fieldset>
      {fSrcType === "http" ? (
        <>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Source path</legend>
            <input
              type="text"
              required
              class="input input-sm font-mono w-full"
              value={fPath}
              onInput={(e) => setFPath((e.target as HTMLInputElement).value)}
              placeholder="/api/records"
            />
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Method</legend>
            <select
              class="select select-sm w-full"
              value={fMethod}
              onChange={(e) => setFMethod((e.target as HTMLSelectElement).value)}
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
          </fieldset>
        </>
      ) : (
        <>
          <fieldset class="fieldset" style={{ gridColumn: "1 / -1" }}>
            <legend class="fieldset-legend">Spreadsheet ID</legend>
            <input
              type="text"
              required
              class="input input-sm font-mono w-full"
              value={fSpreadsheetId}
              onInput={(e) => setFSpreadsheetId((e.target as HTMLInputElement).value)}
              placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
            />
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">
              Sheet name <span style={dimStyle}>(optional)</span>
            </legend>
            <input
              type="text"
              class="input input-sm font-mono w-full"
              value={fSheetName}
              onInput={(e) => setFSheetName((e.target as HTMLInputElement).value)}
              placeholder="Sheet1"
            />
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">
              Range <span style={dimStyle}>(optional)</span>
            </legend>
            <input
              type="text"
              class="input input-sm font-mono w-full"
              value={fRange}
              onInput={(e) => setFRange((e.target as HTMLInputElement).value)}
              placeholder="A1:Z"
            />
          </fieldset>
        </>
      )}
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Output table</legend>
        <input
          type="text"
          required
          pattern="[a-zA-Z_][a-zA-Z0-9_]*"
          class="input input-sm font-mono w-full"
          value={fTable}
          onInput={(e) => setFTable((e.target as HTMLInputElement).value)}
          placeholder="my_table"
        />
      </fieldset>
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Format</legend>
        <select
          class="select select-sm w-full"
          value={fFormat}
          onChange={(e) => setFFormat((e.target as HTMLSelectElement).value)}
        >
          <option value="ndjson">ndjson</option>
          <option value="json">json</option>
          <option value="parquet">parquet</option>
          <option value="csv">csv</option>
        </select>
      </fieldset>
      <fieldset class="fieldset" style={{ gridColumn: "1 / -1" }}>
        <legend class="fieldset-legend">Cron schedule</legend>
        <input
          type="text"
          required
          class="input input-sm font-mono w-full"
          value={fCron}
          onInput={(e) => setFCron((e.target as HTMLInputElement).value)}
          placeholder="0 * * * *"
        />
      </fieldset>
    </div>
  );

  if (loading)
    return (
      <div class="wb-doc">
        <div class="wb-doc-head">
          <div class="wb-doc-titlewrap">
            <span class="wb-doc-kicker">
              <JobIcon size={12} />
              Load job
            </span>
            <h1 class="wb-doc-title" style={{ opacity: 0.4 }}>
              Loading…
            </h1>
          </div>
        </div>
      </div>
    );

  if (loadErr)
    return (
      <div class="wb-doc">
        <div class="alert alert-error">
          <span>{loadErr}</span>
        </div>
      </div>
    );

  return (
    <div class="wb-doc">
      {/* Doc head */}
      <div class="wb-doc-head">
        <div class="wb-doc-titlewrap">
          <span class="wb-doc-kicker">
            <JobIcon size={12} />
            Load job
          </span>
          <h1 class="wb-doc-title">{isNew ? "New load job" : (job?.table_name ?? tab.title)}</h1>
          <p class="wb-doc-sub">{sourceSub}</p>
        </div>
        <div class="wb-doc-actions">
          {mode === "create" && (
            <button type="button" class="btn btn-primary btn-sm" onClick={save} disabled={saving}>
              {saving ? <span class="loading loading-xs" /> : <SaveIcon size={13} />}
              Create
            </button>
          )}
          {mode === "view" && (
            <>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                onClick={() => {
                  if (job) populateForm(job);
                  setMode("edit");
                }}
              >
                <SettingsIcon size={13} />
                Edit
              </button>
              <button
                type="button"
                class="btn btn-outline btn-sm"
                onClick={() => runNow().catch(() => {})}
                disabled={running}
              >
                {running && <span class="loading loading-xs" />}
                {running ? "Running…" : "Run now"}
              </button>
            </>
          )}
          {mode === "edit" && (
            <>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => setMode("view")}>
                Cancel
              </button>
              <button type="button" class="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                {saving ? <span class="loading loading-xs" /> : <SaveIcon size={13} />}
                Save
              </button>
            </>
          )}
        </div>
      </div>

      {/* Alerts */}
      {mode === "view" && job?.last_error && (
        <div class="alert alert-error">
          <span>
            Last run failed: <code class="font-mono text-sm">{job.last_error}</code>
          </span>
        </div>
      )}
      {runMsg && (
        <div class={`alert ${runMsg.startsWith("Queued") ? "alert-success" : "alert-error"}`}>
          <span>{runMsg}</span>
        </div>
      )}
      {saveErr && (
        <div class="alert alert-error">
          <span>{saveErr}</span>
        </div>
      )}
      {saveOk && (
        <div class="alert alert-success">
          <span>{mode === "create" ? "Load job created." : "Saved."}</span>
        </div>
      )}

      {/* View: config table */}
      {mode === "view" && job && (
        <div class="wb-panel">
          <table class="table table-sm">
            <tbody>
              {configRows.map(([k, v]) => (
                <tr key={k}>
                  <td style={{ width: 180, ...dimStyle }}>{k}</td>
                  <td class="font-mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* View: recent runs */}
      {mode === "view" && job?.last_run_at && (
        <div class="wb-section">
          <div class="wb-section-title">Recent runs</div>
          <div class="wb-panel">
            <table class="table table-sm">
              <tbody>
                <tr>
                  <td style={{ width: 30 }}>
                    <span
                      class={`wb-dot wb-dot-${job.last_error ? "idle" : "success"}`}
                      style={{ display: "inline-block" }}
                    />
                  </td>
                  <td class="font-mono">
                    {job.last_error ? `failed — ${job.last_error}` : "committed snapshot"}
                  </td>
                  <td class="font-mono" style={{ textAlign: "right", ...dimStyle }}>
                    {fmtAgo(job.last_run_at)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create / edit: form */}
      {(mode === "create" || mode === "edit") && formSection}
    </div>
  );
}
