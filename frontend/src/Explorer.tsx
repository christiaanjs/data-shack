import { useState } from "preact/hooks";
import type { CatalogTableWithSnapshot } from "./catalogViews.ts";
import {
  BookmarkIcon,
  ChartIcon,
  ChevronIcon,
  DatabaseIcon,
  DriveIcon,
  JobIcon,
  KeyIcon,
  PlusIcon,
  TableIcon,
  TransformIcon,
} from "./wbIcons.tsx";
import type { WbData } from "./workbench-types.ts";

interface TreeGroupProps {
  icon: preact.ComponentChildren;
  label: string;
  count: number;
  defaultOpen?: boolean;
  onAdd?: () => void;
  children: preact.ComponentChildren;
}

function TreeGroup({ icon, label, count, defaultOpen = false, onAdd, children }: TreeGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div class="wb-tree-group">
      <button
        type="button"
        class={`wb-group-head${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronIcon class="wb-chev" size={12} />
        <span
          style={{
            color: "color-mix(in oklch, var(--color-base-content) 50%, transparent)",
            display: "flex",
          }}
        >
          {icon}
        </span>
        <span>{label}</span>
        <span class="wb-group-count">{count}</span>
        {onAdd && (
          <button
            type="button"
            class="wb-group-add wb-iconbtn"
            style={{ width: 18, height: 18 }}
            title={`New ${label.toLowerCase()}`}
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
          >
            <PlusIcon size={13} />
          </button>
        )}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

interface TableNodeProps {
  table: CatalogTableWithSnapshot;
  active: boolean;
  onOpen: () => void;
}

function TableNode({ table, active, onOpen }: TableNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const failed = !table.latestSnapshot;
  return (
    <div>
      <button type="button" class={`wb-node${active ? " active" : ""}`} onClick={onOpen}>
        <button
          type="button"
          class={`wb-node-expand${expanded ? " open" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!failed) setExpanded((v) => !v);
          }}
        >
          {!failed && <ChevronIcon class="wb-chev" size={11} />}
        </button>
        <span class="wb-node-ico">
          <TableIcon size={14} />
        </span>
        <span class="wb-node-label">{table.name}</span>
        {failed ? <span class="wb-dot wb-dot-idle" /> : <span class="wb-node-meta">—</span>}
      </button>
      {expanded && (
        <div class="wb-node wb-node-col" style={{ cursor: "default" }}>
          <span
            class="wb-node-label"
            style={{
              color: "color-mix(in oklch, var(--color-base-content) 50%, transparent)",
              fontStyle: "italic",
            }}
          >
            {table.latestSnapshot?.format ?? "—"}
          </span>
        </div>
      )}
    </div>
  );
}

interface SimpleNodeProps {
  icon: preact.ComponentChildren;
  label: string;
  meta?: string | null;
  active: boolean;
  onOpen: () => void;
  dotState?: "success" | "idle" | null;
}

function SimpleNode({ icon, label, meta, active, onOpen, dotState }: SimpleNodeProps) {
  return (
    <button type="button" class={`wb-node${active ? " active" : ""}`} onClick={onOpen}>
      <span class="wb-node-expand" />
      <span class="wb-node-ico">{icon}</span>
      <span class="wb-node-label">{label}</span>
      {dotState && <span class={`wb-dot wb-dot-${dotState}`} />}
      {meta && <span class="wb-node-meta">{meta}</span>}
    </button>
  );
}

interface ExplorerProps {
  data: WbData;
  activeKey: string | null;
  onOpen: (kind: string, item?: unknown) => void;
  onNewQuery: () => void;
}

export function Explorer({ data, activeKey, onOpen, onNewQuery }: ExplorerProps) {
  const { tables, transforms, jobs, dashboards, savedQueries, credentials, backends } = data;
  return (
    <div class="wb-side-scroll wb-scrollbar-thin">
      <TreeGroup
        icon={<DatabaseIcon size={13} />}
        label="Catalog"
        count={tables.length}
        defaultOpen
        onAdd={() => onOpen("commit")}
      >
        {tables.map((t) => (
          <TableNode
            key={t.name}
            table={t}
            active={activeKey === `table:${t.name}`}
            onOpen={() => onOpen("table", t)}
          />
        ))}
      </TreeGroup>

      <TreeGroup
        icon={<TransformIcon size={13} />}
        label="Transforms"
        count={transforms.length}
        defaultOpen
        onAdd={() => onOpen("new-transform")}
      >
        {transforms.map((tr) => (
          <SimpleNode
            key={tr.id}
            icon={<TransformIcon size={14} />}
            label={tr.name ?? tr.output_table}
            dotState={tr.status === "done" ? "success" : "idle"}
            active={activeKey === `transform:${tr.id}`}
            onOpen={() => onOpen("transform", tr)}
          />
        ))}
      </TreeGroup>

      <TreeGroup
        icon={<BookmarkIcon size={13} />}
        label="Saved Queries"
        count={savedQueries.length}
        defaultOpen
        onAdd={onNewQuery}
      >
        {savedQueries.map((q) => (
          <SimpleNode
            key={q.id}
            icon={<BookmarkIcon size={14} />}
            label={q.name}
            active={activeKey === `saved:${q.id}`}
            onOpen={() => onOpen("saved", q)}
          />
        ))}
      </TreeGroup>

      <TreeGroup
        icon={<JobIcon size={13} />}
        label="Load Jobs"
        count={jobs.length}
        onAdd={() => onOpen("new-job")}
      >
        {jobs.map((j) => (
          <SimpleNode
            key={j.id}
            icon={<JobIcon size={14} />}
            label={j.output_table ?? j.id}
            dotState={j.last_error ? "idle" : j.last_run_at ? "success" : "idle"}
            active={activeKey === `job:${j.id}`}
            onOpen={() => onOpen("job", j)}
          />
        ))}
      </TreeGroup>

      <TreeGroup icon={<ChartIcon size={13} />} label="Dashboards" count={dashboards.length}>
        {dashboards.map((d) => (
          <SimpleNode
            key={d.id}
            icon={<ChartIcon size={14} />}
            label={d.title}
            active={activeKey === `dashboard:${d.id}`}
            onOpen={() => onOpen("dashboard", d)}
          />
        ))}
      </TreeGroup>

      <TreeGroup icon={<KeyIcon size={13} />} label="Credentials" count={credentials.length}>
        {credentials.map((c) => (
          <SimpleNode
            key={c.id}
            icon={<KeyIcon size={14} />}
            label={c.name}
            meta={c.type === "http" ? "http" : null}
            active={activeKey === `cred:${c.id}`}
            onOpen={() => onOpen("cred", c)}
          />
        ))}
      </TreeGroup>

      <TreeGroup icon={<DriveIcon size={13} />} label="Storage Backends" count={backends.length}>
        {backends.map((b) => (
          <SimpleNode
            key={b.id}
            icon={<DriveIcon size={14} />}
            label={b.name}
            active={activeKey === `backend:${b.id}`}
            onOpen={() => onOpen("backend", b)}
          />
        ))}
      </TreeGroup>
    </div>
  );
}
