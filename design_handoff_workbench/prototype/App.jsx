/* ============================================================================
   Data Shack Workbench — App shell
   Assembles the IDE: title bar · activity rail · explorer · tab editor area ·
   bottom console dock · status bar · ⌘K palette. Mounts to #root.
   ============================================================================ */
const { useState: useA, useEffect: useAE, useRef: useAR, useCallback: useAC, useMemo: useAM } = React;

function nowClock() {
  const d = new Date();
  return d.toLocaleTimeString("en-NZ", { hour12: false });
}

function Login({ onSignIn }) {
  return (
    <div className="wb-login">
      <div className="wb-login-card">
        <div className="wb-mark-lg" />
        <h1>Data Shack</h1>
        <p>Your personal data warehouse</p>
        <Btn variant="primary" size="" onClick={onSignIn}>Sign in with Google</Btn>
      </div>
    </div>
  );
}

function TitleBar({ session, onToggleSession, theme, onToggleTheme, onPalette, userId, onSignOut, hasNewData }) {
  return (
    <div className="wb-titlebar">
      <span className="wb-tb-wordmark"><span className="wb-mark" />Data Shack</span>
      <span className="wb-tb-spacer" />
      <button className="wb-cmdk-hint" onClick={onPalette}>
        <Icon name="search" size={14} />
        <span>Search & commands</span>
        <span className="wb-spacer" />
        <span className="wb-kbd">⌘K</span>
      </button>
      <span className="wb-tb-spacer" />
      <div className="wb-tb-group">
        <span className="row" style={{ gap: 6 }} title={hasNewData ? "New data committed" : (session.connected ? "Browser session active" : "No session")}>
          <span className={cls("dot", hasNewData ? "dot-warning" : "wb-dot-hidden")} style={hasNewData ? undefined : { background: "transparent" }} />
          <span className={cls("dot", session.connected ? "dot-success" : "dot-idle")} />
        </span>
        <label className="wb-toggle-label" title="Enable DuckDB session">
          <span>DuckDB</span>
          <input type="checkbox" className="toggle toggle-xs" checked={session.enabled} onChange={onToggleSession} />
        </label>
        <button className="wb-iconbtn" title="Toggle theme" onClick={onToggleTheme}><Icon name={theme === "dark" ? "sun" : "moon"} size={16} /></button>
        <span className="wb-uid">{userId}</span>
        <button className="wb-iconbtn" title="Sign out" onClick={onSignOut}><Icon name="signout" size={16} /></button>
      </div>
    </div>
  );
}

function TabStrip({ tabs, activeId, onActivate, onClose, onNew }) {
  return (
    <div className="wb-tabstrip wb-scrollbar-thin">
      {tabs.map((t) => (
        <div key={t.id} className={cls("wb-tab", t.id === activeId && "active")} onClick={() => onActivate(t.id)} onAuxClick={(e) => { if (e.button === 1) onClose(t.id); }}>
          <span className="wb-tab-ico"><Icon name={TAB_ICON[t.kind] || "files"} size={13} /></span>
          <span className={cls("wb-tab-label", (t.kind === "sql" || t.kind === "table") && "mono")}>{t.title}{t.kind === "sql" ? ".sql" : ""}</span>
          <button className="wb-tab-close" title="Close" onClick={(e) => { e.stopPropagation(); onClose(t.id); }}><Icon name="x" size={13} /></button>
        </div>
      ))}
      <button className="wb-tab-new" title="New query" onClick={onNew}><Icon name="plus" size={15} /></button>
    </div>
  );
}
const TAB_ICON = { sql: "terminal", table: "table", transform: "transform", dashboard: "chart", job: "job", cred: "key", backend: "drive", commit: "database" };

function App() {
  const [authed, setAuthed] = useA(false);
  const [theme, setTheme] = useLocalStorage("wb_theme", "light");
  const [session, setSession] = useA({ enabled: true, connected: true });
  const [hasNewData, setHasNewData] = useA(false);

  const [tables, setTables] = useA(WB_TABLES);
  const [savedQueries, setSavedQueries] = useLocalStorage("wb_saved", WB_SAVED_QUERIES);

  const [tabs, setTabs] = useA([]);
  const [activeId, setActiveId] = useA(null);

  const [log, setLog] = useA([]);
  const [history, setHistory] = useLocalStorage("wb_history", []);
  const [dockOpen, setDockOpen] = useA(true);
  const [dockTab, setDockTab] = useA("console");
  const [paletteOpen, setPaletteOpen] = useA(false);
  const [activity, setActivity] = useA("explorer");

  const [sidebarW, setSidebarW] = useLocalStorage("wb_sidebar_w", 264);
  const [dockH, setDockH] = useLocalStorage("wb_dock_h", 250);
  const [clock, setClock] = useA(nowClock());

  const idRef = useAR(1);
  const newDataTimer = useAR(null);
  const uid = () => `t${idRef.current++}`;

  useAE(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useAE(() => { const iv = setInterval(() => setClock(nowClock()), 30000); return () => clearInterval(iv); }, []);
  useAE(() => {
    if (!session.enabled) { setSession((s) => ({ ...s, connected: false })); return; }
    const t = setTimeout(() => setSession((s) => ({ ...s, connected: true })), 500);
    return () => clearTimeout(t);
  }, [session.enabled]);

  const data = useAM(() => ({
    tables, transforms: WB_TRANSFORMS, jobs: WB_LOAD_JOBS,
    dashboards: WB_DASHBOARDS, savedQueries, credentials: WB_CREDENTIALS, backends: WB_BACKENDS,
  }), [tables, savedQueries]);
  const schema = useAM(() => wbBuildSchema(tables), [tables]);

  const focusTab = useAC((id) => setActiveId(id), []);

  const openTab = useAC((kind, payload) => {
    setTabs((prev) => {
      let key, title, tab;
      if (kind === "sql") {
        key = `sql:${uid()}`; title = (payload && payload.title) || "Untitled";
        tab = { id: uid(), kind: "sql", key, title, sql: (payload && payload.sql) || "", result: null };
      } else if (kind === "saved") {
        key = `saved:${payload.id}`; title = payload.name;
        tab = { id: uid(), kind: "sql", key, title, sql: payload.sql, savedId: payload.id, result: null };
      } else if (kind === "commit" || kind === "new-table") {
        key = "commit"; title = "Commit snapshot"; tab = { id: uid(), kind: "commit", key, title };
      } else if (kind === "new-transform") {
        key = `transform:new:${uid()}`; title = "New transform"; tab = { id: uid(), kind: "transform", key, title, item: null };
      } else if (kind === "new-job") {
        key = `job:new:${uid()}`; title = "New job"; tab = { id: uid(), kind: "job", key, title, item: null };
      } else {
        const idmap = { table: payload.name, transform: payload.id, dashboard: payload.id, job: payload.id, cred: payload.id, backend: payload.id };
        key = `${kind}:${idmap[kind]}`;
        title = payload.name || payload.title || payload.table || key;
        tab = { id: uid(), kind, key, title, item: payload };
      }
      const existing = prev.find((t) => t.key === key);
      if (existing) { setActiveId(existing.id); return prev; }
      setActiveId(tab.id);
      return [...prev, tab];
    });
  }, []);

  const closeTab = useAC((id) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      setActiveId((cur) => {
        if (cur !== id) return cur;
        if (next.length === 0) return null;
        return (next[idx] || next[idx - 1] || next[0]).id;
      });
      return next;
    });
  }, []);

  const setTabSql = useAC((id, text) => setTabs((prev) => prev.map((t) => t.id === id ? { ...t, sql: text } : t)), []);
  const setTabResult = useAC((id, res) => setTabs((prev) => prev.map((t) => t.id === id ? { ...t, result: res } : t)), []);

  const execute = useAC((sql, opts = {}) => {
    const source = opts.source || "query";
    setDockOpen(true);
    return new Promise((resolve) => {
      const disabled = !session.enabled;
      const ms = disabled ? 0 : Math.floor(8 + Math.random() * 90);
      const result = disabled
        ? { error: "DuckDB session is disabled — enable the toggle in the title bar to run queries." }
        : { ...wbRunQuery(sql, tables) };
      if (result.ms == null && !result.error) result.ms = ms;
      const entry = { id: uid(), sql, source, ms, result, when: nowClock() };
      setTimeout(() => {
        setLog((l) => [...l.slice(-199), entry]);
        if (!disabled) {
          setHistory((h) => {
            if (h[0] && h[0].sql.trim() === sql.trim()) return h;
            return [{ sql, rows: result.error ? null : result.rows.length, when: "just now" }, ...h].slice(0, 50);
          });
        }
        resolve({ ...result, ms });
      }, disabled ? 60 : 240 + Math.random() * 260);
    });
  }, [session.enabled, tables]);

  const saveQuery = useAC((name, sql, tabId) => {
    const id = "sq_" + Math.random().toString(36).slice(2, 7);
    setSavedQueries((prev) => [...prev, { id, name, sql }]);
    setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, title: name, key: `saved:${id}`, savedId: id } : t));
  }, []);

  const commitTable = useAC(({ name, uri }) => {
    setTables((prev) => {
      const base = { name, uri, backend: uri.startsWith("http-ds://") ? uri.slice(10).split("/")[0] : "primary-r2", format: "parquet (auto)", rows: 0, bytes: 0, partitions: 1, schema: [["id", "VARCHAR"]], snapshots: [{ id: "snap_new", msg: "initial load", uri, rows: 0, when: "just now", current: true }], sample: [] };
      const exists = prev.some((t) => t.name === name);
      return exists ? prev.map((t) => t.name === name ? { ...t, uri } : t) : [...prev, base];
    });
    setHasNewData(true);
    if (newDataTimer.current) clearTimeout(newDataTimer.current);
    newDataTimer.current = setTimeout(() => setHasNewData(false), 3000);
  }, []);

  const toggleSession = useAC(() => setSession((s) => ({ ...s, enabled: !s.enabled })), []);
  const toggleTheme = useAC(() => setTheme((t) => t === "dark" ? "light" : "dark"), []);
  const toggleDock = useAC(() => setDockOpen((o) => !o), []);

  const ctx = {
    data, schema, session, theme,
    execute, openTab, focusTab, setTabSql, setTabResult, saveQuery, commitTable,
    toggleSession, toggleTheme, toggleDock, openPalette: () => setPaletteOpen(true),
  };

  // keyboard: ⌘K palette, seed a first tab
  useAE(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); setPaletteOpen((o) => !o); }
      if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) { e.preventDefault(); setDockOpen((o) => !o); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useAE(() => {
    if (!authed || tabs.length) return;
    // seed: a table detail + a scratch query, active on the query
    openTab("table", WB_TABLES[0]);
    openTab("sql", { title: "scratch", sql: "SELECT category, SUM(amount) AS spent\nFROM transactions\nWHERE direction = 'debit'\nGROUP BY category\nORDER BY spent DESC;" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // resizers
  function startResizeX(e) {
    e.preventDefault();
    const move = (ev) => setSidebarW(Math.max(190, Math.min(460, ev.clientX - 48)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  function startResizeY(e) {
    e.preventDefault();
    const startY = e.clientY, startH = dockH;
    const move = (ev) => setDockH(Math.max(120, Math.min(window.innerHeight * 0.7, startH + (startY - ev.clientY))));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  if (!authed) return <Login onSignIn={() => setAuthed(true)} />;

  const activeTab = tabs.find((t) => t.id === activeId) || null;
  const activeKey = activeTab ? activeTab.key : null;

  return (
    <div className="wb-root">
      <TitleBar session={session} onToggleSession={toggleSession} theme={theme} onToggleTheme={toggleTheme}
        onPalette={() => setPaletteOpen(true)} userId="usr_8k2f" onSignOut={() => setAuthed(false)} hasNewData={hasNewData} />

      <div className="wb-body">
        <div className="wb-activity">
          <button className={cls("wb-act-btn", activity === "explorer" && "active")} title="Explorer" onClick={() => setActivity("explorer")}><Icon name="files" size={20} /></button>
          <button className="wb-act-btn" title="Search (⌘K)" onClick={() => setPaletteOpen(true)}><Icon name="search" size={20} /></button>
          <span className="wb-act-spacer" />
          <button className="wb-act-btn" title="Commit snapshot" onClick={() => openTab("commit")}><Icon name="database" size={20} /></button>
          <button className="wb-act-btn" title="Settings" onClick={() => openTab("backend", WB_BACKENDS[0])}><Icon name="settings" size={20} /></button>
        </div>

        <div className="wb-sidebar" style={{ width: sidebarW }}>
          <div className="wb-side-head"><span>Explorer</span>
            <button className="wb-iconbtn" style={{ width: 22, height: 22 }} title="New query" onClick={() => openTab("sql", { title: "Untitled", sql: "" })}><Icon name="plus" size={15} /></button>
          </div>
          <Explorer data={data} activeKey={activeKey} onOpen={openTab} onNewQuery={() => openTab("sql", { title: "Untitled", sql: "" })} />
        </div>
        <div className="wb-resizer" onPointerDown={startResizeX} />

        <div className="wb-main">
          <div className="wb-editor-area">
            <TabStrip tabs={tabs} activeId={activeId} onActivate={setActiveId} onClose={closeTab} onNew={() => openTab("sql", { title: "Untitled", sql: "" })} />
            <div className="wb-tabcontent wb-scrollbar-thin" key={activeId || "welcome"}>
              <TabContent tab={activeTab} ctx={ctx} />
            </div>
          </div>

          {dockOpen && (
            <>
              <div className="wb-resizer wb-resizer-h" onPointerDown={startResizeY} />
              <div className="wb-dock" style={{ height: dockH }}>
                <Console ctx={ctx} log={log} history={history} dockTab={dockTab} setDockTab={setDockTab}
                  onClear={() => setLog([])} onClose={() => setDockOpen(false)} />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="wb-statusbar">
        <span className="wb-status-item"><span className={cls("dot", session.connected ? "dot-success" : "dot-idle")} />{session.connected ? "DuckDB-WASM · connected" : session.enabled ? "connecting…" : "session off"}</span>
        <span className="wb-status-item mono">{wbFmtNum(tables.filter((t) => !t.failed).length)} tables</span>
        <span className="wb-status-item mono">{history.length} queries run</span>
        <span className="wb-status-spacer" />
        <button className="wb-status-btn" onClick={toggleDock} title="Toggle console (⌘J)"><Icon name="panel" size={13} />Console</button>
        <span className="wb-status-item mono">usr_8k2f</span>
        <span className="wb-status-item mono">{clock}</span>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} data={data} openTabs={tabs} ctx={ctx} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
