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

const CREDENTIAL_TYPES = ["http", "google_oauth", "generic_token"];
const BACKEND_TYPES = ["r2-bound", "s3", "r2-s3compat", "gcs", "azure", "https"];

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
            class="input input-bordered input-sm w-full"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
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

// ── SettingsSection ───────────────────────────────────────────────────────

function SettingsSection<T extends { id: string; name: string; type: string }>({
  title,
  addTitle,
  rows,
  typeOptions,
  onAdd,
  onDelete,
  onTest,
}: {
  title: string;
  addTitle: string;
  rows: T[];
  typeOptions: string[];
  onAdd: (name: string, type: string, config: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onTest?: (id: string, name: string) => void;
}) {
  return (
    <div class="card bg-base-200">
      <div class="card-body gap-4">
        <h2 class="card-title">{title}</h2>
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
                      {onTest && row.type === "http" && (
                        <button
                          type="button"
                          class="btn btn-ghost btn-xs"
                          onClick={() => onTest(row.id, row.name)}
                        >
                          Test
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
  const [testTarget, setTestTarget] = useState<{ id: string; name: string } | null>(null);

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
    if (!res.ok) throw new Error(`Add failed: ${res.status}`);
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

  return (
    <div class="max-w-4xl mx-auto p-6 space-y-4">
      {testTarget && (
        <TestDialog
          credentialId={testTarget.id}
          credentialName={testTarget.name}
          workerBase={workerBase}
          getAuthHeaders={getAuthHeaders}
          onClose={() => setTestTarget(null)}
        />
      )}
      {loadError && (
        <div role="alert" class="alert alert-error">
          <span>{loadError}</span>
        </div>
      )}
      <SettingsSection
        title="Credentials"
        addTitle="Add Credential"
        rows={credentials}
        typeOptions={CREDENTIAL_TYPES}
        onAdd={addCredential}
        onDelete={deleteCredential}
        onTest={(id, name) => setTestTarget({ id, name })}
      />
      <SettingsSection
        title="Storage Backends"
        addTitle="Add Storage Backend"
        rows={backends}
        typeOptions={BACKEND_TYPES}
        onAdd={addBackend}
        onDelete={deleteBackend}
      />
    </div>
  );
}
