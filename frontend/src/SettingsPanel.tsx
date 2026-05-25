import { useCallback, useEffect, useState } from "preact/hooks";

interface SettingsPanelProps {
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
}

interface CredentialRow {
  id: string;
  name: string;
  type: string;
  created_at: number;
}

interface StorageBackendRow {
  id: string;
  name: string;
  type: string;
  created_at: number;
}

const CREDENTIAL_TYPES = ["http", "google-sheets", "google_oauth", "generic_token"];
const BACKEND_TYPES = ["r2-bound", "s3", "r2-s3compat", "google-sheets", "gcs", "azure", "https"];

const HTTP_CONFIG_TEMPLATE = JSON.stringify(
  {
    baseUrl: "https://api.example.com",
    headers: {
      Authorization: "Bearer {{apiKey}}",
      "X-App-Id": "{{appId}}",
    },
    variables: {
      apiKey: "your-token-here",
      appId: "your-app-id-here",
    },
  },
  null,
  2,
);

const R2_BOUND_CONFIG_TEMPLATE = JSON.stringify(
  {
    bucket: "data-shack-storage",
  },
  null,
  2,
);

const R2_S3COMPAT_CONFIG_TEMPLATE = JSON.stringify(
  {
    endpoint: "https://<accountId>.r2.cloudflarestorage.com",
    accessKeyId: "your-access-key-id",
    secretAccessKey: "your-secret-access-key",
    bucket: "your-bucket-name",
    region: "auto",
  },
  null,
  2,
);

// ── GoogleSheetsTestDialog ────────────────────────────────────────────────

function GoogleSheetsTestDialog({
  credentialId,
  credentialName,
  workerBase,
  getAuthHeaders,
  onClose,
}: {
  credentialId: string;
  credentialName: string;
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  onClose: () => void;
}) {
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);

  useEffect(() => {
    (async () => {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/credentials/${credentialId}/test`, {
        method: "POST",
        headers,
      });
      setResult((await res.json()) as { ok: boolean; error?: string });
    })().catch((err) => setResult({ ok: false, error: String(err) }));
  }, [credentialId, workerBase, getAuthHeaders]);

  return (
    <div
      class="modal modal-open"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div class="modal-box space-y-4">
        <h3 class="font-bold text-lg">Test: {credentialName}</h3>
        {!result ? (
          <div class="flex gap-2 items-center">
            <span class="loading loading-spinner loading-sm" />
            <span class="text-sm">Testing connection…</span>
          </div>
        ) : result.ok ? (
          <div role="alert" class="alert alert-success py-2 text-sm">
            <span>Token refresh successful — credential is working.</span>
          </div>
        ) : (
          <div role="alert" class="alert alert-error py-2 text-sm">
            <span>{result.error ?? "Connection test failed."}</span>
          </div>
        )}
        <div class="modal-action">
          <button type="button" class="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <button type="button" class="modal-backdrop" onClick={onClose} aria-label="Close dialog" />
    </div>
  );
}

// ── TestDialog ────────────────────────────────────────────────────────────

function TestDialog({
  credentialId,
  credentialName,
  workerBase,
  getAuthHeaders,
  onClose,
}: {
  credentialId: string;
  credentialName: string;
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  onClose: () => void;
}) {
  const [path, setPath] = useState("/");
  const [fetching, setFetching] = useState(false);
  const [result, setResult] = useState<{ status: number; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFetch() {
    setFetching(true);
    setError(null);
    setResult(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/data-sources/${credentialId}/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ path }),
      });
      const text = await res.text();
      setResult({ status: res.status, body: text.slice(0, 4000) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setFetching(false);
    }
  }

  return (
    <div
      class="modal modal-open"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div class="modal-box max-w-2xl space-y-4">
        <h3 class="font-bold text-lg">Test: {credentialName}</h3>

        <div class="flex gap-2 items-end">
          <fieldset class="fieldset flex-1">
            <legend class="fieldset-legend">Path</legend>
            <input
              type="text"
              class="input input-bordered input-sm w-full font-mono"
              value={path}
              onInput={(e) => setPath((e.target as HTMLInputElement).value)}
              placeholder="/accounts"
            />
          </fieldset>
          <button
            type="button"
            class="btn btn-sm btn-outline mb-[1px]"
            onClick={() => handleFetch().catch(() => {})}
            disabled={fetching}
          >
            {fetching && <span class="loading loading-spinner loading-xs" />}
            {fetching ? "Fetching…" : "Fetch"}
          </button>
        </div>

        {error && (
          <div role="alert" class="alert alert-error py-2 text-sm">
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div class="space-y-1">
            <p class="text-xs text-base-content/50">
              Status:{" "}
              <span class={result.status < 300 ? "text-success" : "text-error"}>
                {result.status}
              </span>
            </p>
            <pre class="bg-base-300 rounded p-3 text-xs overflow-auto max-h-80 whitespace-pre-wrap break-all">
              {result.body}
            </pre>
          </div>
        )}

        <div class="modal-action">
          <button type="button" class="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <button type="button" class="modal-backdrop" onClick={onClose} aria-label="Close dialog" />
    </div>
  );
}

// ── AddForm ───────────────────────────────────────────────────────────────

function AddForm({
  title,
  typeOptions,
  onAdd,
}: {
  title: string;
  typeOptions: string[];
  onAdd: (name: string, type: string, config: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState(typeOptions[0] ?? "");
  const initialConfig =
    typeOptions[0] === "http"
      ? HTTP_CONFIG_TEMPLATE
      : typeOptions[0] === "r2-bound"
        ? R2_BOUND_CONFIG_TEMPLATE
        : typeOptions[0] === "r2-s3compat"
          ? R2_S3COMPAT_CONFIG_TEMPLATE
          : "{}";
  const [config, setConfig] = useState(initialConfig);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleTypeChange(newType: string) {
    setType(newType);
    if (newType === "http") {
      setConfig(HTTP_CONFIG_TEMPLATE);
    } else if (newType === "r2-bound") {
      setConfig(R2_BOUND_CONFIG_TEMPLATE);
    } else if (newType === "r2-s3compat") {
      setConfig(R2_S3COMPAT_CONFIG_TEMPLATE);
    } else if (
      config === HTTP_CONFIG_TEMPLATE ||
      config === R2_BOUND_CONFIG_TEMPLATE ||
      config === R2_S3COMPAT_CONFIG_TEMPLATE
    ) {
      setConfig("{}");
    }
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onAdd(name, type, config);
      setName("");
      setConfig(
        type === "http"
          ? HTTP_CONFIG_TEMPLATE
          : type === "r2-bound"
            ? R2_BOUND_CONFIG_TEMPLATE
            : type === "r2-s3compat"
              ? R2_S3COMPAT_CONFIG_TEMPLATE
              : "{}",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form class="space-y-3" onSubmit={(e) => handleSubmit(e).catch(() => {})}>
      <h3 class="font-semibold text-sm">{title}</h3>
      {error && (
        <div role="alert" class="alert alert-error py-2 text-sm">
          <span>{error}</span>
        </div>
      )}
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Name</legend>
          <input
            type="text"
            required
            pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*"
            maxLength={64}
            class="input input-bordered input-sm w-full"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            title="Must start with a letter or digit; only letters, digits, '.', '_', '-' allowed"
          />
          <span class="fieldset-label text-base-content/50">
            Letters, digits, <code>.</code> <code>_</code> <code>-</code> only — used in{" "}
            <code>http-ds://name/…</code> URIs
          </span>
        </fieldset>
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Type</legend>
          <select
            class="select select-bordered select-sm w-full"
            value={type}
            onChange={(e) => handleTypeChange((e.target as HTMLSelectElement).value)}
          >
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </fieldset>
      </div>
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Config (JSON)</legend>
        <textarea
          class="textarea textarea-bordered textarea-sm font-mono w-full"
          rows={type === "http" || type === "r2-s3compat" ? 8 : 3}
          value={config}
          onInput={(e) => setConfig((e.target as HTMLTextAreaElement).value)}
        />
        {type === "http" && (
          <p class="text-xs text-base-content/50 mt-1">
            <strong>baseUrl</strong> — API root (e.g. <code>https://api.akahu.io/v1</code>).{" "}
            <strong>headers</strong> — sent on every request; use <code>{"{{name}}"}</code> to
            reference a value from <strong>variables</strong> (keeps secrets out of the header
            string).
          </p>
        )}
        {type === "r2-bound" && (
          <p class="text-xs text-base-content/50 mt-1">
            The primary Cloudflare R2 bucket bound to this worker. <strong>bucket</strong> — set to{" "}
            <code>data-shack-storage</code> (used for URI construction in the catalog). Load jobs
            writing to this backend use the Worker's R2 binding directly.
          </p>
        )}
        {type === "r2-s3compat" && (
          <p class="text-xs text-base-content/50 mt-1">
            <strong>endpoint</strong> — your R2 S3-compatible URL:{" "}
            <code>https://{"<accountId>"}.r2.cloudflarestorage.com</code> (Account ID is on the R2
            overview page). <strong>accessKeyId</strong> and <strong>secretAccessKey</strong> —
            create an API token under <em>R2 → Manage R2 API tokens</em>. Once saved, query files as{" "}
            <code>
              r2-s3compat://{"<backendId>"}/{"<path>"}
            </code>{" "}
            in SQL.
          </p>
        )}
      </fieldset>
      <button type="submit" class="btn btn-sm btn-primary" disabled={submitting || !name.trim()}>
        {submitting && <span class="loading loading-spinner loading-xs" />}
        {submitting ? "Adding…" : "Add"}
      </button>
    </form>
  );
}

// ── EditBackendDialog ─────────────────────────────────────────────────────

function EditBackendDialog({
  backend,
  workerBase,
  getAuthHeaders,
  onSaved,
  onClose,
}: {
  backend: StorageBackendRow;
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(backend.name);
  const [config, setConfig] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${workerBase}/api/storage-backends/${backend.id}`, { headers });
        if (!res.ok) throw new Error(`Failed to load config: ${res.status}`);
        const data = (await res.json()) as { config: unknown };
        setConfig(JSON.stringify(data.config, null, 2));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, [backend.id, workerBase, getAuthHeaders]);

  async function handleSave(e: Event) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      let parsedConfig: unknown;
      try {
        parsedConfig = JSON.parse(config ?? "{}");
      } catch {
        throw new Error("Config must be valid JSON");
      }
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/storage-backends/${backend.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ name, config: parsedConfig }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `Save failed: ${res.status}`);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      class="modal modal-open"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div class="modal-box max-w-2xl space-y-4">
        <h3 class="font-bold text-lg">Edit: {backend.name}</h3>

        {error && (
          <div role="alert" class="alert alert-error py-2 text-sm">
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div class="flex justify-center py-6">
            <span class="loading loading-spinner" />
          </div>
        ) : (
          <form class="space-y-3" onSubmit={(e) => handleSave(e).catch(() => {})}>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <fieldset class="fieldset">
                <legend class="fieldset-legend">Name</legend>
                <input
                  type="text"
                  required
                  class="input input-bordered input-sm w-full"
                  value={name}
                  onInput={(e) => setName((e.target as HTMLInputElement).value)}
                />
              </fieldset>
              <fieldset class="fieldset">
                <legend class="fieldset-legend">Type</legend>
                <input
                  type="text"
                  class="input input-bordered input-sm w-full opacity-50"
                  value={backend.type}
                  disabled
                />
              </fieldset>
            </div>
            <fieldset class="fieldset">
              <legend class="fieldset-legend">Config (JSON)</legend>
              <textarea
                class="textarea textarea-bordered textarea-sm font-mono w-full"
                rows={backend.type === "http" || backend.type === "r2-s3compat" ? 8 : 3}
                value={config ?? ""}
                onInput={(e) => setConfig((e.target as HTMLTextAreaElement).value)}
              />
            </fieldset>
            <div class="modal-action">
              <button type="button" class="btn btn-sm" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-sm btn-primary"
                disabled={submitting || !name.trim()}
              >
                {submitting && <span class="loading loading-spinner loading-xs" />}
                {submitting ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        )}
      </div>
      <button type="button" class="modal-backdrop" onClick={onClose} aria-label="Close dialog" />
    </div>
  );
}

// ── SettingsSection ───────────────────────────────────────────────────────

function SettingsSection<T extends { id: string; name: string; type: string }>({
  title,
  addTitle,
  rows,
  typeOptions,
  onAdd,
  onDelete,
  onEdit,
  onTest,
  extraActions,
}: {
  title: string;
  addTitle: string;
  rows: T[];
  typeOptions: string[];
  onAdd: (name: string, type: string, config: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onEdit?: (row: T) => void;
  onTest?: (id: string, name: string, type: string) => void;
  extraActions?: preact.ComponentChildren;
}) {
  return (
    <div class="card bg-base-200">
      <div class="card-body gap-4">
        <div class="flex items-center justify-between">
          <h2 class="card-title">{title}</h2>
          {extraActions && <div class="flex gap-2">{extraActions}</div>}
        </div>
        {rows.length > 0 ? (
          <div class="overflow-x-auto">
            <table class="table table-sm">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>ID</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td>
                      <span class="badge badge-ghost badge-sm">{row.type}</span>
                    </td>
                    <td class="font-mono text-xs text-base-content/50">{row.id}</td>
                    <td class="flex gap-1">
                      {onTest && (row.type === "http" || row.type === "google-sheets") && (
                        <button
                          type="button"
                          class="btn btn-ghost btn-xs"
                          onClick={() => onTest(row.id, row.name, row.type)}
                        >
                          Test
                        </button>
                      )}
                      {onEdit && (
                        <button
                          type="button"
                          class="btn btn-ghost btn-xs"
                          onClick={() => onEdit(row)}
                        >
                          Edit
                        </button>
                      )}
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs text-error"
                        onClick={() => onDelete(row.id).catch(() => {})}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="text-sm text-base-content/50">None yet.</p>
        )}

        <div class="divider my-0" />

        <AddForm title={addTitle} typeOptions={typeOptions} onAdd={onAdd} />
      </div>
    </div>
  );
}

// ── SettingsPanel ─────────────────────────────────────────────────────────

export function SettingsPanel({ workerBase, getAuthHeaders }: SettingsPanelProps) {
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [backends, setBackends] = useState<StorageBackendRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testTarget, setTestTarget] = useState<{
    id: string;
    name: string;
    type: string;
  } | null>(null);
  const [editTarget, setEditTarget] = useState<StorageBackendRow | null>(null);
  const [gsNotice, setGsNotice] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const [credRes, backendRes] = await Promise.all([
        fetch(`${workerBase}/api/credentials`, { headers }),
        fetch(`${workerBase}/api/storage-backends`, { headers }),
      ]);
      if (!credRes.ok || !backendRes.ok) throw new Error("Failed to load settings");
      const credData = (await credRes.json()) as { credentials: CredentialRow[] };
      const backendData = (await backendRes.json()) as { backends: StorageBackendRow[] };
      setCredentials(credData.credentials);
      setBackends(backendData.backends);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Load failed");
    }
  }, [workerBase, getAuthHeaders]);

  useEffect(() => {
    fetchAll().catch(() => {});
  }, [fetchAll]);

  async function addCredential(name: string, type: string, configJson: string) {
    let config: unknown;
    try {
      config = JSON.parse(configJson);
    } catch {
      throw new Error("Config must be valid JSON");
    }
    const headers = await getAuthHeaders();
    const res = await fetch(`${workerBase}/api/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ name, type, config }),
    });
    if (!res.ok) throw new Error(`Add failed: ${res.status}`);
    await fetchAll();
  }

  async function deleteCredential(id: string) {
    const headers = await getAuthHeaders();
    const res = await fetch(`${workerBase}/api/credentials/${id}`, { method: "DELETE", headers });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    await fetchAll();
  }

  async function addBackend(name: string, type: string, configJson: string) {
    let config: unknown;
    try {
      config = JSON.parse(configJson);
    } catch {
      throw new Error("Config must be valid JSON");
    }
    const headers = await getAuthHeaders();
    const res = await fetch(`${workerBase}/api/storage-backends`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ name, type, config }),
    });
    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      throw new Error(data.error ?? `Add failed: ${res.status}`);
    }
    await fetchAll();
  }

  async function deleteBackend(id: string) {
    const headers = await getAuthHeaders();
    const res = await fetch(`${workerBase}/api/storage-backends/${id}`, {
      method: "DELETE",
      headers,
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    await fetchAll();
  }

  function connectGoogleSheets() {
    const name = window.prompt("Name for this Google Sheets credential:", "Google Sheets");
    if (!name) return;
    const workerOrigin = new URL(workerBase).origin;
    window.open(
      `${workerBase}/connect/google-sheets?name=${encodeURIComponent(name)}`,
      "_blank",
      "popup,width=600,height=700",
    );
    function handleMessage(e: MessageEvent) {
      if (e.origin !== workerOrigin) return;
      window.removeEventListener("message", handleMessage);
      if (e.data?.type === "gscred-success") {
        const credName = e.data.credentialName ? ` "${e.data.credentialName}"` : "";
        setGsNotice({ type: "success", msg: `Google Sheets${credName} connected.` });
        fetchAll().catch(() => {});
      } else if (e.data?.type === "gscred-error") {
        setGsNotice({
          type: "error",
          msg: `Google Sheets auth failed: ${e.data.reason ?? "unknown"}`,
        });
      }
    }
    window.addEventListener("message", handleMessage);
  }

  return (
    <div class="max-w-4xl mx-auto p-6 space-y-4">
      {testTarget && testTarget.type === "http" && (
        <TestDialog
          credentialId={testTarget.id}
          credentialName={testTarget.name}
          workerBase={workerBase}
          getAuthHeaders={getAuthHeaders}
          onClose={() => setTestTarget(null)}
        />
      )}
      {testTarget && testTarget.type === "google-sheets" && (
        <GoogleSheetsTestDialog
          credentialId={testTarget.id}
          credentialName={testTarget.name}
          workerBase={workerBase}
          getAuthHeaders={getAuthHeaders}
          onClose={() => setTestTarget(null)}
        />
      )}
      {editTarget && (
        <EditBackendDialog
          backend={editTarget}
          workerBase={workerBase}
          getAuthHeaders={getAuthHeaders}
          onSaved={fetchAll}
          onClose={() => setEditTarget(null)}
        />
      )}
      {loadError && (
        <div role="alert" class="alert alert-error">
          <span>{loadError}</span>
        </div>
      )}
      {gsNotice && (
        <div
          role="alert"
          class={`alert ${gsNotice.type === "success" ? "alert-success" : "alert-error"}`}
        >
          <span>{gsNotice.msg}</span>
          <button type="button" class="btn btn-xs btn-ghost" onClick={() => setGsNotice(null)}>
            ✕
          </button>
        </div>
      )}
      <SettingsSection
        title="Credentials"
        addTitle="Add Credential"
        rows={credentials}
        typeOptions={CREDENTIAL_TYPES}
        onAdd={addCredential}
        onDelete={deleteCredential}
        onTest={(id, name, type) => setTestTarget({ id, name, type })}
        extraActions={
          <button type="button" class="btn btn-sm btn-outline" onClick={connectGoogleSheets}>
            Connect Google Sheets
          </button>
        }
      />
      <SettingsSection
        title="Storage Backends"
        addTitle="Add Storage Backend"
        rows={backends}
        typeOptions={BACKEND_TYPES}
        onAdd={addBackend}
        onDelete={deleteBackend}
        onEdit={(row) => setEditTarget(row)}
      />
    </div>
  );
}
