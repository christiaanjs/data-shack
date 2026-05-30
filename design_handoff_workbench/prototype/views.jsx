/* ============================================================================
   Data Shack Workbench — tab content views
   Each view renders one open tab. They talk to the app through `ctx`:
     ctx.data, ctx.schema, ctx.session, ctx.execute(sql,{source}) -> Promise,
     ctx.openTab(kind,item), ctx.setTabSql(id,text), ctx.saveQuery(name,sql)
   ============================================================================ */
const { useState: useS, useRef: useR, useEffect: useE } = React;

/* ── Result grid ───────────────────────────────────────────────────────── */
function ResultGrid({ result, running }) {
  if (running) return <div className="wb-result-empty"><span className="loading loading-sm" style={{ verticalAlign: "-3px", marginRight: 8 }}></span>Running…</div>;
  if (!result) return <div className="wb-result-empty">Run the query (<span className="wb-kbd">⌘↵</span>) to see results here.</div>;
  if (result.error) return <div className="wb-result-empty" style={{ color: "var(--color-error)" }}>{result.error}</div>;
  return (
    <div>
      <div className="wb-result-bar">
        <span>{result.rows.length} row{result.rows.length === 1 ? "" : "s"}</span>
        {result.ms != null && <span>· {result.ms} ms</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono)" }}>{result.columns.length} cols</span>
      </div>
      <table className="table table-sm table-zebra">
        <thead><tr><th style={{ width: 34, textAlign: "right", color: "color-mix(in oklch,var(--color-base-content) 35%,transparent)" }}>#</th>{result.columns.map((c) => <th key={c} className="font-mono">{c}</th>)}</tr></thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              <td style={{ textAlign: "right", color: "color-mix(in oklch,var(--color-base-content) 35%,transparent)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{i + 1}</td>
              {row.map((cell, j) => <td key={j} className="font-mono">{cell === null ? <em className="wb-null">null</em> : String(cell)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── SQL editor tab (the multi-tab REPL) ───────────────────────────────── */
function SqlTabView({ tab, ctx }) {
  const edRef = useR(null);
  const [result, setResult] = useS(tab.result || null);
  const [running, setRunning] = useS(false);
  const [saving, setSaving] = useS(false);
  const [saveName, setSaveName] = useS(tab.title && tab.title !== "Untitled" ? tab.title : "");

  async function run() {
    const sql = edRef.current ? edRef.current.getDoc() : tab.sql;
    if (!sql.trim()) return;
    setRunning(true); setResult(null);
    const res = await ctx.execute(sql, { source: tab.title });
    setResult(res); setRunning(false);
    ctx.setTabResult(tab.id, res);
  }
  function doSave() {
    const sql = edRef.current ? edRef.current.getDoc() : tab.sql;
    if (!saveName.trim()) return;
    ctx.saveQuery(saveName.trim(), sql, tab.id);
    setSaving(false);
  }

  return (
    <div className="wb-sql">
      <div className="wb-sql-toolbar">
        <Btn variant="primary" size="sm" onClick={run} disabled={!ctx.session.enabled} loading={running}>
          <Icon name="play" size={13} />{running ? "Running…" : "Run"}
        </Btn>
        <span className="wb-kbd">⌘↵</span>
        {!saving ? (
          <Btn variant="ghost" size="sm" onClick={() => setSaving(true)} title="Save as named query">
            <Icon name="bookmark" size={13} />Save
          </Btn>
        ) : (
          <span className="row" style={{ gap: 6 }}>
            <input className="input input-sm" style={{ width: 200 }} autoFocus placeholder="Query name"
              value={saveName} onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") doSave(); if (e.key === "Escape") setSaving(false); }} />
            <Btn variant="primary" size="sm" onClick={doSave}>Save</Btn>
            <Btn variant="ghost" size="sm" onClick={() => setSaving(false)}>Cancel</Btn>
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!ctx.session.enabled && <span style={{ fontSize: 11.5, color: "var(--color-warning)" }}>DuckDB disabled — enable in the title bar</span>}
        <span className="wb-sql-name">{tab.title}.sql</span>
      </div>
      <div className="wb-sql-split">
        <div className="wb-sql-editor">
          <SqlEditor ref={edRef} value={tab.sql || ""} schema={ctx.schema} autoFocus
            onChange={(t) => ctx.setTabSql(tab.id, t)} onRun={run} />
        </div>
        <div className="wb-result wb-scrollbar-thin"><ResultGrid result={result} running={running} /></div>
      </div>
    </div>
  );
}

/* ── small building blocks for detail docs ────────────────────────────── */
function DocHead({ kicker, kickerIcon, title, sub, actions }) {
  return (
    <div className="wb-doc-head">
      <div className="wb-doc-titlewrap">
        <span className="wb-doc-kicker">{kickerIcon && <Icon name={kickerIcon} size={12} />}{kicker}</span>
        <h1 className="wb-doc-title">{title}</h1>
        {sub && <p className="wb-doc-sub">{sub}</p>}
      </div>
      {actions && <div className="wb-doc-actions">{actions}</div>}
    </div>
  );
}
function StatRow({ items }) {
  return <div className="wb-stat-row">{items.map((it, i) => (
    <div className="wb-stat" key={i}>
      <span className="wb-stat-label">{it.label}</span>
      <span className={cls("wb-stat-value", it.sm && "sm")} style={it.color ? { color: it.color } : undefined}>{it.value}</span>
    </div>
  ))}</div>;
}
function Section({ title, count, action, children }) {
  return (
    <div className="wb-section">
      <div className="wb-section-title">{title}{count != null && <span className="wb-count">{count}</span>}<span style={{ flex: 1 }} />{action}</div>
      {children}
    </div>
  );
}

/* ── Table detail ──────────────────────────────────────────────────────── */
function TableDetailView({ item: t, ctx }) {
  function queryTable() {
    ctx.openTab("sql", { title: t.name, sql: `SELECT *\nFROM ${t.name}\nLIMIT 100;` });
  }
  if (t.failed) {
    return (
      <div className="wb-doc">
        <DocHead kicker="Catalog table" kickerIcon="table" title={t.name}
          sub="View unavailable — the latest snapshot file was not found in storage." />
        <div className="alert alert-warning"><span>The credential <code className="inline">{t.backend}</code> resolved no object at <code className="inline">{t.uri}</code>. Re-run its load job or re-commit a snapshot.</span></div>
        <StatRow items={[{ label: "Backend", value: t.backend, sm: true }, { label: "Format", value: t.format, sm: true }, { label: "Status", value: "unavailable", sm: true, color: "var(--color-warning)" }]} />
      </div>
    );
  }
  return (
    <div className="wb-doc">
      <DocHead kicker={t.derived ? `Derived · ${t.derived}` : "Catalog table"} kickerIcon="table" title={t.name}
        sub={t.uri}
        actions={<>
          <Btn variant="ghost" size="sm" title="Reload"><Icon name="refresh" size={13} /></Btn>
          <Btn variant="primary" size="sm" onClick={queryTable}><Icon name="play" size={13} />Query table</Btn>
        </>} />
      <StatRow items={[
        { label: "Rows (est.)", value: wbFmtNum(t.rows) },
        { label: "Size", value: wbFmtBytes(t.bytes) },
        { label: "Columns", value: t.schema.length, sm: true },
        { label: "Snapshots", value: t.snapshots.length, sm: true },
        { label: "Format", value: t.format, sm: true },
      ]} />

      <Section title="Schema" count={t.schema.length}
        action={<span className="wb-con-hint" style={{ fontFamily: "var(--font-mono)" }}>DESCRIBE {t.name}</span>}>
        <div className="wb-panel">
          <table className="table table-sm">
            <thead><tr><th style={{ width: 30 }}>#</th><th>column</th><th>type</th><th>null</th></tr></thead>
            <tbody>
              {t.schema.map(([c, ty], i) => (
                <tr key={c}>
                  <td style={{ color: "color-mix(in oklch,var(--color-base-content) 35%,transparent)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{i + 1}</td>
                  <td className="font-mono" style={{ fontWeight: 600 }}>{c}</td>
                  <td><span className="wb-tag wb-tag-type">{ty}</span></td>
                  <td className="font-mono" style={{ color: "color-mix(in oklch,var(--color-base-content) 45%,transparent)" }}>{c === "id" ? "NO" : "YES"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Snapshots" count={t.snapshots.length}
        action={<Btn variant="outline" size="xs">Commit snapshot</Btn>}>
        <div className="wb-panel"><div className="wb-timeline">
          {t.snapshots.map((s) => (
            <div className="wb-tl-row" key={s.id}>
              <div className="wb-tl-rail"><span className="wb-tl-dot" style={s.current ? undefined : { background: "color-mix(in oklch,var(--color-base-content) 30%,transparent)" }} /></div>
              <div>
                <div className="wb-tl-msg">{s.msg}{s.current && <span className="wb-tl-current">current</span>}</div>
                <div className="wb-tl-uri">{s.uri}</div>
              </div>
              <div className="wb-tl-meta">{wbFmtNum(s.rows)} rows<br />{s.when}</div>
            </div>
          ))}
        </div></div>
      </Section>

      <Section title="Preview" count={`${t.sample.length} of ${wbFmtNum(t.rows)}`}>
        <div className="wb-panel" style={{ overflowX: "auto" }}>
          <table className="table table-sm table-zebra">
            <thead><tr>{t.schema.slice(0, t.sample[0] ? t.sample[0].length : 0).map(([c]) => <th key={c} className="font-mono">{c}</th>)}</tr></thead>
            <tbody>
              {t.sample.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="font-mono" style={{ whiteSpace: "nowrap" }}>{cell === null ? <em className="wb-null">null</em> : String(cell)}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

/* ── Transform editor ──────────────────────────────────────────────────── */
function TransformView({ item, ctx }) {
  const blank = !item;
  const tr = item || { name: "", out: "", watches: [], policy: "any", status: "draft", sql: "-- New transform\nCREATE OR REPLACE TABLE my_table AS\nSELECT *\nFROM transactions;" };
  const edRef = useR(null);
  const [result, setResult] = useS(null);
  const [running, setRunning] = useS(false);
  const [name, setName] = useS(tr.name);

  async function run() {
    const sql = edRef.current ? edRef.current.getDoc() : tr.sql;
    setRunning(true); setResult(null);
    const res = await ctx.execute(sql, { source: tr.name || "transform" });
    setResult(res); setRunning(false);
  }
  return (
    <div className="wb-sql">
      <div className="wb-sql-toolbar" style={{ gap: 10 }}>
        <span className="wb-doc-kicker" style={{ textTransform: "none", letterSpacing: 0 }}><Icon name="transform" size={13} /></span>
        {blank
          ? <input className="input input-sm font-mono" style={{ width: 220 }} placeholder="transform name" value={name} onChange={(e) => setName(e.target.value)} />
          : <span className="wb-sql-name" style={{ fontWeight: 600, color: "var(--color-base-content)" }}>{tr.name}</span>}
        <span className="wb-con-hint">→ output</span>
        <span className="wb-tag wb-tag-type">{tr.out || "my_table"}</span>
        <span style={{ flex: 1 }} />
        <Btn variant="ghost" size="sm" onClick={run} disabled={!ctx.session.enabled} loading={running}><Icon name="play" size={13} />Dry run</Btn>
        <Btn variant="primary" size="sm"><Icon name="save" size={13} />{blank ? "Create" : "Save"}</Btn>
      </div>
      <div className="wb-sql-split">
        <div style={{ display: "flex", gap: 18, padding: "10px 14px", flexWrap: "wrap", borderBottom: "1px solid var(--color-base-300)", fontSize: 12, color: "color-mix(in oklch,var(--color-base-content) 60%,transparent)" }}>
          <span className="row" style={{ gap: 7 }}>watches:{tr.watches.length ? tr.watches.map((w) => <Badge key={w} variant="outline" size="sm" mono>{w}</Badge>) : <span className="wb-empty-inline">none</span>}</span>
          <span className="row" style={{ gap: 6 }}>trigger policy: <Badge variant="ghost" size="sm">{tr.policy}</Badge></span>
          <span className="row" style={{ gap: 6 }}>status: <span className={`ds-status ds-status-${tr.status === "draft" ? "idle" : tr.status}`}>{tr.status}</span> · {tr.ago || "—"}</span>
        </div>
        <div className="wb-sql-editor"><SqlEditor ref={edRef} value={tr.sql} schema={ctx.schema} autoFocus onChange={() => {}} onRun={run} /></div>
        <div className="wb-result wb-scrollbar-thin"><ResultGrid result={result} running={running} /></div>
      </div>
    </div>
  );
}

/* ── Dashboard viewer ──────────────────────────────────────────────────── */
function DashboardView({ item: d }) {
  const bars = [["May", 612, 650], ["Apr", 540, 650], ["Mar", 705, 650], ["Feb", 488, 650], ["Jan", 521, 650]];
  const max = 760;
  return (
    <div className="wb-doc">
      <DocHead kicker="Dashboard artifact" kickerIcon="chart" title={d.title} sub={`/d/${d.slug} · rendered in a sandboxed iframe`}
        actions={<Btn variant="ghost" size="sm"><Icon name="refresh" size={13} /></Btn>} />
      <div style={{ border: "1px solid var(--color-base-300)", borderRadius: "var(--radius-box)", background: "#fff", padding: 24 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 18, color: "#1a1a1a" }}>Spending vs budget — {d.title}</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 22, height: 230, borderBottom: "1px solid #e5e5e5", padding: "0 6px" }}>
          {bars.map(([m, spend, bud]) => (
            <div key={m} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: "100%", width: "100%", justifyContent: "center" }}>
                <div style={{ width: "26%", background: "oklch(49.12% 0.309 275.75)", borderRadius: "3px 3px 0 0", height: `${(spend / max) * 100}%` }} />
                <div style={{ width: "26%", background: "#d4d4d8", borderRadius: "3px 3px 0 0", height: `${(bud / max) * 100}%` }} />
              </div>
              <div style={{ fontSize: 12, color: "#71717a", marginTop: 8 }}>{m}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 18, marginTop: 14, fontSize: 12, color: "#52525b" }}>
          <span className="row" style={{ gap: 6 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: "oklch(49.12% 0.309 275.75)" }} />spent</span>
          <span className="row" style={{ gap: 6 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: "#d4d4d8" }} />budget</span>
        </div>
      </div>
      <p className="wb-con-hint">Authored conversationally via the MCP <code className="inline">submit_dashboard</code> tool, then validated and served from your Pages project.</p>
    </div>
  );
}

/* ── Load job ──────────────────────────────────────────────────────────── */
function JobView({ item, ctx }) {
  const blank = !item;
  const j = item || { table: "", cred: "", path: "", backend: "primary-r2", format: "ndjson", cron: "0 * * * *", last: "draft" };
  const [running, setRunning] = useS(false);
  return (
    <div className="wb-doc">
      <DocHead kicker="Load job" kickerIcon="job" title={blank ? "New load job" : j.table}
        sub={blank ? "Cron-triggered HTTP / Google Sheets → storage ETL." : `${j.cred}${j.path} → ${j.table}`}
        actions={blank ? <Btn variant="primary" size="sm"><Icon name="save" size={13} />Create</Btn> : <>
          <Btn variant="ghost" size="sm"><Icon name="settings" size={13} />Edit</Btn>
          <Btn variant="outline" size="sm" loading={running} onClick={() => { setRunning(true); setTimeout(() => setRunning(false), 1100); }}>{running ? "Running…" : "Run now"}</Btn>
        </>} />
      {!blank && j.last === "fail" && <div className="alert alert-error"><span>Last run failed — credential <code className="inline">{j.cred}</code> returned HTTP 401. Check the token in Settings.</span></div>}
      <div className="wb-panel"><table className="table table-sm"><tbody>
        {[["Output table", j.table || "—"], ["Credential", j.cred || "—"], ["Source path", j.path || "—"], ["Backend", j.backend], ["Format", j.format], ["Schedule (cron)", j.cron]].map(([k, v]) => (
          <tr key={k}><td style={{ width: 180, color: "color-mix(in oklch,var(--color-base-content) 55%,transparent)" }}>{k}</td><td className="font-mono">{v}</td></tr>
        ))}
      </tbody></table></div>
      {!blank && <Section title="Recent runs">
        <div className="wb-panel"><table className="table table-sm"><tbody>
          {[["ok", j.ago], ["ok", "1h ago"], [j.last, "1d ago"]].map(([st, ago], i) => (
            <tr key={i}><td style={{ width: 30 }}><Dot state={st === "ok" ? "success" : "idle"} /></td><td className="font-mono">{st === "ok" ? "committed snapshot" : "failed — HTTP 401"}</td><td className="font-mono" style={{ textAlign: "right", color: "color-mix(in oklch,var(--color-base-content) 45%,transparent)" }}>{ago}</td></tr>
          ))}
        </tbody></table></div>
      </Section>}
    </div>
  );
}

/* ── Settings detail (credential / backend) ────────────────────────────── */
function SettingsView({ item, kind }) {
  const isCred = kind === "cred";
  return (
    <div className="wb-doc">
      <DocHead kicker={isCred ? "Credential" : "Storage backend"} kickerIcon={isCred ? "key" : "drive"} title={item.name}
        sub="AES-encrypted at rest in D1. Values are never returned by the API once stored."
        actions={isCred ? <Btn variant="outline" size="sm">Test connection</Btn> : <Btn variant="ghost" size="sm"><Icon name="settings" size={13} />Edit</Btn>} />
      <div className="wb-panel"><table className="table table-sm"><tbody>
        {[["ID", item.id], ["Name", item.name], ["Type", item.type], ["Created", item.created]].map(([k, v]) => (
          <tr key={k}><td style={{ width: 160, color: "color-mix(in oklch,var(--color-base-content) 55%,transparent)" }}>{k}</td><td className="font-mono">{v}</td></tr>
        ))}
        <tr><td style={{ color: "color-mix(in oklch,var(--color-base-content) 55%,transparent)" }}>Secret</td><td className="font-mono wb-empty-inline">•••••••••••• (write-only)</td></tr>
      </tbody></table></div>
    </div>
  );
}

/* ── Commit snapshot (new catalog table) ───────────────────────────────── */
function CommitView({ ctx }) {
  const [name, setName] = useS(""); const [uri, setUri] = useS(""); const [ok, setOk] = useS(false);
  function commit() { if (!name || !uri) return; ctx.commitTable({ name, uri }); setOk(true); setName(""); setUri(""); setTimeout(() => setOk(false), 2500); }
  return (
    <div className="wb-doc">
      <DocHead kicker="Catalog" kickerIcon="database" title="Commit snapshot" sub="Register a storage file as a named, queryable table." />
      <div className="wb-form-grid">
        <Field legend="Table name"><input className="input input-sm font-mono" placeholder="transactions" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field legend="Format"><select className="select select-sm"><option>Auto — infer from URI</option><option>parquet</option><option>ndjson</option><option>csv</option></select></Field>
        <Field legend="URI" full><input className="input input-sm font-mono" placeholder="r2://data-shack-storage/transactions/2026-05.parquet" value={uri} onChange={(e) => setUri(e.target.value)} /></Field>
      </div>
      <div className="wb-section" style={{ gap: 8 }}>
        <div className="wb-con-hint">URI conventions</div>
        <div style={{ fontSize: 13, color: "color-mix(in oklch,var(--color-base-content) 75%,transparent)", display: "flex", flexDirection: "column", gap: 6 }}>
          <p style={{ margin: 0 }}><code className="inline">r2://bucket/path.parquet</code> — R2-bound storage, scoped to your namespace.</p>
          <p style={{ margin: 0 }}><code className="inline">r2-s3compat://backend-id/path</code> — S3-compatible backend by ID.</p>
          <p style={{ margin: 0 }}><code className="inline">http-ds://credName/path</code> — live HTTP source; backend auto-filled.</p>
        </div>
      </div>
      {ok && <div className="alert alert-success"><span>Snapshot committed.</span></div>}
      <div><Btn variant="primary" size="sm" onClick={commit}>Commit</Btn></div>
    </div>
  );
}

/* ── Welcome ───────────────────────────────────────────────────────────── */
function WelcomeView({ ctx }) {
  return (
    <div className="wb-welcome">
      <div className="wb-welcome-mark" />
      <div>
        <h1>Data Shack Workbench</h1>
        <p>Your personal data warehouse — the query engine runs in this browser tab. Open a table, write SQL, and chain transforms.</p>
      </div>
      <div className="wb-welcome-actions">
        <button className="wb-welcome-row" onClick={() => ctx.openTab("sql", { title: "Untitled", sql: "" })}>
          <span className="wb-wr-ico"><Icon name="terminal" size={18} /></span>
          <span className="wb-wr-main"><div className="wb-wr-title">New query</div><div className="wb-wr-sub">Open a blank SQL editor</div></span>
        </button>
        <button className="wb-welcome-row" onClick={() => ctx.openTab("table", ctx.data.tables[0])}>
          <span className="wb-wr-ico"><Icon name="table" size={18} /></span>
          <span className="wb-wr-main"><div className="wb-wr-title">Browse the catalog</div><div className="wb-wr-sub">Inspect schema, snapshots & size</div></span>
        </button>
        <button className="wb-welcome-row" onClick={ctx.openPalette}>
          <span className="wb-wr-ico"><Icon name="search" size={18} /></span>
          <span className="wb-wr-main"><div className="wb-wr-title">Command palette</div><div className="wb-wr-sub">Find anything — tables, saved queries, actions</div></span>
          <span className="wb-kbd">⌘K</span>
        </button>
      </div>
    </div>
  );
}

/* ── Tab router ────────────────────────────────────────────────────────── */
function TabContent({ tab, ctx }) {
  if (!tab) return <WelcomeView ctx={ctx} />;
  switch (tab.kind) {
    case "sql": return <SqlTabView tab={tab} ctx={ctx} />;
    case "table": return <TableDetailView item={tab.item} ctx={ctx} />;
    case "transform": return <TransformView item={tab.item} ctx={ctx} />;
    case "dashboard": return <DashboardView item={tab.item} />;
    case "job": return <JobView item={tab.item} ctx={ctx} />;
    case "cred": return <SettingsView item={tab.item} kind="cred" />;
    case "backend": return <SettingsView item={tab.item} kind="backend" />;
    case "commit": return <CommitView ctx={ctx} />;
    default: return <WelcomeView ctx={ctx} />;
  }
}

Object.assign(window, { TabContent, ResultGrid, WelcomeView });
