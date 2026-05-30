import { useRef, useState } from "preact/hooks";
import type { SqlEditorHandle } from "./SqlEditor.tsx";
import { SqlEditor } from "./SqlEditor.tsx";
import type { CatalogTableWithSnapshot } from "./catalogViews.ts";
import type { QueryResult, WbCtx, WbTab } from "./workbench-types.ts";

// ── Result grid ────────────────────────────────────────────────────────────────

function ResultGrid({
  result,
  running,
}: { result: QueryResult | null | undefined; running: boolean }) {
  if (running)
    return (
      <div class="wb-result-empty">
        <span class="loading loading-sm" style={{ verticalAlign: "-3px", marginRight: 8 }} />
        Running…
      </div>
    );
  if (!result)
    return (
      <div class="wb-result-empty">
        Run the query (<span class="wb-kbd">⌘↵</span>) to see results here.
      </div>
    );
  if (result.error)
    return (
      <div class="wb-result-empty" style={{ color: "var(--color-error)" }}>
        {result.error}
      </div>
    );
  return (
    <div>
      <div class="wb-result-bar">
        <span>
          {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
        </span>
        {result.ms != null && <span>· {result.ms} ms</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
          {result.columns.length} cols
        </span>
      </div>
      <table class="table table-sm table-zebra">
        <thead>
          <tr>
            <th
              style={{
                width: 34,
                textAlign: "right",
                color: "color-mix(in oklch,var(--color-base-content) 35%,transparent)",
              }}
            >
              #
            </th>
            {result.columns.map((c) => (
              <th key={c} class="font-mono">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: row index is the correct key for result grids
            <tr key={i}>
              <td
                style={{
                  textAlign: "right",
                  color: "color-mix(in oklch,var(--color-base-content) 35%,transparent)",
                  fontFamily: "var(--font-mono,monospace)",
                  fontSize: 11,
                }}
              >
                {i + 1}
              </td>
              {(row as unknown[]).map((cell, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cell column index is stable
                <td key={j} class="font-mono">
                  {cell === null ? <em class="wb-null">null</em> : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
    case "commit":
      return <CommitView ctx={ctx} />;
    default:
      return <GenericView tab={tab} ctx={ctx} />;
  }
}

function GenericView({ tab }: { tab: WbTab; ctx: WbCtx }) {
  const kindLabel: Record<string, string> = {
    transform: "Transform",
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
        Detail view — open the full {kindLabel[tab.kind] ?? tab.kind} panel for editing.
      </div>
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function Svg({ size, children }: { size: number; children: preact.ComponentChildren }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
function PlayIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </Svg>
  );
}
function BookmarkIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
    </Svg>
  );
}
function TableIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <path d="M12 3v18" />
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
    </Svg>
  );
}
function DatabaseIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </Svg>
  );
}
function RefreshIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </Svg>
  );
}
function TerminalIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </Svg>
  );
}
function SearchIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Svg>
  );
}
