import { useRef, useState } from "preact/hooks";
import { DashboardEditView } from "./DashboardEditView.tsx";
import { JobView } from "./JobView.tsx";
import { ResultGrid } from "./ResultGrid.tsx";
import type { SqlEditorHandle } from "./SqlEditor.tsx";
import { SqlEditor } from "./SqlEditor.tsx";
import { TransformView } from "./TransformView.tsx";
import type { CatalogTableWithSnapshot } from "./catalogViews.ts";
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

export function TableDetailView({ item: t, ctx }: { item: CatalogTableWithSnapshot; ctx: WbCtx }) {
  function queryTable() {
    ctx.openTab("sql", { title: t.name, sql: `SELECT *\nFROM ${t.name}\nLIMIT 100;` });
  }
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
            No snapshot committed for <code class="font-mono">{t.name}</code>.
          </span>
        </div>
      </div>
    );
  }
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
          <button type="button" class="btn btn-ghost btn-sm" title="Reload">
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
          { label: "Snapshot ID", value: `${snap.id.slice(0, 8)}…` },
        ].map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static list, order is stable
          <div class="wb-stat" key={i}>
            <span class="wb-stat-label">{it.label}</span>
            <span class="wb-stat-value sm">{it.value}</span>
          </div>
        ))}
      </div>
      <div class="wb-section">
        <div class="wb-section-title">Latest snapshot</div>
        <div class="wb-panel">
          <div class="wb-timeline">
            <div class="wb-tl-row">
              <div class="wb-tl-rail">
                <span class="wb-tl-dot" />
              </div>
              <div>
                <div class="wb-tl-msg">
                  committed <span class="wb-tl-current">current</span>
                </div>
                <div class="wb-tl-uri">{snap.uri}</div>
              </div>
              <div class="wb-tl-meta">{new Date(snap.created_at).toLocaleString()}</div>
            </div>
          </div>
        </div>
      </div>
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

export function CommitView({ ctx }: { ctx: WbCtx }) {
  const [name, setName] = useState("");
  const [uri, setUri] = useState("");
  const [ok, setOk] = useState(false);
  function commit() {
    if (!name || !uri) return;
    ctx.commitTable({ name, uri });
    setOk(true);
    setName("");
    setUri("");
    setTimeout(() => setOk(false), 2500);
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
            class="input input-sm font-mono"
            placeholder="transactions"
            value={name}
            onChange={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </fieldset>
        <fieldset class="fieldset">
          <legend class="fieldset-legend">URI</legend>
          <input
            class="input input-sm font-mono"
            style={{ gridColumn: "1 / -1" }}
            placeholder="r2://data-shack-storage/transactions/2026-05.parquet"
            value={uri}
            onChange={(e) => setUri((e.target as HTMLInputElement).value)}
          />
        </fieldset>
      </div>
      {ok && (
        <div class="alert alert-success">
          <span>Snapshot committed.</span>
        </div>
      )}
      <div>
        <button type="button" class="btn btn-primary btn-sm" onClick={commit}>
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
