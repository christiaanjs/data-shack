import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CommandPalette } from "./CommandPalette.tsx";
import { ConsoleDock } from "./ConsoleDock.tsx";
import { Explorer, SettingsTree } from "./Explorer.tsx";
import { TabContent } from "./TabViews.tsx";
import { clearTokens, getAccessToken, getValidToken, handleCallback, startLogin } from "./auth.ts";
import {
  type CatalogTableWithSnapshot,
  fetchCatalogMetadata,
  registerCatalogViews,
} from "./catalogViews.ts";
import { type CatalogCommitEvent, type CatalogConnection, connectCatalogWs } from "./catalogWs.ts";
import { initDuckDB, runQuery } from "./duckdb.ts";
import { resolveStorageUris } from "./resolveQuery.ts";
import { type JobEvent, type SessionConnection, connectSession } from "./sessionWs.ts";
import {
  ChartIcon,
  DatabaseIcon,
  FilesIcon,
  LogOutIcon,
  MoonIcon,
  PanelIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  TableIcon,
  TerminalIcon,
  TransformIcon,
  XIcon,
} from "./wbIcons.tsx";
import type {
  HistoryEntry,
  LogEntry,
  QueryResult,
  SavedQuery,
  WbBackend,
  WbCredential,
  WbCtx,
  WbDashboard,
  WbData,
  WbJob,
  WbTab,
  WbTransform,
} from "./workbench-types.ts";

const WORKER_BASE = import.meta.env.VITE_WORKER_URL ?? "";
const DEV_TOKEN = import.meta.env.VITE_DEV_TOKEN as string | undefined;

async function getAuthHeaders(): Promise<Record<string, string>> {
  if (DEV_TOKEN) return { "X-Dev-Token": DEV_TOKEN };
  const token = await getValidToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

let tabCounter = 1;
function uid() {
  return `t${tabCounter++}`;
}

function nowClock() {
  return new Date().toLocaleTimeString("en-NZ", { hour12: false });
}

function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [val, setVal] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s != null ? (JSON.parse(s) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setVal((prev) => {
        const next = typeof v === "function" ? (v as (prev: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {}
        return next;
      });
    },
    [key],
  );
  return [val, set];
}

export function WorkbenchShell() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionConnected, setSessionConnected] = useState(false);

  const [theme, setTheme] = useLocalStorage("wb_theme", "light");

  const [sessionEnabled, setSessionEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("duckdb-session-enabled");
    if (stored !== null) return stored === "true";
    return !window.matchMedia("(pointer: coarse), (max-width: 640px)").matches;
  });
  const sessionEnabledRef = useRef(sessionEnabled);
  sessionEnabledRef.current = sessionEnabled;

  const [catalogTables, setCatalogTables] = useState<CatalogTableWithSnapshot[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [, setCatalogFailed] = useState<string[]>([]);
  const [hasNewData, setHasNewData] = useState(false);
  const newDataTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [, setDbReady] = useState(false);
  const [, setDbError] = useState<string | null>(null);

  const catalogReadyRef = useRef<Promise<void>>(Promise.resolve());
  const sessionRef = useRef<SessionConnection | null>(null);
  const catalogWsRef = useRef<CatalogConnection | null>(null);
  const jobEventListenerRef = useRef<((ev: JobEvent) => void) | null>(null);
  const dashboardCommitListenerRef = useRef<((ev: CatalogCommitEvent) => void) | null>(null);
  const getCatalogReady = useCallback(() => catalogReadyRef.current, []);

  // ── Workbench state ────────────────────────────────────────────────────────
  const [activity, setActivity] = useState<"explorer" | "settings">("explorer");
  const [tabs, setTabs] = useState<WbTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [history, setHistory] = useLocalStorage<HistoryEntry[]>("wb_history", []);
  const [dockOpen, setDockOpen] = useLocalStorage("wb_dock_open", true);
  const [dockTab, setDockTab] = useState<"console" | "history">("console");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarW, setSidebarW] = useLocalStorage("wb_sidebar_w", 264);
  const [dockH, setDockH] = useLocalStorage("wb_dock_h", 250);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);

  // External data lists for the explorer
  const [transforms, setTransforms] = useState<WbTransform[]>([]);
  const [jobs, setJobs] = useState<WbJob[]>([]);
  const [dashboards, setDashboards] = useState<WbDashboard[]>([]);
  const [credentials, setCredentials] = useState<WbCredential[]>([]);
  const [backends, setBackends] = useState<WbBackend[]>([]);

  // Apply theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // ── Sidebar resize ────────────────────────────────────────────────────────
  const sidebarResizing = useRef(false);
  function startSidebarResize(e: MouseEvent) {
    sidebarResizing.current = true;
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      if (!sidebarResizing.current) return;
      setSidebarW(Math.min(460, Math.max(190, ev.clientX - 48)));
    };
    const onUp = () => {
      sidebarResizing.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── Dock resize ────────────────────────────────────────────────────────────
  const dockResizing = useRef(false);
  function startDockResize(e: MouseEvent) {
    dockResizing.current = true;
    e.preventDefault();
    const bodyH = document.documentElement.clientHeight;
    const onMove = (ev: MouseEvent) => {
      if (!dockResizing.current) return;
      setDockH(Math.min(Math.floor(bodyH * 0.7), Math.max(120, bodyH - ev.clientY - 24)));
    };
    const onUp = () => {
      dockResizing.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
      if (mod && e.key === "j") {
        e.preventDefault();
        setDockOpen((v) => !v);
      }
      if (e.key === "Escape") setPaletteOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setDockOpen]);

  // ── Auth ─────────────────────────────────────────────────────────────────

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only
  useEffect(() => {
    if (DEV_TOKEN) {
      setAuthed(true);
      return;
    }
    const params = new URLSearchParams(location.search);
    if (location.pathname === "/callback") {
      handleCallback(params)
        .then(() => {
          history.length;
          setAuthed(true);
        })
        .catch((err: unknown) => {
          setCallbackError(err instanceof Error ? err.message : "Auth failed");
          setAuthed(false);
        });
      return;
    }
    setAuthed(!!getAccessToken());
  }, []);

  useEffect(() => {
    if (!authed) return;
    (async () => {
      const headers = await getAuthHeaders();
      if (!DEV_TOKEN && !headers.Authorization) {
        clearTokens();
        setAuthed(false);
        return;
      }
      const res = await fetch(`${WORKER_BASE}/me`, { headers });
      if (res.status === 401) {
        clearTokens();
        setAuthed(false);
        return;
      }
      if (res.ok) {
        const d = (await res.json()) as { userId: string };
        setUserId(d.userId);
      }
    })().catch(() => {});
  }, [authed]);

  // ── Load explorer data ─────────────────────────────────────────────────────

  const loadExplorerData = useCallback(async () => {
    if (!authed) return;
    try {
      const headers = await getAuthHeaders();
      const [tsRes, jRes, dRes, cRes, bRes, sqRes] = await Promise.allSettled([
        fetch(`${WORKER_BASE}/api/transform-jobs`, { headers }).then(
          (r) => r.json() as Promise<{ jobs: WbTransform[] }>,
        ),
        fetch(`${WORKER_BASE}/api/load-jobs`, { headers }).then(
          (r) => r.json() as Promise<{ jobs: WbJob[] }>,
        ),
        fetch(`${WORKER_BASE}/api/dashboards`, { headers }).then(
          (r) => r.json() as Promise<{ dashboards: WbDashboard[] }>,
        ),
        fetch(`${WORKER_BASE}/api/credentials`, { headers }).then(
          (r) => r.json() as Promise<{ credentials: WbCredential[] }>,
        ),
        fetch(`${WORKER_BASE}/api/storage-backends`, { headers }).then(
          (r) => r.json() as Promise<{ backends: WbBackend[] }>,
        ),
        fetch(`${WORKER_BASE}/api/saved-queries`, { headers }).then(
          (r) => r.json() as Promise<{ queries: SavedQuery[] }>,
        ),
      ]);
      if (tsRes.status === "fulfilled") setTransforms(tsRes.value.jobs ?? []);
      if (jRes.status === "fulfilled") setJobs(jRes.value.jobs ?? []);
      if (dRes.status === "fulfilled") setDashboards(dRes.value.dashboards ?? []);
      if (cRes.status === "fulfilled") setCredentials(cRes.value.credentials ?? []);
      if (bRes.status === "fulfilled") setBackends(bRes.value.backends ?? []);
      if (sqRes.status === "fulfilled") setSavedQueries(sqRes.value.queries ?? []);
    } catch {
      // non-fatal
    }
  }, [authed]);

  useEffect(() => {
    loadExplorerData().catch(() => {});
  }, [loadExplorerData]);

  // ── Catalog ─────────────────────────────────────────────────────────────────

  const runCatalogInit = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    setCatalogFailed([]);
    try {
      const db = await initDuckDB();
      const { tables, failed } = await registerCatalogViews(db, WORKER_BASE, getAuthHeaders);
      setCatalogTables(tables);
      if (failed.length > 0) setCatalogFailed(failed);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : "Catalog load failed");
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const handleCommit = useCallback((event: CatalogCommitEvent, refreshPromise: Promise<void>) => {
    setHasNewData(true);
    if (newDataTimerRef.current !== null) clearTimeout(newDataTimerRef.current);
    newDataTimerRef.current = setTimeout(() => setHasNewData(false), 3000);
    setCatalogTables((prev) => {
      const exists = prev.some((t) => t.name === event.table);
      if (exists) {
        return prev.map((t) =>
          t.name === event.table
            ? {
                ...t,
                latestSnapshot: {
                  id: event.snapshotId,
                  table_id: t.id,
                  uri: event.uri,
                  storage_backend: event.storage_backend,
                  access_mode: event.access_mode,
                  format: event.format,
                  created_at: Date.now(),
                },
              }
            : t,
        );
      }
      return [
        ...prev,
        {
          id: "",
          name: event.table,
          description: null,
          created_at: Date.now(),
          latestSnapshot: {
            id: event.snapshotId,
            table_id: "",
            uri: event.uri,
            storage_backend: event.storage_backend,
            access_mode: event.access_mode,
            format: event.format,
            created_at: Date.now(),
          },
        },
      ];
    });
    setCatalogFailed((prev) => prev.filter((n) => n !== event.table));
    catalogReadyRef.current = refreshPromise;
    dashboardCommitListenerRef.current?.(event);
  }, []);

  // ── Effect A: Catalog WebSocket ─────────────────────────────────────────────
  useEffect(() => {
    if (!authed) {
      catalogWsRef.current?.close();
      catalogWsRef.current = null;
      return;
    }
    const getDb = async () => {
      if (!sessionEnabledRef.current) throw new Error("DuckDB session is disabled");
      return initDuckDB();
    };
    const catConn = connectCatalogWs({
      workerBase: WORKER_BASE,
      getAuthHeaders,
      getDb,
      onCommit: handleCommit,
    });
    catalogWsRef.current = catConn;
    return () => {
      catConn.close();
      catalogWsRef.current = null;
    };
  }, [authed, handleCommit]);

  // ── Effect B: Catalog metadata ──────────────────────────────────────────────
  useEffect(() => {
    if (!authed) return;
    if (sessionEnabled) {
      const p = runCatalogInit();
      catalogReadyRef.current = p;
    } else {
      setCatalogLoading(true);
      setCatalogError(null);
      setCatalogFailed([]);
      fetchCatalogMetadata(WORKER_BASE, getAuthHeaders)
        .then((tables) => setCatalogTables(tables))
        .catch((err: unknown) => {
          setCatalogError(err instanceof Error ? err.message : "Catalog load failed");
        })
        .finally(() => setCatalogLoading(false));
    }
  }, [authed, sessionEnabled, runCatalogInit]);

  // ── Effect C: DuckDB + session WebSocket ───────────────────────────────────
  useEffect(() => {
    if (!authed || !sessionEnabled) {
      sessionRef.current?.close();
      sessionRef.current = null;
      setSessionConnected(false);
      return;
    }
    initDuckDB()
      .then(() => getCatalogReady())
      .then(() => setDbReady(true))
      .catch((err: unknown) => {
        setDbError(err instanceof Error ? err.message : "DuckDB failed to initialize");
      });
    const conn = connectSession({
      workerBase: WORKER_BASE,
      getAuthHeaders,
      getDb: initDuckDB,
      getCatalogReady,
      onStatusChange: setSessionConnected,
    });
    conn.setJobEventListener((ev) => jobEventListenerRef.current?.(ev));
    sessionRef.current = conn;
    return () => {
      conn.close();
      sessionRef.current = null;
    };
  }, [authed, sessionEnabled, getCatalogReady]);

  // ── Tab management ────────────────────────────────────────────────────────

  const openTab = useCallback((kind: string, item?: unknown) => {
    if (kind === "cred" || kind === "backend") setActivity("settings");
    else if (kind !== "commit") setActivity("explorer");
    setTabs((prev) => {
      let key: string;
      let title: string;
      let tab: WbTab;
      if (kind === "sql") {
        const p = item as { title?: string; sql?: string } | undefined;
        key = `sql:${uid()}`;
        title = p?.title ?? "Untitled";
        tab = { id: uid(), kind: "sql", key, title, sql: p?.sql ?? "", result: null };
      } else if (kind === "saved") {
        const q = item as SavedQuery;
        key = `saved:${q.id}`;
        title = q.name;
        tab = { id: uid(), kind: "sql", key, title, sql: q.sql, savedId: q.id, result: null };
      } else if (kind === "commit") {
        key = "commit";
        title = "Commit snapshot";
        tab = { id: uid(), kind: "commit", key, title };
      } else if (kind === "new-transform") {
        key = `transform:new:${uid()}`;
        title = "New transform";
        tab = { id: uid(), kind: "transform", key, title, item: null };
      } else if (kind === "new-job") {
        key = `job:new:${uid()}`;
        title = "New load job";
        tab = { id: uid(), kind: "job", key, title, item: null };
      } else {
        const itm = item as { id?: string; name?: string; title?: string; output_table?: string };
        const idVal = itm?.id ?? uid();
        const titleMap: Record<string, string | undefined> = {
          table: (item as CatalogTableWithSnapshot)?.name,
          transform: itm?.name ?? itm?.output_table,
          dashboard: itm?.title,
          job: itm?.output_table ?? itm?.id,
          cred: itm?.name,
          backend: itm?.name,
        };
        key = `${kind}:${idVal}`;
        title = titleMap[kind] ?? key;
        tab = { id: uid(), kind: kind as WbTab["kind"], key, title, item };
      }
      const existing = prev.find((t) => t.key === key);
      if (existing) {
        setActiveId(existing.id);
        return prev;
      }
      setActiveId(tab.id);
      return [...prev, tab];
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      setActiveId((cur) => {
        if (cur !== id) return cur;
        if (next.length === 0) return null;
        return (next[idx] ?? next[idx - 1] ?? next[0]).id;
      });
      return next;
    });
  }, []);

  const focusTab = useCallback((id: string) => setActiveId(id), []);
  const setTabSql = useCallback(
    (id: string, text: string) =>
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, sql: text } : t))),
    [],
  );
  const setTabResult = useCallback(
    (id: string, result: QueryResult) =>
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, result } : t))),
    [],
  );

  // ── Execute ───────────────────────────────────────────────────────────────

  const execute = useCallback(
    async (sqlText: string, opts: { source?: string } = {}): Promise<QueryResult> => {
      const source = opts.source ?? "query";
      setDockOpen(true);
      const entryId = uid();
      const when = nowClock();

      if (!sessionEnabledRef.current) {
        const result: QueryResult = {
          columns: [],
          rows: [],
          error: "DuckDB session is disabled — enable the toggle in the title bar.",
        };
        setLog((l) => [...l.slice(-199), { id: entryId, sql: sqlText, source, result, when }]);
        return result;
      }

      try {
        const db = await initDuckDB();
        const { sql: resolvedSql, preamble } = await resolveStorageUris(
          sqlText,
          WORKER_BASE,
          getAuthHeaders,
        );
        const t0 = Date.now();
        const raw = await runQuery(db, resolvedSql, preamble.length > 0 ? preamble : undefined);
        const ms = Date.now() - t0;
        const result: QueryResult = { columns: raw.columns, rows: raw.rows as unknown[][], ms };
        setLog((l) => [...l.slice(-199), { id: entryId, sql: sqlText, source, ms, result, when }]);
        setHistory((h) => {
          if (h[0]?.sql.trim() === sqlText.trim()) return h;
          return [{ sql: sqlText, rows: result.rows.length, when: "just now" }, ...h].slice(0, 50);
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const result: QueryResult = { columns: [], rows: [], error: msg };
        setLog((l) => [...l.slice(-199), { id: entryId, sql: sqlText, source, result, when }]);
        return result;
      }
    },
    [setDockOpen, setHistory],
  );

  // ── Save query ────────────────────────────────────────────────────────────

  const saveQuery = useCallback(async (name: string, sqlText: string, tabId: string) => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${WORKER_BASE}/api/saved-queries`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name, sql: sqlText }),
      });
      if (res.ok) {
        const d = (await res.json()) as { query: SavedQuery };
        setSavedQueries((prev) => [...prev, d.query]);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? { ...t, title: name, key: `saved:${d.query.id}`, savedId: d.query.id }
              : t,
          ),
        );
      }
    } catch {
      // non-fatal
    }
  }, []);

  // ── Commit table ──────────────────────────────────────────────────────────

  const commitTable = useCallback(({ name, uri }: { name: string; uri: string }) => {
    setHasNewData(true);
    if (newDataTimerRef.current !== null) clearTimeout(newDataTimerRef.current);
    newDataTimerRef.current = setTimeout(() => setHasNewData(false), 3000);
    setCatalogTables((prev) => {
      const exists = prev.some((t) => t.name === name);
      const snap = {
        id: `snap_${Date.now()}`,
        table_id: "",
        uri,
        storage_backend: "primary-r2",
        access_mode: "proxy" as const,
        format: "auto",
        created_at: Date.now(),
      };
      if (exists) return prev.map((t) => (t.name === name ? { ...t, latestSnapshot: snap } : t));
      return [
        ...prev,
        { id: "", name, description: null, created_at: Date.now(), latestSnapshot: snap },
      ];
    });
  }, []);

  const toggleSession = useCallback(() => {
    setSessionEnabled((v) => {
      const next = !v;
      localStorage.setItem("duckdb-session-enabled", String(next));
      return next;
    });
  }, []);

  const toggleTheme = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [setTheme],
  );
  const toggleDock = useCallback(() => setDockOpen((v) => !v), [setDockOpen]);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

  const schema = useMemo(() => {
    const s: Record<string, string[]> = {};
    for (const t of catalogTables) s[t.name] = [];
    return s;
  }, [catalogTables]);

  const data: WbData = useMemo(
    () => ({
      tables: catalogTables,
      transforms,
      jobs,
      dashboards,
      savedQueries,
      credentials,
      backends,
    }),
    [catalogTables, transforms, jobs, dashboards, savedQueries, credentials, backends],
  );

  const ctx: WbCtx = useMemo(
    () => ({
      data,
      schema,
      session: { enabled: sessionEnabled, connected: sessionConnected },
      theme,
      execute,
      openTab,
      closeTab,
      focusTab,
      setTabSql,
      setTabResult,
      saveQuery,
      commitTable,
      toggleSession,
      toggleTheme,
      toggleDock,
      openPalette,
    }),
    [
      data,
      schema,
      sessionEnabled,
      sessionConnected,
      theme,
      execute,
      openTab,
      closeTab,
      focusTab,
      setTabSql,
      setTabResult,
      saveQuery,
      commitTable,
      toggleSession,
      toggleTheme,
      toggleDock,
      openPalette,
    ],
  );

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const activeKey = activeTab ? activeTab.key : null;

  // ── Loading / login screens ────────────────────────────────────────────────

  if (authed === null) {
    return (
      <div class="flex items-center justify-center min-h-dvh">
        <span class="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (!authed) {
    return (
      <div class="hero min-h-dvh bg-base-200">
        <div class="hero-content text-center flex-col gap-2">
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: "var(--color-primary)",
              transform: "rotate(45deg)",
            }}
          />
          <h1 class="text-5xl font-bold" style={{ marginTop: 8 }}>
            Data Shack
          </h1>
          <p class="text-base-content/60 text-lg">Your personal data warehouse</p>
          {callbackError && (
            <div class="alert alert-error max-w-sm">
              <span>{callbackError}</span>
            </div>
          )}
          <button type="button" class="btn btn-primary mt-2" onClick={() => startLogin()}>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  // ── IDE shell ─────────────────────────────────────────────────────────────

  return (
    <div class="wb-root">
      {/* Title bar */}
      <div class="wb-titlebar">
        <span class="wb-tb-wordmark">
          <span class="wb-mark" />
          Data Shack
        </span>
        <span class="wb-tb-spacer" />
        <button type="button" class="wb-cmdk-hint" onClick={openPalette}>
          <SearchIcon size={14} />
          <span>Search & commands</span>
          <span class="wb-spacer" style={{ flex: 1 }} />
          <span class="wb-kbd">⌘K</span>
        </button>
        <span class="wb-tb-spacer" />
        <div class="wb-tb-group">
          <span
            style={{ display: "flex", gap: 6, alignItems: "center" }}
            title={
              hasNewData
                ? "New data committed"
                : sessionConnected
                  ? "Browser session active"
                  : "No session"
            }
          >
            <span
              class={`wb-dot${hasNewData ? " wb-dot-warning" : ""}`}
              style={hasNewData ? undefined : { background: "transparent" }}
            />
            <span class={`wb-dot wb-dot-${sessionConnected ? "success" : "idle"}`} />
          </span>
          <label class="wb-toggle-label" title="Enable DuckDB session">
            <span>DuckDB</span>
            <input
              type="checkbox"
              class="toggle toggle-xs"
              checked={sessionEnabled}
              onChange={toggleSession}
            />
          </label>
          <button type="button" class="wb-iconbtn" title="Toggle theme" onClick={toggleTheme}>
            {theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>
          {userId && <span class="wb-uid">{userId}</span>}
          {!DEV_TOKEN && (
            <button
              type="button"
              class="wb-iconbtn"
              title="Sign out"
              onClick={() => {
                clearTokens();
                setAuthed(false);
                setUserId(null);
              }}
            >
              <LogOutIcon size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div class="wb-body">
        {/* Activity rail */}
        <div class="wb-activity">
          <button
            type="button"
            class={`wb-act-btn${activity === "explorer" ? " active" : ""}`}
            title="Explorer"
            onClick={() => setActivity("explorer")}
          >
            <FilesIcon size={20} />
          </button>
          <button type="button" class="wb-act-btn" title="Search (⌘K)" onClick={openPalette}>
            <SearchIcon size={20} />
          </button>
          <span class="wb-act-spacer" />
          <button
            type="button"
            class={`wb-act-btn${activity === "settings" ? " active" : ""}`}
            title="Settings"
            onClick={() => setActivity("settings")}
          >
            <SettingsIcon size={20} />
          </button>
        </div>

        {/* Explorer sidebar */}
        <div class="wb-sidebar" style={{ width: sidebarW }}>
          <div class="wb-side-head">
            <span>{activity === "settings" ? "Settings" : "Explorer"}</span>
            {activity === "explorer" && (
              <button
                type="button"
                class="wb-iconbtn"
                style={{ width: 22, height: 22 }}
                title="New query"
                onClick={() => openTab("sql", { title: "Untitled", sql: "" })}
              >
                <PlusIcon size={14} />
              </button>
            )}
          </div>
          {activity === "explorer" && catalogLoading && (
            <div
              style={{
                padding: "8px 14px",
                fontSize: 11.5,
                color: "color-mix(in oklch, var(--color-base-content) 45%, transparent)",
              }}
            >
              Loading catalog…
            </div>
          )}
          {activity === "explorer" && catalogError && (
            <div style={{ padding: "8px 14px", fontSize: 11.5, color: "var(--color-error)" }}>
              {catalogError}
            </div>
          )}
          {activity === "settings" ? (
            <SettingsTree data={data} activeKey={activeKey} onOpen={openTab} />
          ) : (
            <Explorer
              data={data}
              activeKey={activeKey}
              onOpen={openTab}
              onNewQuery={() => openTab("sql", { title: "Untitled", sql: "" })}
            />
          )}
        </div>
        <div class="wb-resizer" onMouseDown={startSidebarResize} />

        {/* Main area */}
        <div class="wb-main">
          {/* Tab strip */}
          <div class="wb-tabstrip wb-scrollbar-thin">
            {tabs.map((t) => (
              <button
                type="button"
                key={t.id}
                class={`wb-tab${t.id === activeId ? " active" : ""}`}
                onClick={() => setActiveId(t.id)}
                onAuxClick={(e) => {
                  if ((e as MouseEvent).button === 1) closeTab(t.id);
                }}
              >
                <span class="wb-tab-ico">
                  <TabIcon kind={t.kind} size={13} />
                </span>
                <span
                  class={`wb-tab-label${t.kind === "sql" || t.kind === "table" ? " mono" : ""}`}
                >
                  {t.title}
                  {t.kind === "sql" ? ".sql" : ""}
                </span>
                <button
                  type="button"
                  class="wb-tab-close"
                  title="Close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  <XIcon size={13} />
                </button>
              </button>
            ))}
            <button
              type="button"
              class="wb-tab-new"
              title="New query"
              onClick={() => openTab("sql", { title: "Untitled", sql: "" })}
            >
              <PlusIcon size={15} />
            </button>
          </div>

          {/* Tab content */}
          <div class="wb-tabcontent">
            <TabContent tab={activeTab} ctx={ctx} />
          </div>

          {/* Dock resize handle */}
          {dockOpen && <div class="wb-resizer wb-resizer-h" onMouseDown={startDockResize} />}

          {/* Bottom dock */}
          {dockOpen && (
            <div class="wb-dock" style={{ height: dockH }}>
              <ConsoleDock
                ctx={ctx}
                log={log}
                history={history}
                dockTab={dockTab}
                setDockTab={setDockTab}
                onClear={() => setLog([])}
                onClose={() => setDockOpen(false)}
              />
            </div>
          )}

          {/* Status bar */}
          <div class="wb-statusbar">
            <span class="wb-status-item">
              <span class={`wb-dot wb-dot-${sessionConnected ? "success" : "idle"}`} />
              {sessionConnected ? "session active" : sessionEnabled ? "connecting…" : "session off"}
            </span>
            <span class="wb-status-item mono">
              {catalogTables.length} table{catalogTables.length === 1 ? "" : "s"}
            </span>
            <span class="wb-status-item mono">{log.length} queries</span>
            <span class="wb-status-spacer" />
            <button
              type="button"
              class="wb-status-btn"
              onClick={toggleDock}
              title="Toggle console (⌘J)"
            >
              <PanelIcon size={12} />
              Console
            </button>
            {userId && <span class="wb-status-item mono">{userId}</span>}
          </div>
        </div>
      </div>

      {/* Command palette */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        data={data}
        openTabs={tabs}
        ctx={ctx}
      />
    </div>
  );
}

// ── Tab icon helper ────────────────────────────────────────────────────────────

function TabIcon({ kind, size }: { kind: string; size: number }) {
  switch (kind) {
    case "sql":
      return <TerminalIcon size={size} />;
    case "table":
      return <TableIcon size={size} />;
    case "dashboard":
      return <ChartIcon size={size} />;
    case "transform":
      return <TransformIcon size={size} />;
    case "commit":
      return <DatabaseIcon size={size} />;
    default:
      return <FilesIcon size={size} />;
  }
}
