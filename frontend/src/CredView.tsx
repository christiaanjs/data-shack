import { useEffect, useState } from "preact/hooks";
import { WORKER_BASE, authHeaders } from "./wb-api.ts";
import {
  KeyIcon,
  LinkIcon,
  PlayIcon,
  RefreshIcon,
  SaveIcon,
  SettingsIcon,
  TrashIcon,
} from "./wbIcons.tsx";
import type { WbCredential, WbCtx, WbTab } from "./workbench-types.ts";

const CREDENTIAL_TYPES = ["http", "google-sheets", "google_oauth", "generic_token"];

const HTTP_CONFIG_TEMPLATE = JSON.stringify(
  {
    baseUrl: "https://api.example.com",
    headers: {
      Authorization: "Bearer {{apiKey}}",
    },
    variables: {
      apiKey: "your-token-here",
    },
  },
  null,
  2,
);

interface CredDetail {
  id: string;
  name: string;
  type: string;
  config: unknown;
}

export function CredView({ tab, ctx }: { tab: WbTab; ctx: WbCtx }) {
  const initial = tab.item as WbCredential | null;
  const credId = initial?.id ?? null;
  const isNew = !credId;

  const [cred, setCred] = useState<CredDetail | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "create">(isNew ? "create" : "view");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Google Sheets test state
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  // HTTP fetch test state
  const [testPath, setTestPath] = useState("/");
  const [httpTesting, setHttpTesting] = useState(false);
  const [httpResult, setHttpResult] = useState<{ status: number; body: string } | null>(null);

  // Create/edit form fields
  const [fName, setFName] = useState(initial?.name ?? "");
  const [fType, setFType] = useState(initial?.type ?? "http");
  const [fConfig, setFConfig] = useState(HTTP_CONFIG_TEMPLATE);

  useEffect(() => {
    if (isNew) return;
    (async () => {
      setLoading(true);
      try {
        const headers = await authHeaders();
        const res = await fetch(`${WORKER_BASE}/api/credentials/${credId}`, { headers });
        if (!res.ok) throw new Error(`Load failed: ${res.status}`);
        const data = (await res.json()) as CredDetail;
        setCred(data);
        setFName(data.name);
        setFConfig(JSON.stringify(data.config, null, 2));
      } catch (err) {
        setLoadErr(err instanceof Error ? err.message : "Load failed");
      } finally {
        setLoading(false);
      }
    })().catch(() => {});
  }, [credId, isNew]);

  function handleTypeChange(t: string) {
    setFType(t);
    if (t === "http") setFConfig(HTTP_CONFIG_TEMPLATE);
    else if (t === "google-sheets") setFConfig("{}");
    else setFConfig("{}");
  }

  async function save() {
    setSaving(true);
    setSaveErr(null);
    try {
      const headers = { ...(await authHeaders()), "Content-Type": "application/json" };
      let config: unknown;
      try {
        config = JSON.parse(fType === "google-sheets" && isNew ? "{}" : fConfig);
      } catch {
        throw new Error("Config must be valid JSON");
      }

      if (isNew) {
        const res = await fetch(`${WORKER_BASE}/api/credentials`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: fName, type: fType, config }),
        });
        if (!res.ok) {
          const d = (await res.json()) as { error?: string };
          throw new Error(d.error ?? `Failed: ${res.status}`);
        }
        setSaveOk(true);
        setTimeout(() => setSaveOk(false), 2500);
      } else {
        const body: Record<string, unknown> = {};
        if (fName !== cred?.name) body.name = fName;
        if (cred?.type !== "google-sheets") body.config = config;
        if (Object.keys(body).length === 0) {
          setMode("view");
          return;
        }
        const res = await fetch(`${WORKER_BASE}/api/credentials/${credId}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const d = (await res.json()) as { error?: string };
          throw new Error(d.error ?? `Failed: ${res.status}`);
        }
        const fresh = await fetch(`${WORKER_BASE}/api/credentials/${credId}`, {
          headers: await authHeaders(),
        });
        if (fresh.ok) {
          const updated = (await fresh.json()) as CredDetail;
          setCred(updated);
          setFName(updated.name);
          setFConfig(JSON.stringify(updated.config, null, 2));
        }
        setSaveOk(true);
        setTimeout(() => setSaveOk(false), 2500);
        setMode("view");
      }
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function doDelete() {
    if (!credId) return;
    if (!confirm(`Delete credential "${cred?.name ?? tab.title}"?`)) return;
    setDeleting(true);
    setSaveErr(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${WORKER_BASE}/api/credentials/${credId}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      ctx.closeTab(tab.id);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  }

  async function testGoogleSheets() {
    if (!credId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${WORKER_BASE}/api/credentials/${credId}/test`, {
        method: "POST",
        headers,
      });
      setTestResult((await res.json()) as { ok: boolean; error?: string });
    } catch (err) {
      setTestResult({ ok: false, error: String(err) });
    } finally {
      setTesting(false);
    }
  }

  async function testHttpFetch() {
    if (!credId) return;
    setHttpTesting(true);
    setHttpResult(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${WORKER_BASE}/api/data-sources/${credId}/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ path: testPath }),
      });
      const text = await res.text();
      setHttpResult({ status: res.status, body: text.slice(0, 4000) });
    } catch (err) {
      setHttpResult({ status: 0, body: err instanceof Error ? err.message : "Request failed" });
    } finally {
      setHttpTesting(false);
    }
  }

  function reconnectGoogleSheets() {
    const name = cred?.name ?? (fName || "Google Sheets");
    const workerOrigin = new URL(WORKER_BASE || window.location.origin).origin;
    const params = new URLSearchParams({ name });
    if (credId) params.set("credId", credId);
    const popup = window.open(
      `${WORKER_BASE}/connect/google-sheets?${params}`,
      "_blank",
      "popup,width=600,height=700",
    );

    function cleanup() {
      window.removeEventListener("message", handleMessage);
      if (pollTimer !== null) clearInterval(pollTimer);
    }

    function handleMessage(e: MessageEvent) {
      if (e.origin !== workerOrigin) return;
      cleanup();
      if (e.data?.type === "gscred-success") {
        setTestResult({ ok: true });
        // Re-fetch to confirm the credential is updated
        if (credId) {
          authHeaders()
            .then((h) =>
              fetch(`${WORKER_BASE}/api/credentials/${credId}`, { headers: h })
                .then((r) => (r.ok ? (r.json() as Promise<CredDetail>) : Promise.resolve(null)))
                .then((d) => {
                  if (d) setCred(d);
                })
                .catch(() => {}),
            )
            .catch(() => {});
        }
      } else if (e.data?.type === "gscred-error") {
        setTestResult({ ok: false, error: `OAuth failed: ${e.data.reason ?? "unknown"}` });
      }
    }

    window.addEventListener("message", handleMessage);
    const pollTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
      if (popup?.closed) cleanup();
    }, 500);
  }

  const dimStyle = { color: "color-mix(in oklch, var(--color-base-content) 55%, transparent)" };
  const typeLabel = cred?.type ?? fType;

  if (loading) {
    return (
      <div class="wb-doc">
        <div class="wb-doc-head">
          <div class="wb-doc-titlewrap">
            <span class="wb-doc-kicker">
              <KeyIcon size={12} />
              Credential
            </span>
            <h1 class="wb-doc-title" style={{ opacity: 0.4 }}>
              Loading…
            </h1>
          </div>
        </div>
      </div>
    );
  }

  if (loadErr) {
    return (
      <div class="wb-doc">
        <div class="alert alert-error">
          <span>{loadErr}</span>
        </div>
      </div>
    );
  }

  return (
    <div class="wb-doc">
      {/* Header */}
      <div class="wb-doc-head">
        <div class="wb-doc-titlewrap">
          <span class="wb-doc-kicker">
            <KeyIcon size={12} />
            Credential
          </span>
          <h1 class="wb-doc-title">{isNew ? "New credential" : (cred?.name ?? tab.title)}</h1>
          {!isNew && (
            <p class="wb-doc-sub">
              <span class="wb-tag wb-tag-type">{typeLabel}</span>
            </p>
          )}
        </div>
        <div class="wb-doc-actions">
          {mode === "view" && (
            <>
              {cred?.type === "google-sheets" && (
                <>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    onClick={() => testGoogleSheets().catch(() => {})}
                    disabled={testing}
                  >
                    {testing ? <span class="loading loading-xs" /> : <PlayIcon size={13} />}
                    Test
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    onClick={reconnectGoogleSheets}
                    title="Re-run the OAuth flow to refresh the stored token"
                  >
                    <LinkIcon size={13} />
                    Reconnect
                  </button>
                </>
              )}
              {cred?.type === "http" && (
                <button type="button" class="btn btn-ghost btn-sm" onClick={() => setMode("edit")}>
                  <SettingsIcon size={13} />
                  Edit
                </button>
              )}
              <button
                type="button"
                class="btn btn-ghost btn-sm text-error"
                onClick={() => doDelete().catch(() => {})}
                disabled={deleting}
                title="Delete credential"
              >
                {deleting ? <span class="loading loading-xs" /> : <TrashIcon size={13} />}
              </button>
            </>
          )}
          {mode === "edit" && (
            <>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => setMode("view")}>
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                onClick={() => save().catch(() => {})}
                disabled={saving}
              >
                {saving ? <span class="loading loading-xs" /> : <SaveIcon size={13} />}
                Save
              </button>
            </>
          )}
          {mode === "create" && fType === "google-sheets" && (
            <button type="button" class="btn btn-outline btn-sm" onClick={reconnectGoogleSheets}>
              <LinkIcon size={13} />
              Connect Google
            </button>
          )}
          {mode === "create" && fType !== "google-sheets" && (
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={() => save().catch(() => {})}
              disabled={saving || !fName.trim()}
            >
              {saving ? <span class="loading loading-xs" /> : <SaveIcon size={13} />}
              Create
            </button>
          )}
        </div>
      </div>

      {/* Alerts */}
      {saveErr && (
        <div class="alert alert-error">
          <span>{saveErr}</span>
        </div>
      )}
      {saveOk && (
        <div class="alert alert-success">
          <span>{isNew ? "Credential created." : "Saved."}</span>
        </div>
      )}
      {testResult && (
        <div class={`alert ${testResult.ok ? "alert-success" : "alert-error"}`}>
          <span>
            {testResult.ok
              ? "Token refresh successful — credential is working."
              : (testResult.error ?? "Test failed.")}
          </span>
          {!testResult.ok && (
            <button type="button" class="btn btn-sm btn-outline" onClick={reconnectGoogleSheets}>
              <RefreshIcon size={12} />
              Reconnect
            </button>
          )}
          <button
            type="button"
            class="btn btn-xs btn-ghost ml-auto"
            onClick={() => setTestResult(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* Create form */}
      {mode === "create" && (
        <div class="wb-form-grid">
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Name</legend>
            <input
              type="text"
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*"
              maxLength={64}
              class="input input-sm w-full"
              value={fName}
              onInput={(e) => setFName((e.target as HTMLInputElement).value)}
              title="Must start with a letter or digit; only letters, digits, '.', '_', '-' allowed"
            />
            <span class="fieldset-label text-base-content/50 text-xs">
              Used in <code>http-ds://name/…</code> URIs
            </span>
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Type</legend>
            <select
              class="select select-sm w-full"
              value={fType}
              onChange={(e) => handleTypeChange((e.target as HTMLSelectElement).value)}
            >
              {CREDENTIAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </fieldset>

          {fType === "google-sheets" ? (
            <div class="col-span-full">
              <p class="text-sm" style={dimStyle}>
                Click <strong>Connect Google</strong> above to start the OAuth flow. A popup will
                open to grant Sheets access.
              </p>
            </div>
          ) : (
            <fieldset class="fieldset col-span-full">
              <legend class="fieldset-legend">Config (JSON)</legend>
              <textarea
                class="textarea textarea-bordered textarea-sm font-mono w-full"
                rows={fType === "http" ? 10 : 4}
                value={fConfig}
                onInput={(e) => setFConfig((e.target as HTMLTextAreaElement).value)}
              />
              {fType === "http" && (
                <p class="text-xs mt-1" style={dimStyle}>
                  <strong>baseUrl</strong> — API root. <strong>headers</strong> — sent on every
                  request; use <code>{"{{name}}"}</code> to reference <strong>variables</strong>.
                </p>
              )}
            </fieldset>
          )}
        </div>
      )}

      {/* View: config table */}
      {mode === "view" && cred && cred.type !== "google-sheets" && (
        <div class="wb-section">
          <div class="wb-section-title">Configuration</div>
          <div class="wb-panel">
            <pre class="text-xs font-mono p-3 overflow-auto max-h-80 whitespace-pre-wrap break-all">
              {JSON.stringify(cred.config, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* View: google-sheets token info */}
      {mode === "view" && cred && cred.type === "google-sheets" && (
        <div class="wb-section">
          <div class="wb-section-title">OAuth token</div>
          <div class="wb-panel" style={{ padding: "12px 16px" }}>
            <p class="text-sm" style={dimStyle}>
              Stores a Google OAuth refresh token. Use <strong>Test</strong> to verify the token is
              still valid, or <strong>Reconnect</strong> to re-run the OAuth consent flow and
              replace the stored token.
            </p>
          </div>
        </div>
      )}

      {/* Edit form */}
      {mode === "edit" && cred && (
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
            <legend class="fieldset-legend">Type</legend>
            <input
              type="text"
              class="input input-sm w-full opacity-50"
              value={cred.type}
              disabled
            />
          </fieldset>
          {cred.type !== "google-sheets" && (
            <fieldset class="fieldset col-span-full">
              <legend class="fieldset-legend">Config (JSON)</legend>
              <textarea
                class="textarea textarea-bordered textarea-sm font-mono w-full"
                rows={cred.type === "http" ? 10 : 4}
                value={fConfig}
                onInput={(e) => setFConfig((e.target as HTMLTextAreaElement).value)}
              />
            </fieldset>
          )}
        </div>
      )}

      {/* HTTP test panel */}
      {mode === "view" && cred?.type === "http" && (
        <div class="wb-section">
          <div class="wb-section-title">Test fetch</div>
          <div class="wb-panel" style={{ padding: "12px 16px" }}>
            <div class="flex gap-2 items-end">
              <fieldset class="fieldset flex-1" style={{ margin: 0 }}>
                <legend class="fieldset-legend">Path</legend>
                <input
                  type="text"
                  class="input input-sm font-mono w-full"
                  value={testPath}
                  onInput={(e) => setTestPath((e.target as HTMLInputElement).value)}
                  placeholder="/accounts"
                />
              </fieldset>
              <button
                type="button"
                class="btn btn-sm btn-outline"
                onClick={() => testHttpFetch().catch(() => {})}
                disabled={httpTesting}
              >
                {httpTesting && <span class="loading loading-xs" />}
                {httpTesting ? "Fetching…" : "Fetch"}
              </button>
            </div>
            {httpResult && (
              <div class="mt-3 space-y-1">
                <p class="text-xs" style={dimStyle}>
                  Status:{" "}
                  <span
                    style={{
                      color:
                        httpResult.status < 300 ? "var(--color-success)" : "var(--color-error)",
                    }}
                  >
                    {httpResult.status}
                  </span>
                </p>
                <pre class="bg-base-300 rounded p-3 text-xs overflow-auto max-h-64 whitespace-pre-wrap break-all">
                  {httpResult.body}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
