import { useState } from "preact/hooks";
import { WORKER_BASE, authHeaders, fmtAgo } from "./wb-api.ts";
import { PlusIcon, SaveIcon, TokenIcon, TrashIcon } from "./wbIcons.tsx";
import type { WbCtx } from "./workbench-types.ts";

const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: "No expiry", days: null },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

interface CreatedToken {
  id: string;
  name: string;
  token: string;
  expires_at: number | null;
}

export function TokenView({ ctx }: { ctx: WbCtx }) {
  const { tokens } = ctx.data;

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<CreatedToken | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) return;
    setSaving(true);
    setCreateErr(null);
    try {
      const headers = { ...(await authHeaders()), "Content-Type": "application/json" };
      const res = await fetch(`${WORKER_BASE}/api/tokens`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: name.trim(), expiresInDays: expiryDays }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `Failed: ${res.status}`);
      }
      const created = (await res.json()) as CreatedToken;
      setJustCreated(created);
      setName("");
      setExpiryDays(null);
      setCreating(false);
      ctx.refreshData();
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string, tokenName: string) {
    if (!confirm(`Revoke token "${tokenName}"? Anything using it will stop working immediately.`))
      return;
    setRevokingId(id);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${WORKER_BASE}/api/tokens/${id}`, { method: "DELETE", headers });
      if (!res.ok) throw new Error(`Revoke failed: ${res.status}`);
      if (justCreated?.id === id) setJustCreated(null);
      ctx.refreshData();
    } catch {
      // non-fatal — the list will still reflect the last successful refresh
    } finally {
      setRevokingId(null);
    }
  }

  async function copyToken() {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable — token is still selectable in the box
    }
  }

  const dimStyle = { color: "color-mix(in oklch, var(--color-base-content) 55%, transparent)" };

  return (
    <div class="wb-doc">
      <div class="wb-doc-head">
        <div class="wb-doc-titlewrap">
          <span class="wb-doc-kicker">
            <TokenIcon size={12} />
            API Tokens
          </span>
          <h1 class="wb-doc-title">API Tokens</h1>
          <p class="wb-doc-sub">
            Long-lived bearer tokens for scripts and headless clients (MCP clients, the{" "}
            <code>container/</code> session client) — use as{" "}
            <code>Authorization: Bearer &lt;token&gt;</code>.
          </p>
        </div>
        <div class="wb-doc-actions">
          {!creating && (
            <button type="button" class="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              <PlusIcon size={13} />
              New token
            </button>
          )}
        </div>
      </div>

      {creating && (
        <div class="wb-form-grid">
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Name</legend>
            <input
              type="text"
              class="input input-sm w-full"
              placeholder="e.g. my-laptop, container-prod"
              maxLength={100}
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Expiry</legend>
            <select
              class="select select-sm w-full"
              value={expiryDays === null ? "none" : String(expiryDays)}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                setExpiryDays(v === "none" ? null : Number(v));
              }}
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.label} value={o.days === null ? "none" : String(o.days)}>
                  {o.label}
                </option>
              ))}
            </select>
          </fieldset>
          <div class="col-span-full" style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={() => create().catch(() => {})}
              disabled={saving || !name.trim()}
            >
              {saving ? <span class="loading loading-xs" /> : <SaveIcon size={13} />}
              Create
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={() => {
                setCreating(false);
                setCreateErr(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {createErr && (
        <div class="alert alert-error">
          <span>{createErr}</span>
        </div>
      )}

      {justCreated && (
        <div class="wb-section">
          <div class="wb-section-title">New token — copy it now</div>
          <div class="wb-panel" style={{ padding: "14px 16px" }}>
            <p class="text-sm" style={{ ...dimStyle, marginBottom: 10 }}>
              This is the only time <strong>{justCreated.name}</strong>'s token will be shown. Store
              it somewhere safe — the server keeps only a hash of it.
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                readOnly
                class="input input-sm font-mono w-full"
                value={justCreated.token}
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <button type="button" class="btn btn-sm btn-outline" onClick={() => copyToken()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <button
              type="button"
              class="btn btn-xs btn-ghost"
              style={{ marginTop: 10 }}
              onClick={() => setJustCreated(null)}
            >
              Done
            </button>
          </div>
        </div>
      )}

      <div class="wb-section">
        <div class="wb-section-title">
          Tokens
          <span class="wb-count">{tokens.length}</span>
        </div>
        <div class="wb-panel">
          {tokens.length === 0 ? (
            <div class="wb-result-empty">No tokens yet.</div>
          ) : (
            <table class="table table-sm">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td class="font-mono" style={{ fontWeight: 600 }}>
                      {t.name}
                    </td>
                    <td>{fmtAgo(t.created_at)}</td>
                    <td>{t.last_used_at ? fmtAgo(t.last_used_at) : "never"}</td>
                    <td>
                      {t.expires_at === null ? (
                        <span style={dimStyle}>no expiry</span>
                      ) : t.expires_at < Date.now() ? (
                        <span style={{ color: "var(--color-error)" }}>expired</span>
                      ) : (
                        new Date(t.expires_at).toLocaleDateString()
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs text-error"
                        title="Revoke token"
                        onClick={() => revoke(t.id, t.name).catch(() => {})}
                        disabled={revokingId === t.id}
                      >
                        {revokingId === t.id ? (
                          <span class="loading loading-xs" />
                        ) : (
                          <TrashIcon size={12} />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
