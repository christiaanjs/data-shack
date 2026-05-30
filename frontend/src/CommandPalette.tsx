import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { WbCtx, WbData, WbTab } from "./workbench-types.ts";

interface PaletteItem {
  kind: string;
  icon: preact.ComponentChildren;
  title: string;
  sub?: string;
  mono?: boolean;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  data: WbData;
  openTabs: WbTab[];
  ctx: WbCtx;
}

export function CommandPalette({ open, onClose, data, openTabs, ctx }: CommandPaletteProps) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [
      {
        kind: "Action",
        icon: <PlusIcon size={16} />,
        title: "New query",
        sub: "Open a blank SQL editor",
        run: () => ctx.openTab("sql", { title: "Untitled", sql: "" }),
      },
      {
        kind: "Action",
        icon: <DatabaseIcon size={16} />,
        title: "Commit snapshot",
        sub: "Register a storage file as a table",
        run: () => ctx.openTab("commit"),
      },
      {
        kind: "Action",
        icon: ctx.session.enabled ? <XIcon size={16} /> : <PlayIcon size={16} />,
        title: ctx.session.enabled ? "Disable DuckDB session" : "Enable DuckDB session",
        sub: "Toggle the in-browser query engine",
        run: ctx.toggleSession,
      },
      {
        kind: "Action",
        icon: <PanelIcon size={16} />,
        title: "Toggle console panel",
        sub: "Show / hide the bottom dock",
        run: ctx.toggleDock,
      },
      {
        kind: "Action",
        icon: ctx.theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />,
        title: ctx.theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        sub: "Change appearance",
        run: ctx.toggleTheme,
      },
      ...data.savedQueries.map((s) => ({
        kind: "Saved query",
        icon: <BookmarkIcon size={16} />,
        title: s.name,
        sub: s.sql.replace(/\s+/g, " ").slice(0, 60),
        run: () => ctx.openTab("saved", s),
      })),
      ...data.tables.map((t) => ({
        kind: "Table",
        icon: <TableIcon size={16} />,
        title: t.name,
        sub: t.latestSnapshot?.uri ?? "—",
        mono: true,
        run: () => ctx.openTab("table", t),
      })),
      ...data.transforms.map((t) => ({
        kind: "Transform",
        icon: <TransformIcon size={16} />,
        title: t.name ?? t.output_table,
        sub: `→ ${t.output_table}`,
        mono: true,
        run: () => ctx.openTab("transform", t),
      })),
      ...data.dashboards.map((d) => ({
        kind: "Dashboard",
        icon: <ChartIcon size={16} />,
        title: d.title,
        sub: d.slug ? `/d/${d.slug}` : d.id,
        run: () => ctx.openTab("dashboard", d),
      })),
      ...data.jobs.map((j) => ({
        kind: "Load job",
        icon: <JobIcon size={16} />,
        title: j.output_table ?? j.id,
        mono: true,
        run: () => ctx.openTab("job", j),
      })),
      ...data.credentials.map((c) => ({
        kind: "Credential",
        icon: <KeyIcon size={16} />,
        title: c.name,
        sub: c.type,
        mono: true,
        run: () => ctx.openTab("cred", c),
      })),
      ...data.backends.map((b) => ({
        kind: "Backend",
        icon: <DriveIcon size={16} />,
        title: b.name,
        run: () => ctx.openTab("backend", b),
      })),
      ...openTabs.map((tab) => ({
        kind: "Go to tab",
        icon: <FilesIcon size={16} />,
        title: tab.title,
        sub: "Switch to open tab",
        run: () => ctx.focusTab(tab.id),
      })),
    ];
    return out;
  }, [data, openTabs, ctx]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((it) => `${it.title} ${it.sub ?? ""} ${it.kind}`.toLowerCase().includes(s));
  }, [q, items]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = filtered[active];
      if (it) {
        it.run();
        onClose();
      }
    }
  }

  if (!open) return null;

  const groups: { kind: string; items: (PaletteItem & { _i: number })[] }[] = [];
  let flat = 0;
  for (const it of filtered) {
    let g = groups.find((x) => x.kind === it.kind);
    if (!g) {
      g = { kind: it.kind, items: [] };
      groups.push(g);
    }
    g.items.push({ ...it, _i: flat++ });
  }

  return (
    <div class="wb-cmdk-scrim" onMouseDown={onClose}>
      <div class="wb-cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <div class="wb-cmdk-input">
          <SearchIcon size={18} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={onKey}
            placeholder="Search tables, saved queries, actions…"
          />
          <span class="wb-kbd">esc</span>
        </div>
        <div class="wb-cmdk-list wb-scrollbar-thin">
          {filtered.length === 0 && <div class="wb-cmdk-empty">No matches for "{q}".</div>}
          {groups.map((g) => (
            <div key={g.kind}>
              <div class="wb-cmdk-group">{g.kind}</div>
              {g.items.map((it) => (
                <button
                  type="button"
                  key={it._i}
                  class={`wb-cmdk-item${it._i === active ? " active" : ""}`}
                  onMouseEnter={() => setActive(it._i)}
                  onClick={() => {
                    it.run();
                    onClose();
                  }}
                >
                  <span class="wb-ci-ico">{it.icon}</span>
                  <span class="wb-ci-main">
                    <span class={`wb-ci-title${it.mono ? " mono" : ""}`}>{it.title}</span>
                    {it.sub && <span class="wb-ci-sub">{it.sub}</span>}
                  </span>
                  <span class="wb-ci-kind">{it.kind}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div class="wb-cmdk-foot">
          <span style={{ display: "flex", gap: 5 }}>
            <span class="wb-kbd">↑</span>
            <span class="wb-kbd">↓</span> navigate
          </span>
          <span style={{ display: "flex", gap: 5 }}>
            <span class="wb-kbd">↵</span> open
          </span>
          <span style={{ flex: 1 }} />
          <span>
            {filtered.length} result{filtered.length === 1 ? "" : "s"}
          </span>
        </div>
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
function SearchIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
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
function DatabaseIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </Svg>
  );
}
function PlayIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </Svg>
  );
}
function XIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  );
}
function PanelIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 15h18" />
    </Svg>
  );
}
function SunIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </Svg>
  );
}
function MoonIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
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
function JobIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
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
function FilesIcon({ size }: { size: number }) {
  return (
    <Svg size={size}>
      <path d="M20 7h-3a2 2 0 0 1-2-2V2" />
      <path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z" />
      <path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8" />
    </Svg>
  );
}
