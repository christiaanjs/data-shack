import { useEffect, useRef, useState } from "preact/hooks";
import type { SqlEditorHandle } from "./SqlEditor.tsx";
import { SqlEditor } from "./SqlEditor.tsx";
import type { CatalogTableWithSnapshot } from "./catalogViews.ts";
import {
  BookmarkIcon,
  DatabaseIcon,
  JobIcon,
  PlayIcon,
  RefreshIcon,
  SaveIcon,
  SearchIcon,
  SettingsIcon,
  TableIcon,
  TerminalIcon,
  TransformIcon,
} from "./wbIcons.tsx";
import type { QueryResult, WbCtx, WbTab, WbTransform } from "./workbench-types.ts";

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

// ── Transform editor ───────────────────────────────────────────────────────────

const WORKER_BASE_TV = import.meta.env.VITE_WORKER_URL ?? "";
const DEV_TOKEN_TV = import.meta.env.VITE_DEV_TOKEN as string | undefined;

async function tvAuthHeaders(): Promise<Record<string, string>> {
  if (DEV_TOKEN_TV) return { "X-Dev-Token": DEV_TOKEN_TV };
  const { getValidToken } = await import("./auth.ts");
  const token = await getValidToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

interface TrTrigger {
  id: string;
  watches: string[];
  policy: string;
  job_id: string;
}

function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return "—";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function TransformView({ tab, ctx }: { tab: WbTab; ctx: WbCtx }) {
  const tr = tab.item as WbTransform | null;
  const isNew = !tr;

  const edRef = useRef<SqlEditorHandle>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  // Editable fields
  const [name, setName] = useState(tr?.name ?? "");
  const [outputTable, setOutputTable] = useState(tr?.output_table ?? "");
  const [outputUri, setOutputUri] = useState(tr?.output_uri ?? "");
  const [outputBackend, setOutputBackend] = useState(tr?.output_backend ?? "");

  // Triggers for config strip
  const [trTriggers, setTrTriggers] = useState<TrTrigger[]>([]);
  const trId = tr?.id ?? null;
  useEffect(() => {
    if (!trId) return;
    tvAuthHeaders()
      .then((headers) =>
        fetch(`${WORKER_BASE_TV}/api/triggers`, { headers })
          .then((r) =>
            r.ok
              ? (r.json() as Promise<{ triggers: TrTrigger[] }>)
              : Promise.resolve({ triggers: [] as TrTrigger[] }),
          )
          .then(({ triggers }) => setTrTriggers(triggers.filter((t) => t.job_id === trId))),
      )
      .catch(() => {});
  }, [trId]);

  const watches = trTriggers.flatMap((t) => t.watches);
  const policy = trTriggers[0]?.policy ?? "any";
  const statusStr = tr?.status ?? "draft";
  const statusClass = statusStr === "draft" ? "idle" : statusStr;

  async function dryRun() {
    const sql = edRef.current?.getDoc() ?? tr?.sql ?? "";
    if (!sql.trim()) return;
    setRunning(true);
    setResult(null);
    const res = await ctx.execute(sql, { source: name || tr?.name || "transform" });
    setResult(res);
    setRunning(false);
  }

  async function save() {
    const sql = edRef.current?.getDoc() ?? tr?.sql ?? "";
    setSaving(true);
    setSaveError(null);
    try {
      const headers = { ...(await tvAuthHeaders()), "Content-Type": "application/json" };
      if (isNew) {
        const res = await fetch(`${WORKER_BASE_TV}/api/transform-jobs`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: name || null,
            sql,
            output_table: outputTable,
            output_uri: outputUri,
            output_backend: outputBackend,
          }),
        });
        if (!res.ok) {
          const txt = await res.text();
          setSaveError(txt || "Failed to create transform");
          return;
        }
      } else {
        const res = await fetch(`${WORKER_BASE_TV}/api/transform-jobs/${tr.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ name: name || null, sql }),
        });
        if (!res.ok) {
          const txt = await res.text();
          setSaveError(txt || "Failed to save transform");
          return;
        }
      }
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  const defaultSql =
    tr?.sql ??
    "-- New transform\nCREATE OR REPLACE TABLE my_table AS\nSELECT *\nFROM transactions;";

  return (
    <div class="wb-sql">
      <div class="wb-sql-toolbar" style={{ gap: 10 }}>
        <span class="wb-doc-kicker" style={{ textTransform: "none", letterSpacing: 0 }}>
          <TransformIcon size={13} />
        </span>
        {isNew ? (
          <input
            class="input input-sm font-mono"
            style={{ width: 220 }}
            placeholder="transform name"
            value={name}
            onChange={(e) => setName((e.target as HTMLInputElement).value)}
          />
        ) : (
          <span class="wb-sql-name" style={{ fontWeight: 600, color: "var(--color-base-content)" }}>
            {tr.name ?? tr.output_table}
          </span>
        )}
        <span class="wb-con-hint">→ output</span>
        {isNew ? (
          <input
            class="input input-sm font-mono"
            style={{ width: 160 }}
            placeholder="output_table"
            value={outputTable}
            onChange={(e) => setOutputTable((e.target as HTMLInputElement).value)}
          />
        ) : (
          <span class="wb-tag wb-tag-type">{tr.output_table}</span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={dryRun}
          disabled={!ctx.session.enabled || running}
        >
          {running ? <span class="loading loading-xs" /> : <PlayIcon size={13} />}
          Dry run
        </button>
        <button type="button" class="btn btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? <span class="loading loading-xs" /> : <SaveIcon size={13} />}
          {isNew ? "Create" : "Save"}
        </button>
      </div>

      {isNew && (
        <div class="wb-transform-config" style={{ flexWrap: "wrap", gap: 10 }}>
          <fieldset class="fieldset" style={{ margin: 0, flex: "1 1 200px" }}>
            <legend class="fieldset-legend">Output URI</legend>
            <input
              class="input input-sm font-mono w-full"
              placeholder="r2://bucket/path/table.parquet"
              value={outputUri}
              onChange={(e) => setOutputUri((e.target as HTMLInputElement).value)}
            />
          </fieldset>
          <fieldset class="fieldset" style={{ margin: 0, flex: "1 1 160px" }}>
            <legend class="fieldset-legend">Output backend</legend>
            <input
              class="input input-sm font-mono w-full"
              placeholder="primary-r2"
              value={outputBackend}
              onChange={(e) => setOutputBackend((e.target as HTMLInputElement).value)}
            />
          </fieldset>
        </div>
      )}

      {saveError && (
        <div
          class="alert alert-error"
          style={{ margin: "0 14px", borderRadius: "var(--radius-field)" }}
        >
          <span>{saveError}</span>
        </div>
      )}
      {saveOk && (
        <div
          class="alert alert-success"
          style={{ margin: "0 14px", borderRadius: "var(--radius-field)" }}
        >
          <span>{isNew ? "Transform created." : "Saved."}</span>
        </div>
      )}

      <div class="wb-sql-split">
        <div class="wb-transform-config">
          <span style={{ display: "flex", gap: 7, alignItems: "center" }}>
            watches:{" "}
            {watches.length > 0 ? (
              watches.map((w) => (
                <span key={w} class="badge badge-sm badge-outline font-mono">
                  {w}
                </span>
              ))
            ) : (
              <em class="wb-empty-inline">none</em>
            )}
          </span>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            trigger policy: <span class="badge badge-sm badge-ghost">{policy}</span>
          </span>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            status: <span class={`ds-status ds-status-${statusClass}`}>{statusStr}</span>
            {" · "}
            {fmtAgo(tr?.last_completed_at ?? tr?.last_run_at)}
          </span>
        </div>
        <div class="wb-sql-editor">
          <SqlEditor
            ref={edRef}
            value={defaultSql}
            schema={ctx.schema}
            autoFocus
            onChange={() => {}}
            onRun={dryRun}
          />
        </div>
        <div class="wb-result wb-scrollbar-thin">
          <ResultGrid result={result} running={running} />
        </div>
      </div>
    </div>
  );
}

// ── Load job detail / create / edit ───────────────────────────────────────────

interface LoadJobFull {
  id: string;
  name: string;
  credential_id: string;
  storage_backend_id: string;
  table_name: string;
  table_path: string;
  http_path: string;
  http_method: string;
  format: string;
  cron_schedule: string;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  source_type: string;
  source_config: string | null;
}

interface JvLookup {
  id: string;
  name: string;
  type: string;
}

export function JobView({ tab }: { tab: WbTab; ctx: WbCtx }) {
  const initial = tab.item as { id?: string } | null;
  const jobId = initial?.id ?? null;
  const isNew = !jobId;

  const [job, setJob] = useState<LoadJobFull | null>(null);
  const [credentials, setCredentials] = useState<JvLookup[]>([]);
  const [backends, setBackends] = useState<JvLookup[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "create">(isNew ? "create" : "view");
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  // Form fields
  const [fName, setFName] = useState("");
  const [fCredId, setFCredId] = useState("");
  const [fSbId, setFSbId] = useState("");
  const [fTable, setFTable] = useState("");
  const [fTablePath, setFTablePath] = useState("");
  const [fSrcType, setFSrcType] = useState<"http" | "google-sheets">("http");
  const [fPath, setFPath] = useState("/");
  const [fMethod, setFMethod] = useState("GET");
  const [fSpreadsheetId, setFSpreadsheetId] = useState("");
  const [fSheetName, setFSheetName] = useState("");
  const [fRange, setFRange] = useState("");
  const [fFormat, setFFormat] = useState("ndjson");
  const [fCron, setFCron] = useState("0 * * * *");

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const headers = await tvAuthHeaders();
        const [credRes, sbRes] = await Promise.all([
          fetch(`${WORKER_BASE_TV}/api/credentials`, { headers }),
          fetch(`${WORKER_BASE_TV}/api/storage-backends`, { headers }),
        ]);
        if (credRes.ok) {
          const d = (await credRes.json()) as { credentials: JvLookup[] };
          setCredentials(
            d.credentials.filter((c) => c.type === "http" || c.type === "google-sheets"),
          );
        }
        if (sbRes.ok) {
          const d = (await sbRes.json()) as { backends: JvLookup[] };
          setBackends(d.backends);
        }
        if (jobId) {
          const jobsRes = await fetch(`${WORKER_BASE_TV}/api/load-jobs`, { headers });
          if (jobsRes.ok) {
            const d = (await jobsRes.json()) as { jobs: LoadJobFull[] };
            const found = d.jobs.find((j) => j.id === jobId);
            if (found) setJob(found);
          }
        }
      } catch (err) {
        setLoadErr(err instanceof Error ? err.message : "Load failed");
      } finally {
        setLoading(false);
      }
    };
    load().catch(() => {});
  }, [jobId]);

  function populateForm(j: LoadJobFull) {
    setFName(j.name ?? "");
    setFCredId(j.credential_id ?? "");
    setFSbId(j.storage_backend_id ?? "");
    setFTable(j.table_name ?? "");
    setFTablePath(j.table_path ?? "");
    setFFormat(j.format ?? "ndjson");
    setFCron(j.cron_schedule ?? "0 * * * *");
    const srcType = (j.source_type ?? "http") as "http" | "google-sheets";
    setFSrcType(srcType);
    if (srcType === "http") {
      setFPath(j.http_path ?? "/");
      setFMethod(j.http_method ?? "GET");
    } else if (j.source_config) {
      try {
        const sc = JSON.parse(j.source_config) as {
          spreadsheetId?: string;
          sheetName?: string;
          range?: string;
        };
        setFSpreadsheetId(sc.spreadsheetId ?? "");
        setFSheetName(sc.sheetName ?? "");
        setFRange(sc.range ?? "");
      } catch {
        /* keep defaults */
      }
    }
  }

  async function runNow() {
    if (!job) return;
    setRunning(true);
    setRunMsg(null);
    try {
      const headers = await tvAuthHeaders();
      const res = await fetch(`${WORKER_BASE_TV}/api/load-jobs/${job.id}/trigger`, {
        method: "POST",
        headers,
      });
      setRunMsg(res.ok ? "Queued — check console for progress." : `Error ${res.status}`);
    } catch {
      setRunMsg("Request failed");
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    setSaving(true);
    setSaveErr(null);
    try {
      const headers = { ...(await tvAuthHeaders()), "Content-Type": "application/json" };
      const isEdit = mode === "edit" && job !== null;
      const url = isEdit
        ? `${WORKER_BASE_TV}/api/load-jobs/${job.id}`
        : `${WORKER_BASE_TV}/api/load-jobs`;
      const body: Record<string, unknown> = {
        name: fName,
        credential_id: fCredId,
        storage_backend_id: fSbId,
        table_name: fTable,
        ...(fTablePath ? { table_path: fTablePath } : {}),
        format: fFormat,
        cron_schedule: fCron,
        source_type: fSrcType,
        ...(fSrcType === "google-sheets"
          ? {
              source_config: {
                spreadsheetId: fSpreadsheetId,
                ...(fSheetName ? { sheetName: fSheetName } : {}),
                ...(fRange ? { range: fRange } : {}),
              },
            }
          : { http_path: fPath, http_method: fMethod }),
      };
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? `Failed: ${res.status}`);
      }
      // Re-fetch updated job list to get fresh data
      const refreshRes = await fetch(`${WORKER_BASE_TV}/api/load-jobs`, {
        headers: await tvAuthHeaders(),
      });
      if (refreshRes.ok) {
        const d = (await refreshRes.json()) as { jobs: LoadJobFull[] };
        const updated = d.jobs.find((j) => j.id === (job?.id ?? "")) ?? d.jobs[d.jobs.length - 1];
        if (updated) setJob(updated);
      }
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
      if (isEdit) setMode("view");
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  // Resolved display values
  const credName =
    credentials.find((c) => c.id === job?.credential_id)?.name ?? job?.credential_id ?? "—";
  const backendName =
    backends.find((b) => b.id === job?.storage_backend_id)?.name ?? job?.storage_backend_id ?? "—";
  let sourcePath = "—";
  if (job?.source_type === "google-sheets" && job.source_config) {
    try {
      const sc = JSON.parse(job.source_config) as { spreadsheetId?: string; sheetName?: string };
      sourcePath = sc.spreadsheetId ?? "—";
      if (sc.sheetName) sourcePath += ` / ${sc.sheetName}`;
    } catch {
      /* sourcePath stays "—" */
    }
  } else if (job?.http_path) {
    sourcePath = job.http_path;
  }
  const sourceSub = job
    ? `${credName}${job.source_type === "http" ? job.http_path : ""} → ${job.table_name}`
    : "Cron-triggered HTTP / Google Sheets → storage ETL.";

  const configRows: [string, string][] = job
    ? [
        ["Output table", job.table_name],
        ["Credential", credName],
        ["Source", sourcePath],
        ["Backend", backendName],
        ["Format", job.format],
        ["Schedule (cron)", job.cron_schedule],
      ]
    : [];

  const dimStyle = { color: "color-mix(in oklch, var(--color-base-content) 55%, transparent)" };

  const formSection = (
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
        <legend class="fieldset-legend">Source type</legend>
        <select
          class="select select-sm w-full"
          value={fSrcType}
          onChange={(e) => {
            setFSrcType((e.target as HTMLSelectElement).value as "http" | "google-sheets");
            setFCredId("");
          }}
        >
          <option value="http">HTTP</option>
          <option value="google-sheets">Google Sheets</option>
        </select>
      </fieldset>
      <fieldset class="fieldset">
        <legend class="fieldset-legend">
          {fSrcType === "google-sheets" ? "Google Sheets credential" : "HTTP credential"}
        </legend>
        <select
          required
          class="select select-sm w-full"
          value={fCredId}
          onChange={(e) => setFCredId((e.target as HTMLSelectElement).value)}
        >
          <option value="">— select —</option>
          {credentials
            .filter((c) => c.type === fSrcType)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </fieldset>
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Storage backend</legend>
        <select
          required
          class="select select-sm w-full"
          value={fSbId}
          onChange={(e) => setFSbId((e.target as HTMLSelectElement).value)}
        >
          <option value="">— select —</option>
          {backends.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.type})
            </option>
          ))}
        </select>
      </fieldset>
      {fSrcType === "http" ? (
        <>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Source path</legend>
            <input
              type="text"
              required
              class="input input-sm font-mono w-full"
              value={fPath}
              onInput={(e) => setFPath((e.target as HTMLInputElement).value)}
              placeholder="/api/records"
            />
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Method</legend>
            <select
              class="select select-sm w-full"
              value={fMethod}
              onChange={(e) => setFMethod((e.target as HTMLSelectElement).value)}
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
          </fieldset>
        </>
      ) : (
        <>
          <fieldset class="fieldset" style={{ gridColumn: "1 / -1" }}>
            <legend class="fieldset-legend">Spreadsheet ID</legend>
            <input
              type="text"
              required
              class="input input-sm font-mono w-full"
              value={fSpreadsheetId}
              onInput={(e) => setFSpreadsheetId((e.target as HTMLInputElement).value)}
              placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
            />
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">
              Sheet name <span style={dimStyle}>(optional)</span>
            </legend>
            <input
              type="text"
              class="input input-sm font-mono w-full"
              value={fSheetName}
              onInput={(e) => setFSheetName((e.target as HTMLInputElement).value)}
              placeholder="Sheet1"
            />
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">
              Range <span style={dimStyle}>(optional)</span>
            </legend>
            <input
              type="text"
              class="input input-sm font-mono w-full"
              value={fRange}
              onInput={(e) => setFRange((e.target as HTMLInputElement).value)}
              placeholder="A1:Z"
            />
          </fieldset>
        </>
      )}
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Output table</legend>
        <input
          type="text"
          required
          pattern="[a-zA-Z_][a-zA-Z0-9_]*"
          class="input input-sm font-mono w-full"
          value={fTable}
          onInput={(e) => setFTable((e.target as HTMLInputElement).value)}
          placeholder="my_table"
        />
      </fieldset>
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Format</legend>
        <select
          class="select select-sm w-full"
          value={fFormat}
          onChange={(e) => setFFormat((e.target as HTMLSelectElement).value)}
        >
          <option value="ndjson">ndjson</option>
          <option value="json">json</option>
          <option value="parquet">parquet</option>
          <option value="csv">csv</option>
        </select>
      </fieldset>
      <fieldset class="fieldset" style={{ gridColumn: "1 / -1" }}>
        <legend class="fieldset-legend">Cron schedule</legend>
        <input
          type="text"
          required
          class="input input-sm font-mono w-full"
          value={fCron}
          onInput={(e) => setFCron((e.target as HTMLInputElement).value)}
          placeholder="0 * * * *"
        />
      </fieldset>
    </div>
  );

  if (loading)
    return (
      <div class="wb-doc">
        <div class="wb-doc-head">
          <div class="wb-doc-titlewrap">
            <span class="wb-doc-kicker">
              <JobIcon size={12} />
              Load job
            </span>
            <h1 class="wb-doc-title" style={{ opacity: 0.4 }}>
              Loading…
            </h1>
          </div>
        </div>
      </div>
    );

  if (loadErr)
    return (
      <div class="wb-doc">
        <div class="alert alert-error">
          <span>{loadErr}</span>
        </div>
      </div>
    );

  return (
    <div class="wb-doc">
      {/* Doc head */}
      <div class="wb-doc-head">
        <div class="wb-doc-titlewrap">
          <span class="wb-doc-kicker">
            <JobIcon size={12} />
            Load job
          </span>
          <h1 class="wb-doc-title">{isNew ? "New load job" : (job?.table_name ?? tab.title)}</h1>
          <p class="wb-doc-sub">{sourceSub}</p>
        </div>
        <div class="wb-doc-actions">
          {mode === "create" && (
            <button type="button" class="btn btn-primary btn-sm" onClick={save} disabled={saving}>
              {saving ? <span class="loading loading-xs" /> : <SaveIcon size={13} />}
              Create
            </button>
          )}
          {mode === "view" && (
            <>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                onClick={() => {
                  if (job) populateForm(job);
                  setMode("edit");
                }}
              >
                <SettingsIcon size={13} />
                Edit
              </button>
              <button
                type="button"
                class="btn btn-outline btn-sm"
                onClick={() => runNow().catch(() => {})}
                disabled={running}
              >
                {running && <span class="loading loading-xs" />}
                {running ? "Running…" : "Run now"}
              </button>
            </>
          )}
          {mode === "edit" && (
            <>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => setMode("view")}>
                Cancel
              </button>
              <button type="button" class="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                {saving ? <span class="loading loading-xs" /> : <SaveIcon size={13} />}
                Save
              </button>
            </>
          )}
        </div>
      </div>

      {/* Alerts */}
      {mode === "view" && job?.last_error && (
        <div class="alert alert-error">
          <span>
            Last run failed: <code class="font-mono text-sm">{job.last_error}</code>
          </span>
        </div>
      )}
      {runMsg && (
        <div class={`alert ${runMsg.startsWith("Queued") ? "alert-success" : "alert-error"}`}>
          <span>{runMsg}</span>
        </div>
      )}
      {saveErr && (
        <div class="alert alert-error">
          <span>{saveErr}</span>
        </div>
      )}
      {saveOk && (
        <div class="alert alert-success">
          <span>{mode === "create" ? "Load job created." : "Saved."}</span>
        </div>
      )}

      {/* View: config table */}
      {mode === "view" && job && (
        <div class="wb-panel">
          <table class="table table-sm">
            <tbody>
              {configRows.map(([k, v]) => (
                <tr key={k}>
                  <td style={{ width: 180, ...dimStyle }}>{k}</td>
                  <td class="font-mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* View: recent runs */}
      {mode === "view" && job?.last_run_at && (
        <div class="wb-section">
          <div class="wb-section-title">Recent runs</div>
          <div class="wb-panel">
            <table class="table table-sm">
              <tbody>
                <tr>
                  <td style={{ width: 30 }}>
                    <span
                      class={`wb-dot wb-dot-${job.last_error ? "idle" : "success"}`}
                      style={{ display: "inline-block" }}
                    />
                  </td>
                  <td class="font-mono">
                    {job.last_error ? `failed — ${job.last_error}` : "committed snapshot"}
                  </td>
                  <td class="font-mono" style={{ textAlign: "right", ...dimStyle }}>
                    {fmtAgo(job.last_run_at)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create / edit: form */}
      {(mode === "create" || mode === "edit") && formSection}
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
