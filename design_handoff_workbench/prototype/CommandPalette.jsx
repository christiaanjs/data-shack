/* ============================================================================
   Data Shack Workbench — Command palette (⌘K)
   Searches saved queries, catalog tables, every managed object, open tabs,
   and global actions. A true global command bar.
   ============================================================================ */
const { useState: usePS, useEffect: usePE, useRef: usePR, useMemo: usePM } = React;

function CommandPalette({ open, onClose, data, openTabs, ctx }) {
  const [q, setQ] = usePS("");
  const [active, setActive] = usePS(0);
  const inputRef = usePR(null);

  usePE(() => { if (open) { setQ(""); setActive(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 20); } }, [open]);

  const items = usePM(() => {
    const out = [];
    // Actions
    out.push({ kind: "Action", icon: "plus", title: "New query", sub: "Open a blank SQL editor", run: () => ctx.openTab("sql", { title: "Untitled", sql: "" }) });
    out.push({ kind: "Action", icon: "database", title: "Commit snapshot", sub: "Register a storage file as a table", run: () => ctx.openTab("commit") });
    out.push({ kind: "Action", icon: ctx.session.enabled ? "x" : "play", title: ctx.session.enabled ? "Disable DuckDB session" : "Enable DuckDB session", sub: "Toggle the in-browser query engine", run: ctx.toggleSession });
    out.push({ kind: "Action", icon: "panel", title: "Toggle console panel", sub: "Show / hide the bottom dock", run: ctx.toggleDock });
    out.push({ kind: "Action", icon: ctx.theme === "dark" ? "sun" : "moon", title: ctx.theme === "dark" ? "Switch to light theme" : "Switch to dark theme", sub: "Change appearance", run: ctx.toggleTheme });
    // Saved queries
    data.savedQueries.forEach((s) => out.push({ kind: "Saved query", icon: "bookmark", title: s.name, sub: s.sql.replace(/\s+/g, " ").slice(0, 60), mono: false, run: () => ctx.openTab("saved", s) }));
    // Tables
    data.tables.forEach((t) => out.push({ kind: "Table", icon: "table", title: t.name, sub: t.uri, mono: true, run: () => ctx.openTab("table", t) }));
    // Transforms
    data.transforms.forEach((t) => out.push({ kind: "Transform", icon: "transform", title: t.name, sub: `→ ${t.out}`, mono: true, run: () => ctx.openTab("transform", t) }));
    // Dashboards
    data.dashboards.forEach((d) => out.push({ kind: "Dashboard", icon: "chart", title: d.title, sub: `/d/${d.slug}`, run: () => ctx.openTab("dashboard", d) }));
    // Load jobs
    data.jobs.forEach((j) => out.push({ kind: "Load job", icon: "job", title: j.table, sub: `${j.cred}${j.path}`, mono: true, run: () => ctx.openTab("job", j) }));
    // Credentials + backends
    data.credentials.forEach((c) => out.push({ kind: "Credential", icon: "key", title: c.name, sub: c.type, mono: true, run: () => ctx.openTab("cred", c) }));
    data.backends.forEach((b) => out.push({ kind: "Backend", icon: "drive", title: b.name, sub: b.type, mono: true, run: () => ctx.openTab("backend", b) }));
    // Open tabs (jump to)
    openTabs.forEach((t) => out.push({ kind: "Go to tab", icon: t.kind === "sql" ? "terminal" : "files", title: t.title, sub: "Switch to open tab", run: () => ctx.focusTab(t.id) }));
    return out;
  }, [data, openTabs, ctx.session.enabled, ctx.theme]);

  const filtered = usePM(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((it) => (it.title + " " + (it.sub || "") + " " + it.kind).toLowerCase().includes(s));
  }, [q, items]);

  usePE(() => { setActive((a) => Math.min(a, Math.max(0, filtered.length - 1))); }, [filtered.length]);

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const it = filtered[active]; if (it) { it.run(); onClose(); } }
  }

  if (!open) return null;

  // group while preserving flat index for nav
  const groups = [];
  let flat = 0;
  filtered.forEach((it) => {
    let g = groups.find((x) => x.kind === it.kind);
    if (!g) { g = { kind: it.kind, items: [] }; groups.push(g); }
    g.items.push({ ...it, _i: flat++ });
  });

  return (
    <div className="wb-cmdk-scrim" onMouseDown={onClose}>
      <div className="wb-cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <div className="wb-cmdk-input">
          <Icon name="search" size={18} style={{ color: "color-mix(in oklch,var(--color-base-content) 45%,transparent)" }} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Search tables, saved queries, actions…" />
          <span className="wb-kbd">esc</span>
        </div>
        <div className="wb-cmdk-list wb-scrollbar-thin">
          {filtered.length === 0 && <div className="wb-cmdk-empty">No matches for “{q}”.</div>}
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="wb-cmdk-group">{g.kind}</div>
              {g.items.map((it) => (
                <div key={it._i} className={cls("wb-cmdk-item", it._i === active && "active")}
                  onMouseEnter={() => setActive(it._i)} onClick={() => { it.run(); onClose(); }}>
                  <span className="wb-ci-ico"><Icon name={it.icon} size={16} /></span>
                  <span className="wb-ci-main">
                    <span className={cls("wb-ci-title", it.mono && "mono")}>{it.title}</span>
                    {it.sub && <span className="wb-ci-sub">{it.sub}</span>}
                  </span>
                  <span className="wb-ci-kind">{it.kind}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="wb-cmdk-foot">
          <span className="row" style={{ gap: 5 }}><span className="wb-kbd">↑</span><span className="wb-kbd">↓</span> navigate</span>
          <span className="row" style={{ gap: 5 }}><span className="wb-kbd">↵</span> open</span>
          <span style={{ flex: 1 }} />
          <span>{filtered.length} result{filtered.length === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
  );
}

window.CommandPalette = CommandPalette;
