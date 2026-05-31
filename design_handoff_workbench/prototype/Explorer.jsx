/* ============================================================================
   Data Shack Workbench — Explorer (left object tree)
   Lists every object the warehouse manages. Clicking a node opens it as a tab.
   ============================================================================ */
const { useState: useStateEx } = React;

function TreeGroup({ icon, label, count, defaultOpen = false, onAdd, children }) {
  const [open, setOpen] = useStateEx(defaultOpen);
  return (
    <div className="wb-tree-group">
      <button className={cls("wb-group-head", open && "open")} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevron" size={12} className="wb-chev" />
        <Icon name={icon} size={13} style={{ color: "color-mix(in oklch, var(--color-base-content) 50%, transparent)" }} />
        <span>{label}</span>
        <span className="wb-group-count">{count}</span>
        {onAdd && (
          <span className="wb-group-add wb-iconbtn" style={{ width: 18, height: 18 }} title={`New ${label.toLowerCase()}`}
            onClick={(e) => { e.stopPropagation(); onAdd(); }}>
            <Icon name="plus" size={13} />
          </span>
        )}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

function TableNode({ t, active, onOpen }) {
  const [expanded, setExpanded] = useStateEx(false);
  return (
    <div>
      <button className={cls("wb-node", active && "active")} onClick={() => onOpen("table", t)} style={{ position: "relative" }}>
        <span className={cls("wb-node-expand", expanded && "open")} onClick={(e) => { e.stopPropagation(); if (!t.failed) setExpanded((v) => !v); }}>
          {!t.failed && t.schema.length > 0 && <Icon name="chevron" size={11} className="wb-chev" />}
        </span>
        <span className="wb-node-ico"><Icon name="table" size={14} /></span>
        <span className="wb-node-label">{t.name}</span>
        {t.failed
          ? <Dot state="idle" />
          : <span className="wb-node-meta">{wbFmtNum(t.rows)}</span>}
      </button>
      {expanded && t.schema.map(([col, type]) => (
        <div key={col} className="wb-node wb-node-col" style={{ cursor: "default" }}>
          <span className="wb-node-label">{col}</span>
          <span className="wb-coltype">{type}</span>
        </div>
      ))}
    </div>
  );
}

function SimpleNode({ icon, label, meta, active, onOpen, dotState }) {
  return (
    <button className={cls("wb-node", active && "active")} onClick={onOpen} style={{ position: "relative" }}>
      <span className="wb-node-expand" />
      <span className="wb-node-ico"><Icon name={icon} size={14} /></span>
      <span className="wb-node-label">{label}</span>
      {dotState && <Dot state={dotState} />}
      {meta && <span className="wb-node-meta">{meta}</span>}
    </button>
  );
}

function Explorer({ data, activeKey, onOpen, onNewQuery }) {
  const { tables, transforms, jobs, dashboards, savedQueries } = data;
  return (
    <div className="wb-side-scroll wb-scrollbar-thin">
      <TreeGroup icon="database" label="Catalog" count={tables.length} defaultOpen onAdd={() => onOpen("new-table")}>
        {tables.map((t) => (
          <TableNode key={t.name} t={t} active={activeKey === `table:${t.name}`} onOpen={onOpen} />
        ))}
      </TreeGroup>

      <TreeGroup icon="transform" label="Transforms" count={transforms.length} defaultOpen onAdd={() => onOpen("new-transform")}>
        {transforms.map((tr) => (
          <SimpleNode key={tr.id} icon="transform" label={tr.name}
            dotState={tr.status === "done" ? "success" : tr.status === "failed" ? "idle" : "idle"}
            active={activeKey === `transform:${tr.id}`} onOpen={() => onOpen("transform", tr)} />
        ))}
      </TreeGroup>

      <TreeGroup icon="bookmark" label="Saved Queries" count={savedQueries.length} defaultOpen onAdd={onNewQuery}>
        {savedQueries.map((q) => (
          <SimpleNode key={q.id} icon="bookmark" label={q.name}
            active={activeKey === `saved:${q.id}`} onOpen={() => onOpen("saved", q)} />
        ))}
      </TreeGroup>

      <TreeGroup icon="job" label="Load Jobs" count={jobs.length} onAdd={() => onOpen("new-job")}>
        {jobs.map((j) => (
          <SimpleNode key={j.id} icon="job" label={j.table} meta={j.last === "fail" ? "" : null}
            dotState={j.last === "ok" ? "success" : "idle"}
            active={activeKey === `job:${j.id}`} onOpen={() => onOpen("job", j)} />
        ))}
      </TreeGroup>

      <TreeGroup icon="chart" label="Dashboards" count={dashboards.length}>
        {dashboards.map((d) => (
          <SimpleNode key={d.id} icon="chart" label={d.title}
            active={activeKey === `dashboard:${d.id}`} onOpen={() => onOpen("dashboard", d)} />
        ))}
      </TreeGroup>
    </div>
  );
}

/* Settings view — configuration objects, opened from the gear in the rail. */
function SettingsTree({ data, activeKey, onOpen }) {
  const { credentials, backends } = data;
  return (
    <div className="wb-side-scroll wb-scrollbar-thin">
      <TreeGroup icon="key" label="Credentials" count={credentials.length} defaultOpen>
        {credentials.map((c) => (
          <SimpleNode key={c.id} icon="key" label={c.name} meta={c.type === "http" ? "http" : null}
            active={activeKey === `cred:${c.id}`} onOpen={() => onOpen("cred", c)} />
        ))}
      </TreeGroup>

      <TreeGroup icon="drive" label="Storage Backends" count={backends.length} defaultOpen>
        {backends.map((b) => (
          <SimpleNode key={b.id} icon="drive" label={b.name}
            active={activeKey === `backend:${b.id}`} onOpen={() => onOpen("backend", b)} />
        ))}
      </TreeGroup>
    </div>
  );
}

Object.assign(window, { Explorer, SettingsTree });
