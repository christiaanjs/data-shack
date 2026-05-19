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

const CREDENTIAL_TYPES = ["akahu", "google_oauth", "generic_token"];
const BACKEND_TYPES = ["r2-bound", "s3", "r2-s3compat", "gcs", "azure", "https"];

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
  const [config, setConfig] = useState("{}");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onAdd(name, type, config);
      setName("");
      setConfig("{}");
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
            onChange={(e) => setType((e.target as HTMLSelectElement).value)}
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
          rows={3}
          value={config}
          onInput={(e) => setConfig((e.target as HTMLTextAreaElement).value)}
        />
      </fieldset>
      <button type="submit" class="btn btn-sm btn-primary" disabled={submitting || !name.trim()}>
        {submitting && <span class="loading loading-spinner loading-xs" />}
        {submitting ? "Adding…" : "Add"}
      </button>
    </form>
  );
}

function SettingsSection<T extends { id: string; name: string; type: string }>({
  title,
  addTitle,
  rows,
  typeOptions,
  onAdd,
  onDelete,
}: {
  title: string;
  addTitle: string;
  rows: T[];
  typeOptions: string[];
  onAdd: (name: string, type: string, config: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
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
                    <td>
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

export function SettingsPanel({ workerBase, getAuthHeaders }: SettingsPanelProps) {
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [backends, setBackends] = useState<StorageBackendRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

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
