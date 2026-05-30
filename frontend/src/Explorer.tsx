import { useState } from "preact/hooks";
import type { CatalogTableWithSnapshot } from "./catalogViews.ts";
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

// ── Inline SVG icons (Lucide paths) ──────────────────────────────────────────

function Svg({
  size,
  children,
  class: cls,
}: { size: number; children: preact.ComponentChildren; class?: string }) {
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
      class={cls}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function ChevronIcon({ size, class: cls }: { size: number; class?: string }) {
  return (
    <Svg size={size} class={cls}>
      <path d="m9 18 6-6-6-6" />
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
function TransformIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
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
function JobIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </Svg>
  );
}
function ChartIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <path d="M3 3v18h18" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </Svg>
  );
}
function KeyIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </Svg>
  );
}
function DriveIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <line x1="22" x2="2" y1="12" y2="12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      <line x1="6" x2="6.01" y1="16" y2="16" />
      <line x1="10" x2="10.01" y1="16" y2="16" />
    </Svg>
  );
}
function PlusIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Svg>
  );
}
