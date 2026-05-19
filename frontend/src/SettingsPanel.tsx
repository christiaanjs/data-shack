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

export function SettingsPanel({ workerBase, getAuthHeaders }: SettingsPanelProps) {
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [backends, setBackends] = useState<StorageBackendRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [credName, setCredName] = useState("");
  const [credType, setCredType] = useState(CREDENTIAL_TYPES[0] ?? "akahu");
  const [credConfig, setCredConfig] = useState("{}");
  const [credSubmitting, setCredSubmitting] = useState(false);

  const [backendName, setBackendName] = useState("");
  const [backendType, setBackendType] = useState(BACKEND_TYPES[0] ?? "r2-bound");
  const [backendConfig, setBackendConfig] = useState("{}");
  const [backendSubmitting, setBackendSubmitting] = useState(false);

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
      setError(err instanceof Error ? err.message : "Load failed");
    }
  }, [workerBase, getAuthHeaders]);

  useEffect(() => {
    fetchAll().catch(() => {});
  }, [fetchAll]);

  async function handleAddCredential(e: Event) {
    e.preventDefault();
    setCredSubmitting(true);
    setError(null);
    try {
      let config: unknown;
      try {
        config = JSON.parse(credConfig);
      } catch {
        throw new Error("Config must be valid JSON");
      }
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ name: credName, type: credType, config }),
      });
      if (!res.ok) throw new Error(`Add failed: ${res.status}`);
      setCredName("");
      setCredConfig("{}");
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setCredSubmitting(false);
    }
  }

  async function handleDeleteCredential(id: string) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/credentials/${id}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function handleAddBackend(e: Event) {
    e.preventDefault();
    setBackendSubmitting(true);
    setError(null);
    try {
      let config: unknown;
      try {
        config = JSON.parse(backendConfig);
      } catch {
        throw new Error("Config must be valid JSON");
      }
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/storage-backends`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ name: backendName, type: backendType, config }),
      });
      if (!res.ok) throw new Error(`Add failed: ${res.status}`);
      setBackendName("");
      setBackendConfig("{}");
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setBackendSubmitting(false);
    }
  }

  async function handleDeleteBackend(id: string) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/storage-backends/${id}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  return (
    <div class="settings-panel">
      {error && <div class="error-banner">{error}</div>}

      <section class="panel-section">
        <h3>Credentials</h3>
        {credentials.length > 0 ? (
          <table class="settings-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>ID</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {credentials.map((cred) => (
                <tr key={cred.id}>
                  <td>{cred.name}</td>
                  <td>{cred.type}</td>
                  <td class="mono">{cred.id}</td>
                  <td>
                    <button
                      type="button"
                      class="delete-btn"
                      onClick={() => handleDeleteCredential(cred.id).catch(() => {})}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p class="empty-note">No credentials yet.</p>
        )}

        <form class="add-form" onSubmit={(e) => handleAddCredential(e).catch(() => {})}>
          <h4>Add Credential</h4>
          <label>
            Name
            <input
              type="text"
              required
              value={credName}
              onInput={(e) => setCredName((e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            Type
            <select
              value={credType}
              onChange={(e) => setCredType((e.target as HTMLSelectElement).value)}
            >
              {CREDENTIAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Config (JSON)
            <textarea
              rows={3}
              value={credConfig}
              onInput={(e) => setCredConfig((e.target as HTMLTextAreaElement).value)}
            />
          </label>
          <button type="submit" disabled={credSubmitting || !credName.trim()}>
            {credSubmitting ? "Adding…" : "Add Credential"}
          </button>
        </form>
      </section>

      <section class="panel-section">
        <h3>Storage Backends</h3>
        {backends.length > 0 ? (
          <table class="settings-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>ID</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {backends.map((backend) => (
                <tr key={backend.id}>
                  <td>{backend.name}</td>
                  <td>{backend.type}</td>
                  <td class="mono">{backend.id}</td>
                  <td>
                    <button
                      type="button"
                      class="delete-btn"
                      onClick={() => handleDeleteBackend(backend.id).catch(() => {})}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p class="empty-note">No storage backends yet.</p>
        )}

        <form class="add-form" onSubmit={(e) => handleAddBackend(e).catch(() => {})}>
          <h4>Add Storage Backend</h4>
          <label>
            Name
            <input
              type="text"
              required
              value={backendName}
              onInput={(e) => setBackendName((e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            Type
            <select
              value={backendType}
              onChange={(e) => setBackendType((e.target as HTMLSelectElement).value)}
            >
              {BACKEND_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Config (JSON)
            <textarea
              rows={3}
              value={backendConfig}
              onInput={(e) => setBackendConfig((e.target as HTMLTextAreaElement).value)}
            />
          </label>
          <button type="submit" disabled={backendSubmitting || !backendName.trim()}>
            {backendSubmitting ? "Adding…" : "Add Storage Backend"}
          </button>
        </form>
      </section>
    </div>
  );
}
