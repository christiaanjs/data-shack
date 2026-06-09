/* ============================================================================
   Data Shack Workbench — bottom dock: Console (REPL + executed-SQL log)
   and History. The console logs every query run anywhere in the app and lets
   you type SQL directly; ↑/↓ walk persisted command history.
   ============================================================================ */
const { useState: useCS, useRef: useCR, useEffect: useCE } = React;

function logLine(entry) {
  if (entry.result && entry.result.error) {
    return <div className="wb-con-out err">✕ {entry.result.error}</div>;
  }
  const r = entry.result;
  if (!r) return <div className="wb-con-out ok">→ ok · {entry.ms} ms</div>;
  return (
    <div className="wb-con-out ok">
      → {r.rows.length} row{r.rows.length === 1 ? "" : "s"} · {r.columns.length} cols · <span className="wb-con-time">{entry.ms} ms</span>
      {r.rows[0] && <div className="wb-con-minirow">  {r.columns.join(" │ ")}</div>}
    </div>
  );
}

function Console({ ctx, log, history, dockTab, setDockTab, onClear, onClose }) {
  const [input, setInput] = useCS("");
  const [histIdx, setHistIdx] = useCS(-1);
  const logRef = useCR(null);

  useCE(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log.length, dockTab]);

  function submit() {
    const sql = input.trim();
    if (!sql) return;
    ctx.execute(sql, { source: "console" });
    setInput(""); setHistIdx(-1);
  }
  function onKey(e) {
    if (e.key === "Enter") { e.preventDefault(); submit(); return; }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const ni = Math.min(histIdx + 1, history.length - 1);
      if (ni >= 0 && history[ni]) { setHistIdx(ni); setInput(history[ni].sql.replace(/\s+/g, " ")); }
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const ni = histIdx - 1;
      if (ni < 0) { setHistIdx(-1); setInput(""); }
      else { setHistIdx(ni); setInput(history[ni].sql.replace(/\s+/g, " ")); }
    }
  }

  return (
    <>
      <div className="wb-dock-head">
        <button className={cls("wb-dock-tab", dockTab === "console" && "active")} onClick={() => setDockTab("console")}>
          <Icon name="terminal" size={13} />Console
        </button>
        <button className={cls("wb-dock-tab", dockTab === "history" && "active")} onClick={() => setDockTab("history")}>
          <Icon name="history" size={13} />History<span className="wb-badge-n">{history.length}</span>
        </button>
        <span className="wb-dock-spacer" />
        <div className="wb-dock-tools">
          <button className="wb-iconbtn" title="Clear" onClick={onClear}><Icon name="refresh" size={14} /></button>
          <button className="wb-iconbtn" title="Hide panel" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>
      </div>
      <div className="wb-dock-body">
        {dockTab === "console" ? (
          <div className="wb-console">
            <div className="wb-con-log wb-scrollbar-thin" ref={logRef}>
              {log.length === 0 && <div className="wb-con-out" style={{ paddingLeft: 14 }}>DuckDB-WASM session ready. Type SQL below or run a query from any tab.</div>}
              {log.map((e) => (
                <div className="wb-con-entry" key={e.id}>
                  <div className="wb-con-cmd">
                    <span className="wb-con-prompt">{e.source === "console" ? "dshk>" : "·"}</span>
                    <span className="wb-con-sql">{e.sql.replace(/\s+/g, " ").slice(0, 240)}{e.source !== "console" && <span className="wb-con-time">  ({e.source})</span>}</span>
                  </div>
                  {logLine(e)}
                </div>
              ))}
            </div>
            <div className="wb-con-input">
              <span className="wb-con-prompt">dshk&gt;</span>
              <input value={input} placeholder="SELECT … (↑ history · ↵ run)" spellCheck={false}
                onChange={(e) => setInput(e.target.value)} onKeyDown={onKey}
                disabled={!ctx.session.enabled} />
              {!ctx.session.enabled && <span className="wb-con-hint" style={{ color: "var(--color-warning)" }}>session disabled</span>}
            </div>
          </div>
        ) : (
          <div className="wb-hist wb-scrollbar-thin">
            {history.length === 0 && <div className="wb-con-out" style={{ padding: 14 }}>No queries yet. Run something to build history.</div>}
            {history.map((h, i) => (
              <div className="wb-hist-row" key={i} onClick={() => ctx.openTab("sql", { title: "History", sql: h.sql })}>
                <span className="wb-hist-sql">{h.sql.replace(/\s+/g, " ")}</span>
                <span className="wb-hist-meta">{h.rows != null ? `${h.rows} rows` : "err"} · {h.when}</span>
                <span className="wb-hist-actions">
                  <button className="wb-iconbtn" title="Run in console" style={{ width: 22, height: 22 }}
                    onClick={(e) => { e.stopPropagation(); ctx.execute(h.sql, { source: "console" }); setDockTab("console"); }}>
                    <Icon name="play" size={12} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

window.Console = Console;
