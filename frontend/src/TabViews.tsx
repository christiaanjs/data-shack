import { useEffect, useRef, useState } from "preact/hooks";
import { BackendView } from "./BackendView.tsx";
import { CredView } from "./CredView.tsx";
import { DashboardEditView } from "./DashboardEditView.tsx";
import { JobView } from "./JobView.tsx";
import { ResultGrid } from "./ResultGrid.tsx";
import type { SqlEditorHandle } from "./SqlEditor.tsx";
import { SqlEditor } from "./SqlEditor.tsx";
import { TransformView } from "./TransformView.tsx";
import type { CatalogTableWithSnapshot } from "./catalogViews.ts";
import { WORKER_BASE, authHeaders, fmtAgo } from "./wb-api.ts";
import {
  BookmarkIcon,
  DatabaseIcon,
  PlayIcon,
  RefreshIcon,
  SearchIcon,
  TableIcon,
  TerminalIcon,
} from "./wbIcons.tsx";
import type { QueryResult, WbCtx, WbTab } from "./workbench-types.ts";

// ── SQL editor tab ─────────────────────────────────────────────────────────────

export function SqlTabView({ tab, ctx }: { tab: WbTab; ctx: WbCtx }) {
  const edRef = useRef<SqlEditorHandle>(null);
  const [result, setResult] = useState<QueryResult | null>(tab.result ?? null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState(tab.title !== "Untitled" ? tab.title : "");

  async function run() {
    const s = edRef.current ? edRef.current.getDoc() : (tab.sql ?? "");
    if (!s.trim()) return;
    setRunning(true);
    setResult(null);
    const res = await ctx.execute(s, { source: tab.title });
    setResult(res);
    setRunning(false);
    ctx.setTabResult(tab.id, res);
  }

  function doSave() {
    const s = edRef.current ? edRef.current.getDoc() : (tab.sql ?? "");
    if (!saveName.trim()) return;
    ctx.saveQuery(saveName.trim(), s, tab.id);
    setSaving(false);
  }

  return (
    <div class="wb-sql">
      <div class="wb-sql-toolbar">
        <button
          type="button"
          class={`btn btn-primary btn-sm${!ctx.session.enabled || running ? " btn-disabled" : ""}`}
          onClick={run}
        >
          {running ? <span class="loading loading-xs" /> : <PlayIcon size={13} />}
          {running ? "Running…" : "Run"}
        </button>
        <span class="wb-kbd">⌘↵</span>
        {!saving ? (
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => setSaving(true)}
            title="Save as named query"
          >
            <BookmarkIcon size={13} />
            Save
          </button>
        ) : (
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              class="input input-sm"
              style={{ width: 200 }}
              placeholder="Query name"
              value={saveName}
              onChange={(e) => setSaveName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") doSave();
                if (e.key === "Escape") setSaving(false);
              }}
            />
            <button type="button" class="btn btn-primary btn-sm" onClick={doSave}>
              Save
            </button>
            <button type="button" class="btn btn-ghost btn-sm" onClick={() => setSaving(false)}>
              Cancel
            </button>
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!ctx.session.enabled && (
          <span style={{ fontSize: 11.5, color: "var(--color-warning)" }}>
            DuckDB disabled — enable in the title bar
          </span>
        )}
        <span class="wb-sql-name">{tab.title}.sql</span>
      </div>
      <div class="wb-sql-split">
        <div class="wb-sql-editor">
          <SqlEditor
            ref={edRef}
            value={tab.sql ?? ""}
            schema={ctx.schema}
            autoFocus
            onChange={(text) => ctx.setTabSql(tab.id, text)}
            onRun={run}
          />
        </div>
        <div class="wb-result wb-scrollbar-thin">
          <ResultGrid result={result} running={running} />
        </div>
      </div>
    </div>
  );
}

// ── Table detail ───────────────────────────────────────────────────────────────

interface SnapshotEntry {
  id: string;
  uri: string;
  format: string | null;
  storage_backend: string | null;
  access_mode: string | null;
  created_at: number;
}

export function TableDetailView({ item: t, ctx }: { item: CatalogTableWithSnapshot; ctx: WbCtx }) {
  const [schema, setSchema] = useState<Array<[string, string]> | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotEntry[] | null>(null);
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  function queryTable() {
    ctx.openTab("sql", { title: t.name, sql: `SELECT *\nFROM ${t.name}\nLIMIT 100;` });
  }
  function reload() {
    setSchema(null);
    setPreview(null);
    setSnapshots(null);
    setRefreshKey((k) => k + 1);
  }

  // Fetch full snapshot history from API
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an intentional reload trigger
  useEffect(() => {
    authHeaders()
      .then((h) =>
        fetch(`${WORKER_BASE}/catalog/snapshots/${encodeURIComponent(t.name)}`, { headers: h }),
      )
      .then((r) => (r.ok ? (r.json() as Promise<{ snapshots: SnapshotEntry[] }>) : null))
      .then((d) => {
        if (d?.snapshots) setSnapshots(d.snapshots);
      })
      .catch(() => {});
  }, [t.name, refreshKey]);

  // Run DESCRIBE + SELECT preview when session is enabled
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is trigger; ctx.execute is a stable useCallback
  useEffect(() => {
    if (!ctx.session.enabled || !t.latestSnapshot) return;
    ctx
      .execute(`DESCRIBE "${t.name}";`, { source: `schema:${t.name}` })
      .then((res) => {
        if (!res.error && res.rows.length > 0) {
          setSchema(res.rows.map((r) => [String(r[0]), String(r[1])]));
        }
      })
      .catch(() => {});
    ctx
      .execute(`SELECT * FROM "${t.name}" LIMIT 10;`, { source: `preview:${t.name}` })
      .then((res) => {
        if (!res.error) setPreview(res);
      })
      .catch(() => {});
  }, [t.name, ctx.session.enabled, t.latestSnapshot, refreshKey]);

  const snap = t.latestSnapshot;

  if (!snap) {
    return (
      <div class="wb-doc">
        <div class="wb-doc-head">
          <div class="wb-doc-titlewrap">
            <span class="wb-doc-kicker">
              <TableIcon size={12} />
              Catalog table
            </span>
            <h1 class="wb-doc-title">{t.name}</h1>
            <p class="wb-doc-sub">View unavailable — no snapshot found.</p>
          </div>
        </div>
        <div class="alert alert-warning">
          <span>
            No snapshot committed for <code class="font-mono">{t.name}</code>. Re-run its load job
            or re-commit a snapshot.
          </span>
        </div>
        <div class="wb-stat-row">
          <div class="wb-stat">
            <span class="wb-stat-label">Status</span>
            <span class="wb-stat-value sm" style={{ color: "var(--color-warning)" }}>
              unavailable
            </span>
          </div>
        </div>
      </div>
    );
  }

  const displaySnapshots: SnapshotEntry[] = snapshots ?? [
    {
      id: snap.id,
      uri: snap.uri,
      format: snap.format ?? null,
      storage_backend: snap.storage_backend ?? null,
      access_mode: snap.access_mode ?? null,
      created_at: snap.created_at,
    },
  ];

  return (
    <div class="wb-doc">
      <div class="wb-doc-head">
        <div class="wb-doc-titlewrap">
          <span class="wb-doc-kicker">
            <TableIcon size={12} />
            Catalog table
          </span>
          <h1 class="wb-doc-title">{t.name}</h1>
          <p class="wb-doc-sub">{snap.uri}</p>
        </div>
        <div class="wb-doc-actions">
          <button type="button" class="btn btn-ghost btn-sm" title="Reload" onClick={reload}>
            <RefreshIcon size={13} />
          </button>
          <button type="button" class="btn btn-primary btn-sm" onClick={queryTable}>
            <PlayIcon size={13} />
            Query table
          </button>
        </div>
      </div>

      <div class="wb-stat-row">
        {[
          { label: "Format", value: snap.format ?? "—" },
          { label: "Backend", value: snap.storage_backend ?? "—" },
          { label: "Access", value: snap.access_mode ?? "—" },
          { label: "Snapshots", value: snapshots ? String(snapshots.length) : "…" },
        ].map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static list, order is stable
          <div class="wb-stat" key={i}>
            <span class="wb-stat-label">{it.label}</span>
            <span class="wb-stat-value sm">{it.value}</span>
          </div>
        ))}
      </div>

      {/* Schema section — requires active DuckDB session */}
      {ctx.session.enabled && (
        <div class="wb-section">
          <div class="wb-section-title">
            Schema
            {schema && <span class="wb-count">{schema.length}</span>}
          </div>
          <div class="wb-panel">
            {!schema ? (
              <div class="wb-result-empty">
                <span class="loading loading-xs" style={{ marginRight: 8 }} />
                Loading schema…
              </div>
            ) : (
              <table class="table table-sm">
                <thead>
                  <tr>
                    <th style={{ width: 30 }}>#</th>
                    <th>column</th>
                    <th>type</th>
                  </tr>
                </thead>
                <tbody>
                  {schema.map(([col, type], i) => (
                    <tr key={col}>
                      <td
                        class="font-mono"
                        style={{
                          color: "color-mix(in oklch, var(--color-base-content) 35%, transparent)",
                          fontSize: 11,
                        }}
                      >
                        {i + 1}
                      </td>
                      <td class="font-mono" style={{ fontWeight: 600 }}>
                        {col}
                      </td>
                      <td>
                        <span class="wb-tag wb-tag-type">{type}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Snapshot timeline */}
      <div class="wb-section">
        <div class="wb-section-title">
          Snapshots
          {snapshots && <span class="wb-count">{snapshots.length}</span>}
        </div>
        <div class="wb-panel">
          <div class="wb-timeline">
            {displaySnapshots.map((s, i) => (
              <div class="wb-tl-row" key={s.id ?? i}>
                <div class="wb-tl-rail">
                  <span
                    class="wb-tl-dot"
                    style={
                      i > 0
                        ? {
                            background:
                              "color-mix(in oklch, var(--color-base-content) 30%, transparent)",
                          }
                        : undefined
                    }
                  />
                </div>
                <div>
                  <div class="wb-tl-msg">
                    committed{i === 0 && <span class="wb-tl-current">current</span>}
                  </div>
                  <div class="wb-tl-uri">{s.uri}</div>
                </div>
                <div class="wb-tl-meta">{fmtAgo(s.created_at)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Preview section — requires active DuckDB session */}
      {ctx.session.enabled && (
        <div class="wb-section">
          <div class="wb-section-title">
            Preview
            {preview && <span class="wb-count">{preview.rows.length} of 10</span>}
          </div>
          <div class="wb-panel" style={{ overflowX: "auto" }}>
            {!preview ? (
              <div class="wb-result-empty">
                <span class="loading loading-xs" style={{ marginRight: 8 }} />
                Loading preview…
              </div>
            ) : preview.error ? (
              <div class="wb-result-empty" style={{ color: "var(--color-error)" }}>
                {preview.error}
              </div>
            ) : (
              <table class="table table-sm table-zebra">
                <thead>
                  <tr>
                    {preview.columns.map((c) => (
                      <th key={c} class="font-mono">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no stable key
                    <tr key={i}>
                      {row.map((cell, j) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: column index is stable here
                        <td key={j} class="font-mono" style={{ whiteSpace: "nowrap" }}>
                          {cell === null ? <em class="wb-null">null</em> : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Welcome ────────────────────────────────────────────────────────────────────

export function WelcomeView({ ctx }: { ctx: WbCtx }) {
  return (
    <div class="wb-welcome">
      <div class="wb-welcome-mark" />
      <div>
        <h1>Data Shack Workbench</h1>
        <p>
          Your personal data warehouse — the query engine runs in this browser tab. Open a table,
          write SQL, and chain transforms.
        </p>
      </div>
      <div class="wb-welcome-actions">
        <button
          type="button"
          class="wb-welcome-row"
          onClick={() => ctx.openTab("sql", { title: "Untitled", sql: "" })}
        >
          <span class="wb-wr-ico">
            <TerminalIcon size={18} />
          </span>
          <span class="wb-wr-main">
            <div class="wb-wr-title">New query</div>
            <div class="wb-wr-sub">Open a blank SQL editor</div>
          </span>
        </button>
        {ctx.data.tables.length > 0 && (
          <button
            type="button"
            class="wb-welcome-row"
            onClick={() => ctx.openTab("table", ctx.data.tables[0])}
          >
            <span class="wb-wr-ico">
              <TableIcon size={18} />
            </span>
            <span class="wb-wr-main">
              <div class="wb-wr-title">Browse the catalog</div>
              <div class="wb-wr-sub">Inspect schema, snapshots & size</div>
            </span>
          </button>
        )}
        <button type="button" class="wb-welcome-row" onClick={ctx.openPalette}>
          <span class="wb-wr-ico">
            <SearchIcon size={18} />
          </span>
          <span class="wb-wr-main">
            <div class="wb-wr-title">Command palette</div>
            <div class="wb-wr-sub">Find anything — tables, saved queries, actions</div>
          </span>
          <span class="wb-kbd">⌘K</span>
        </button>
      </div>
    </div>
  );
}

// ── Commit view ────────────────────────────────────────────────────────────────

function storageMetaFromUri(uri: string): { storageBackend: string; accessMode: string } {
  const m = uri.match(/^([a-z0-9-]+):\/\/([^/]+)/);
  if (m) {
    const [, scheme, host] = m;
    if (scheme === "http-ds") return { storageBackend: host, accessMode: "direct" };
    return { storageBackend: host, accessMode: "proxy" };
  }
  return { storageBackend: "primary-r2", accessMode: "proxy" };
}

export function CommitView({ ctx }: { ctx: WbCtx }) {
  const [name, setName] = useState("");
  const [uri, setUri] = useState("");
  const [format, setFormat] = useState("auto");
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function commit() {
    if (!name.trim() || !uri.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      const { storageBackend, accessMode } = storageMetaFromUri(uri);
      const headers = { ...(await authHeaders()), "Content-Type": "application/json" };
      const res = await fetch(`${WORKER_BASE}/catalog/commit`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          table: name.trim(),
          uri: uri.trim(),
          storageBackend,
          accessMode,
          ...(format !== "auto" ? { format } : {}),
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `Failed: ${res.status}`);
      }
      ctx.commitTable({ name: name.trim(), uri: uri.trim() });
      setOk(true);
      setName("");
      setUri("");
      setFormat("auto");
      setTimeout(() => setOk(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="wb-doc">
      <div class="wb-doc-head">
        <div class="wb-doc-titlewrap">
          <span class="wb-doc-kicker">
            <DatabaseIcon size={12} />
            Catalog
          </span>
          <h1 class="wb-doc-title">Commit snapshot</h1>
          <p class="wb-doc-sub">Register a storage file as a named, queryable table.</p>
        </div>
      </div>
      <div class="wb-form-grid">
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Table name</legend>
          <input
            class="input input-sm font-mono w-full"
            placeholder="transactions"
            value={name}
            onChange={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </fieldset>
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Format</legend>
          <select
            class="select select-sm w-full"
            value={format}
            onChange={(e) => setFormat((e.target as HTMLSelectElement).value)}
          >
            <option value="auto">Auto — infer from URI</option>
            <option value="parquet">parquet</option>
            <option value="ndjson">ndjson</option>
            <option value="csv">csv</option>
          </select>
        </fieldset>
        <fieldset class="fieldset" style={{ gridColumn: "1 / -1" }}>
          <legend class="fieldset-legend">URI</legend>
          <input
            class="input input-sm font-mono w-full"
            placeholder="r2://data-shack-storage/transactions/2026-05.parquet"
            value={uri}
            onChange={(e) => setUri((e.target as HTMLInputElement).value)}
          />
        </fieldset>
      </div>
      <div class="wb-section" style={{ gap: 8 }}>
        <div class="wb-con-hint">URI conventions</div>
        <div
          style={{
            fontSize: 13,
            color: "color-mix(in oklch, var(--color-base-content) 70%, transparent)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <p style={{ margin: 0 }}>
            <code class="font-mono">r2://bucket/path.parquet</code> — R2-bound storage, scoped to
            your namespace.
          </p>
          <p style={{ margin: 0 }}>
            <code class="font-mono">r2-s3compat://backend-name/path</code> — S3-compatible backend
            by name.
          </p>
          <p style={{ margin: 0 }}>
            <code class="font-mono">http-ds://credName/path</code> — live HTTP source; backend
            auto-filled.
          </p>
        </div>
      </div>
      {err && (
        <div class="alert alert-error">
          <span>{err}</span>
        </div>
      )}
      {ok && (
        <div class="alert alert-success">
          <span>Snapshot committed.</span>
        </div>
      )}
      <div>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onClick={() => commit().catch(() => {})}
          disabled={saving || !name.trim() || !uri.trim()}
        >
          {saving && <span class="loading loading-xs" />}
          Commit
        </button>
      </div>
    </div>
  );
}

// ── Generic tab content router ─────────────────────────────────────────────────

export function TabContent({ tab, ctx }: { tab: WbTab | null; ctx: WbCtx }) {
  if (!tab) return <WelcomeView ctx={ctx} />;
  switch (tab.kind) {
    case "sql":
      return <SqlTabView tab={tab} ctx={ctx} />;
    case "table":
      return <TableDetailView item={tab.item as CatalogTableWithSnapshot} ctx={ctx} />;
    case "transform":
      return <TransformView tab={tab} ctx={ctx} />;
    case "job":
      return <JobView tab={tab} ctx={ctx} />;
    case "dashboard":
      return <DashboardEditView tab={tab} ctx={ctx} />;
    case "cred":
      return <CredView tab={tab} ctx={ctx} />;
    case "backend":
      return <BackendView tab={tab} ctx={ctx} />;
    case "commit":
      return <CommitView ctx={ctx} />;
    default:
      return <GenericView tab={tab} ctx={ctx} />;
  }
}

function GenericView({ tab }: { tab: WbTab; ctx: WbCtx }) {
  const kindLabel: Record<string, string> = {
    dashboard: "Dashboard",
    job: "Load job",
    cred: "Credential",
    backend: "Storage backend",
  };
  return (
    <div class="wb-doc">
      <div class="wb-doc-head">
        <div class="wb-doc-titlewrap">
          <span class="wb-doc-kicker">{kindLabel[tab.kind] ?? tab.kind}</span>
          <h1 class="wb-doc-title">{tab.title}</h1>
        </div>
      </div>
      <div
        class="wb-panel"
        style={{
          padding: 20,
          color: "color-mix(in oklch, var(--color-base-content) 55%, transparent)",
          fontSize: 13,
        }}
      >
        Detail view coming soon.
      </div>
    </div>
  );
}
