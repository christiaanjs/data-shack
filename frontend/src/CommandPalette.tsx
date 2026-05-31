import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  BookmarkIcon,
  ChartIcon,
  DatabaseIcon,
  DriveIcon,
  FilesIcon,
  JobIcon,
  KeyIcon,
  MoonIcon,
  PanelIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
  TableIcon,
  TransformIcon,
  XIcon,
} from "./wbIcons.tsx";
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
