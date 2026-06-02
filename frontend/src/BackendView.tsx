import { useEffect, useState } from "preact/hooks";
import { WORKER_BASE, authHeaders } from "./wb-api.ts";
import { DriveIcon, SaveIcon, SettingsIcon, TrashIcon } from "./wbIcons.tsx";
import type { WbBackend, WbCredential, WbCtx, WbTab } from "./workbench-types.ts";

// r2-s3compat first — it's the most common external backend type and the default
const BACKEND_TYPES = ["r2-s3compat", "r2-bound", "s3", "google-sheets", "gcs", "azure", "https"];

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

interface BackendDetail {
  id: string;
  name: string;
  type: string;
  config: unknown;
}

interface GsConfig {
  credentialId?: string;
  spreadsheetId?: string;
  sheetName?: string;
}

function defaultConfig(type: string): string {
  if (type === "r2-s3compat") return R2_S3COMPAT_CONFIG_TEMPLATE;
  return "{}";
}

function parseGsConfig(config: unknown): GsConfig {
  if (config && typeof config === "object") {
    const c = config as Record<string, unknown>;
    return {
      credentialId: typeof c.credentialId === "string" ? c.credentialId : undefined,
      spreadsheetId: typeof c.spreadsheetId === "string" ? c.spreadsheetId : undefined,
      sheetName: typeof c.sheetName === "string" ? c.sheetName : undefined,
    };
  }
  return {};
}

export function BackendView({ tab, ctx }: { tab: WbTab; ctx: WbCtx }) {
  const initial = tab.item as WbBackend | null;
  const backendId = initial?.id ?? null;
  const isNew = !backendId;

  const [backend, setBackend] = useState<BackendDetail | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "create">(isNew ? "create" : "view");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Available google-sheets credentials (loaded for GS backends)
  const [gsCredentials, setGsCredentials] = useState<WbCredential[]>([]);

  // ── Create form state ──────────────────────────────────────────────────────
  // Default to r2-s3compat (first in BACKEND_TYPES) so the visible select matches state
  const [fName, setFName] = useState(initial?.name ?? "");
  const [fType, setFType] = useState<string>(BACKEND_TYPES[0]);
  const [fConfig, setFConfig] = useState(defaultConfig(BACKEND_TYPES[0]));
  // Google Sheets guided create fields
  const [fGsCredId, setFGsCredId] = useState("");
  const [fGsSpreadsheetId, setFGsSpreadsheetId] = useState("");
  const [fGsSheetName, setFGsSheetName] = useState("");

  // ── Edit form state ────────────────────────────────────────────────────────
  const [eName, setEName] = useState("");
  const [eConfig, setEConfig] = useState("{}");
  // Google Sheets guided edit fields
  const [eGsCredId, setEGsCredId] = useState("");
  const [eGsSpreadsheetId, setEGsSpreadsheetId] = useState("");
  const [eGsSheetName, setEGsSheetName] = useState("");

  // Load credentials whenever we might need them (new GS backend or existing GS backend)
  useEffect(() => {
    authHeaders()
      .then((h) =>
        fetch(`${WORKER_BASE}/api/credentials`, { headers: h })
          .then((r) => (r.ok ? (r.json() as Promise<{ credentials: WbCredential[] }>) : null))
          .then((d) => {
            if (d) setGsCredentials(d.credentials.filter((c) => c.type === "google-sheets"));
          })
          .catch(() => {}),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isNew) return;
    (async () => {
      setLoading(true);
      try {
        const headers = await authHeaders();
        const res = await fetch(`${WORKER_BASE}/api/storage-backends/${backendId}`, { headers });
        if (!res.ok) throw new Error(`Load failed: ${res.status}`);
        const data = (await res.json()) as BackendDetail;
        setBackend(data);
        setEName(data.name);
        setEConfig(JSON.stringify(data.config, null, 2));
        if (data.type === "google-sheets") {
          const gs = parseGsConfig(data.config);
          setEGsCredId(gs.credentialId ?? "");
          setEGsSpreadsheetId(gs.spreadsheetId ?? "");
          setEGsSheetName(gs.sheetName ?? "");
        }
      } catch (err) {
        setLoadErr(err instanceof Error ? err.message : "Load failed");
      } finally {
        setLoading(false);
      }
    })().catch(() => {});
  }, [backendId, isNew]);

  function handleTypeChange(t: string) {
    setFType(t);
    setFConfig(defaultConfig(t));
    setFGsCredId("");
    setFGsSpreadsheetId("");
    setFGsSheetName("");
  }

  const isEditGsGuided = backend?.type === "google-sheets";

  async function create() {
    setSaving(true);
    setSaveErr(null);
    try {
      const headers = { ...(await authHeaders()), "Content-Type": "application/json" };
      let config: unknown;
      if (fType === "google-sheets") {
        config = {
          credentialId: fGsCredId,
          spreadsheetId: fGsSpreadsheetId,
          sheetName: fGsSheetName || "Sheet1",
        };
      } else if (fType === "r2-bound") {
        config = {};
      } else {
        try {
          config = JSON.parse(fConfig);
        } catch {
          throw new Error("Config must be valid JSON");
        }
      }
      const res = await fetch(`${WORKER_BASE}/api/storage-backends`, {
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
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit() {
    if (!backendId) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const headers = { ...(await authHeaders()), "Content-Type": "application/json" };
      const body: Record<string, unknown> = {};
      if (eName !== backend?.name) body.name = eName;
      if (backend?.type === "google-sheets") {
        body.config = {
          credentialId: eGsCredId,
          spreadsheetId: eGsSpreadsheetId,
          sheetName: eGsSheetName || "Sheet1",
        };
      } else if (backend?.type !== "r2-bound") {
        let config: unknown;
        try {
          config = JSON.parse(eConfig);
        } catch {
          throw new Error("Config must be valid JSON");
        }
        body.config = config;
      }
      if (Object.keys(body).length === 0) {
        setMode("view");
        return;
      }
      const res = await fetch(`${WORKER_BASE}/api/storage-backends/${backendId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? `Failed: ${res.status}`);
      }
      const fresh = await fetch(`${WORKER_BASE}/api/storage-backends/${backendId}`, {
        headers: await authHeaders(),
      });
      if (fresh.ok) {
        const updated = (await fresh.json()) as BackendDetail;
        setBackend(updated);
        setEName(updated.name);
        setEConfig(JSON.stringify(updated.config, null, 2));
        if (updated.type === "google-sheets") {
          const gs = parseGsConfig(updated.config);
          setEGsCredId(gs.credentialId ?? "");
          setEGsSpreadsheetId(gs.spreadsheetId ?? "");
          setEGsSheetName(gs.sheetName ?? "");
        }
      }
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
      setMode("view");
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function doDelete() {
    if (!backendId) return;
    if (!confirm(`Delete storage backend "${backend?.name ?? tab.title}"?`)) return;
    setDeleting(true);
    setSaveErr(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${WORKER_BASE}/api/storage-backends/${backendId}`, {
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

  const dimStyle = { color: "color-mix(in oklch, var(--color-base-content) 55%, transparent)" };

  if (loading) {
    return (
      <div class="wb-doc">
        <div class="wb-doc-head">
          <div class="wb-doc-titlewrap">
            <span class="wb-doc-kicker">
              <DriveIcon size={12} />
              Storage backend
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

  // Resolve credential name for GS view
  const viewGsConfig = backend?.type === "google-sheets" ? parseGsConfig(backend.config) : null;
  const viewGsCredName =
    gsCredentials.find((c) => c.id === viewGsConfig?.credentialId)?.name ??
    viewGsConfig?.credentialId ??
    "—";

  return (
    <div class="wb-doc">
      {/* Header */}
      <div class="wb-doc-head">
        <div class="wb-doc-titlewrap">
          <span class="wb-doc-kicker">
            <DriveIcon size={12} />
            Storage backend
          </span>
          <h1 class="wb-doc-title">
            {isNew ? "New storage backend" : (backend?.name ?? tab.title)}
          </h1>
          {!isNew && (
            <p class="wb-doc-sub">
              <span class="wb-tag wb-tag-type">{backend?.type}</span>
            </p>
          )}
        </div>
        <div class="wb-doc-actions">
          {mode === "view" && (
            <>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => setMode("edit")}>
                <SettingsIcon size={13} />
                Edit
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm text-error"
                onClick={() => doDelete().catch(() => {})}
                disabled={deleting}
                title="Delete backend"
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
                onClick={() => saveEdit().catch(() => {})}
                disabled={
                  saving ||
                  !eName.trim() ||
                  (isEditGsGuided && (!eGsCredId || !eGsSpreadsheetId.trim()))
                }
              >
                {saving ? <span class="loading loading-xs" /> : <SaveIcon size={13} />}
                Save
              </button>
            </>
          )}
          {mode === "create" && (
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={() => create().catch(() => {})}
              disabled={
                saving ||
                !fName.trim() ||
                (fType === "google-sheets" && (!fGsCredId || !fGsSpreadsheetId.trim()))
              }
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
          <span>{isNew ? "Storage backend created." : "Saved."}</span>
        </div>
      )}

      {/* ── Create form ──────────────────────────────────────────────────── */}
      {mode === "create" && (
        <div class="wb-form-grid">
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Name</legend>
            <input
              type="text"
              required
              maxLength={64}
              class="input input-sm w-full"
              value={fName}
              onInput={(e) => setFName((e.target as HTMLInputElement).value)}
              placeholder="my-storage"
              title="Must not contain '/'"
            />
            <span class="fieldset-label text-base-content/50 text-xs">
              Used in <code>r2://name/path</code> URIs
            </span>
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Type</legend>
            <select
              class="select select-sm w-full"
              onChange={(e) => handleTypeChange((e.target as HTMLSelectElement).value)}
            >
              {BACKEND_TYPES.map((t) => (
                <option key={t} value={t} selected={t === fType}>
                  {t}
                </option>
              ))}
            </select>
          </fieldset>

          {/* Type-specific config area */}
          {fType === "r2-bound" ? (
            <p class="col-span-full text-sm" style={dimStyle}>
              Uses the Cloudflare R2 bucket bound to this worker — no extra config required.
            </p>
          ) : fType === "google-sheets" ? (
            gsCredentials.length > 0 ? (
              <>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Google Sheets credential</legend>
                  <select
                    required
                    class="select select-sm w-full"
                    onChange={(e) => setFGsCredId((e.target as HTMLSelectElement).value)}
                  >
                    <option value="">— select —</option>
                    {gsCredentials.map((c) => (
                      <option key={c.id} value={c.id} selected={c.id === fGsCredId}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Spreadsheet ID</legend>
                  <input
                    type="text"
                    required
                    class="input input-sm font-mono w-full"
                    value={fGsSpreadsheetId}
                    onInput={(e) => setFGsSpreadsheetId((e.target as HTMLInputElement).value)}
                    placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
                  />
                  <span class="fieldset-label text-base-content/50 text-xs">
                    From URL: …/spreadsheets/d/&#123;ID&#125;/edit
                  </span>
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">
                    Sheet name{" "}
                    <span style={dimStyle} class="font-normal">
                      (optional)
                    </span>
                  </legend>
                  <input
                    type="text"
                    class="input input-sm w-full"
                    value={fGsSheetName}
                    onInput={(e) => setFGsSheetName((e.target as HTMLInputElement).value)}
                    placeholder="Sheet1"
                  />
                  <span class="fieldset-label text-base-content/50 text-xs">
                    Tab name for reads and writes. Defaults to Sheet1.
                  </span>
                </fieldset>
              </>
            ) : (
              <div class="col-span-full">
                <p class="text-sm" style={dimStyle}>
                  No Google Sheets credentials found. Go to{" "}
                  <strong>Credentials → New credential</strong> and connect a Google Sheets account
                  first, then come back to set up this backend.
                </p>
              </div>
            )
          ) : (
            <fieldset class="fieldset col-span-full">
              <legend class="fieldset-legend">Config (JSON)</legend>
              <textarea
                class="textarea textarea-bordered textarea-sm font-mono w-full"
                rows={fType === "r2-s3compat" ? 8 : 4}
                value={fConfig}
                onInput={(e) => setFConfig((e.target as HTMLTextAreaElement).value)}
              />
              {fType === "r2-s3compat" && (
                <p class="text-xs mt-1" style={dimStyle}>
                  <strong>endpoint</strong> —{" "}
                  <code>https://{"<accountId>"}.r2.cloudflarestorage.com</code>.{" "}
                  <strong>accessKeyId</strong> / <strong>secretAccessKey</strong> — create under{" "}
                  <em>R2 → Manage R2 API tokens</em>.
                </p>
              )}
            </fieldset>
          )}
        </div>
      )}

      {/* ── View mode ────────────────────────────────────────────────────── */}
      {mode === "view" && backend && (
        <div class="wb-section">
          <div class="wb-section-title">Configuration</div>
          <div class="wb-panel">
            {backend.type === "r2-bound" ? (
              <p class="text-sm p-3" style={dimStyle}>
                Uses the Cloudflare R2 bucket bound to this worker — no config required.
              </p>
            ) : backend.type === "google-sheets" && viewGsConfig ? (
              <table class="table table-sm">
                <tbody>
                  <tr>
                    <td style={{ width: 160, ...dimStyle }}>Credential</td>
                    <td class="font-mono">{viewGsCredName}</td>
                  </tr>
                  <tr>
                    <td style={dimStyle}>Spreadsheet ID</td>
                    <td class="font-mono">{viewGsConfig.spreadsheetId ?? "—"}</td>
                  </tr>
                  <tr>
                    <td style={dimStyle}>Sheet name</td>
                    <td class="font-mono">{viewGsConfig.sheetName ?? "Sheet1"}</td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <pre class="text-xs font-mono p-3 overflow-auto max-h-80 whitespace-pre-wrap break-all">
                {JSON.stringify(backend.config, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* ── Edit form ────────────────────────────────────────────────────── */}
      {mode === "edit" && backend && (
        <div class="wb-form-grid">
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Name</legend>
            <input
              type="text"
              required
              class="input input-sm w-full"
              value={eName}
              onInput={(e) => setEName((e.target as HTMLInputElement).value)}
            />
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Type</legend>
            <input
              type="text"
              class="input input-sm w-full opacity-50"
              value={backend.type}
              disabled
            />
          </fieldset>

          {backend.type === "r2-bound" ? (
            <p class="col-span-full text-sm" style={dimStyle}>
              Uses the Cloudflare R2 bucket bound to this worker — no config required.
            </p>
          ) : isEditGsGuided ? (
            <>
              <fieldset class="fieldset">
                <legend class="fieldset-legend">Google Sheets credential</legend>
                {gsCredentials.length > 0 ? (
                  <select
                    required
                    class="select select-sm w-full"
                    onChange={(e) => setEGsCredId((e.target as HTMLSelectElement).value)}
                  >
                    <option value="">— select —</option>
                    {gsCredentials.map((c) => (
                      <option key={c.id} value={c.id} selected={c.id === eGsCredId}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    class="input input-sm font-mono w-full"
                    value={eGsCredId}
                    onInput={(e) => setEGsCredId((e.target as HTMLInputElement).value)}
                    placeholder="cred_..."
                  />
                )}
              </fieldset>
              <fieldset class="fieldset">
                <legend class="fieldset-legend">Spreadsheet ID</legend>
                <input
                  type="text"
                  required
                  class="input input-sm font-mono w-full"
                  value={eGsSpreadsheetId}
                  onInput={(e) => setEGsSpreadsheetId((e.target as HTMLInputElement).value)}
                  placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
                />
              </fieldset>
              <fieldset class="fieldset">
                <legend class="fieldset-legend">
                  Sheet name{" "}
                  <span style={dimStyle} class="font-normal">
                    (optional)
                  </span>
                </legend>
                <input
                  type="text"
                  class="input input-sm w-full"
                  value={eGsSheetName}
                  onInput={(e) => setEGsSheetName((e.target as HTMLInputElement).value)}
                  placeholder="Sheet1"
                />
              </fieldset>
            </>
          ) : (
            <fieldset class="fieldset col-span-full">
              <legend class="fieldset-legend">Config (JSON)</legend>
              <textarea
                class="textarea textarea-bordered textarea-sm font-mono w-full"
                rows={backend.type === "r2-s3compat" ? 8 : 4}
                value={eConfig}
                onInput={(e) => setEConfig((e.target as HTMLTextAreaElement).value)}
              />
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}
