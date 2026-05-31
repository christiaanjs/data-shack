import { useLocation } from "preact-iso";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { CatalogPanel } from "./CatalogPanel.tsx";
import { DashboardsPanel } from "./DashboardsPanel.tsx";
import { LoadJobsPanel } from "./LoadJobsPanel.tsx";
import { QueryPanel } from "./QueryPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { TransformJobsPanel } from "./TransformJobsPanel.tsx";
import { WorkbenchShell } from "./WorkbenchShell.tsx";
import { clearTokens, getAccessToken, getValidToken, handleCallback, startLogin } from "./auth.ts";
import {
  type CatalogTableWithSnapshot,
  fetchCatalogMetadata,
  registerCatalogViews,
} from "./catalogViews.ts";
import { type CatalogCommitEvent, type CatalogConnection, connectCatalogWs } from "./catalogWs.ts";
import { initDuckDB } from "./duckdb.ts";
import { type JobEvent, type SessionConnection, connectSession } from "./sessionWs.ts";

const WORKER_BASE = import.meta.env.VITE_WORKER_URL ?? "";
const DEV_TOKEN = import.meta.env.VITE_DEV_TOKEN as string | undefined;

type Tab = "query" | "catalog" | "jobs" | "transforms" | "settings" | "dashboards";

async function getAuthHeaders(): Promise<Record<string, string>> {
  if (DEV_TOKEN) return { "X-Dev-Token": DEV_TOKEN };
  const token = await getValidToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function tabFromPath(path: string): Tab {
  if (path.startsWith("/catalog")) return "catalog";
  if (path.startsWith("/jobs")) return "jobs";
  if (path.startsWith("/transforms")) return "transforms";
  if (path.startsWith("/settings")) return "settings";
  if (path.startsWith("/dashboards")) return "dashboards";
  return "query";
}

const isStandalone =
  window.matchMedia("(display-mode: standalone)").matches ||
  ("standalone" in window.navigator &&
    (window.navigator as { standalone?: boolean }).standalone === true);

export function App() {
  const { path } = useLocation();

  // Delegate to WorkbenchShell for /workbench paths — it is fully self-contained.
  if (path.startsWith("/workbench")) {
    return <WorkbenchShell />;
  }

  return <LegacyApp />;
}

function LegacyApp() {
  const { path, route } = useLocation();

  const activeTab = tabFromPath(path);
  const hideNavbar = isStandalone && /^\/dashboards\/.+/.test(path);

  const [authed, setAuthed] = useState<boolean | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionConnected, setSessionConnected] = useState(false);

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
  const [catalogFailed, setCatalogFailed] = useState<string[]>([]);
  const [hasNewData, setHasNewData] = useState(false);
  const newDataTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  const catalogReadyRef = useRef<Promise<void>>(Promise.resolve());

  const sessionRef = useRef<SessionConnection | null>(null);
  const catalogWsRef = useRef<CatalogConnection | null>(null);
  const jobEventListenerRef = useRef<((ev: JobEvent) => void) | null>(null);
  const setJobListener = useCallback((listener: ((ev: JobEvent) => void) | null) => {
    jobEventListenerRef.current = listener;
  }, []);
  const dashboardCommitListenerRef = useRef<((ev: CatalogCommitEvent) => void) | null>(null);
  const setDashboardCommitListener = useCallback(
    (listener: ((ev: CatalogCommitEvent) => void) | null) => {
      dashboardCommitListenerRef.current = listener;
    },
    [],
  );

  const getCatalogReady = useCallback(() => catalogReadyRef.current, []);

  const getDb = useCallback(async () => {
    if (!sessionEnabledRef.current) throw new Error("DuckDB session is disabled");
    return initDuckDB();
  }, []);

  // ── Auth ──────────────────────────────────────────────────────────────────

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — path/route are stable on first render
  useEffect(() => {
    if (DEV_TOKEN) {
      setAuthed(true);
      return;
    }

    const params = new URLSearchParams(location.search);

    if (path === "/callback") {
      handleCallback(params)
        .then(() => {
          route("/", true);
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
    const fetchUserId = async () => {
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
        const data = (await res.json()) as { userId: string };
        setUserId(data.userId);
      }
    };
    fetchUserId().catch(() => {});
  }, [authed]);

  // ── Catalog ───────────────────────────────────────────────────────────────

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

  // ── Effect A: Catalog WebSocket ───────────────────────────────────────────

  useEffect(() => {
    if (!authed) {
      catalogWsRef.current?.close();
      catalogWsRef.current = null;
      return;
    }
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
  }, [authed, handleCommit, getDb]);

  // ── Effect B: Catalog metadata ────────────────────────────────────────────

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

  // ── Effect C: DuckDB + session WebSocket ──────────────────────────────────

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

  // ── Loading / login ───────────────────────────────────────────────────────

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
          <h1 class="text-5xl font-bold">Data Shack</h1>
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

  return (
    <div class="min-h-dvh flex flex-col">
      {!hideNavbar && (
        <div class="navbar bg-base-200 border-b border-base-300 sticky top-0 z-10">
          <div class="navbar-start">
            <span class="text-lg font-bold px-2">Data Shack</span>
          </div>
          <div class="navbar-center">
            <div role="tablist" class="tabs tabs-border">
              {(
                [
                  ["query", "/", "Query"],
                  ["catalog", "/catalog", "Catalog"],
                  ["jobs", "/jobs", "Jobs"],
                  ["transforms", "/transforms", "Transforms"],
                  ["settings", "/settings", "Settings"],
                  ["dashboards", "/dashboards", "Dashboards"],
                ] as [Tab, string, string][]
              ).map(([tab, href, label]) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  class={`tab${activeTab === tab ? " tab-active" : ""}`}
                  onClick={() => route(href)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div class="navbar-end gap-3 pr-2">
            <span
              class={`w-2 h-2 rounded-full flex-shrink-0 transition-colors duration-300 ${hasNewData ? "bg-warning" : "bg-transparent"}`}
              title={hasNewData ? "New data committed" : undefined}
            />
            <span
              class={`w-2 h-2 rounded-full flex-shrink-0 ${sessionConnected ? "bg-success" : "bg-base-content/20"}`}
              title={sessionConnected ? "Browser session active" : "No MCP session"}
            />
            <label class="flex items-center gap-1 cursor-pointer" title="Enable DuckDB + session">
              <span class="text-xs text-base-content/50 hidden sm:block">DuckDB</span>
              <input
                type="checkbox"
                class="toggle toggle-xs toggle-success"
                checked={sessionEnabled}
                onChange={(e) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  localStorage.setItem("duckdb-session-enabled", String(checked));
                  setSessionEnabled(checked);
                }}
              />
            </label>
            {userId && (
              <span class="text-xs text-base-content/50 font-mono hidden sm:block">{userId}</span>
            )}
            <a href="/workbench" class="btn btn-ghost btn-xs" title="Open workbench IDE">
              Workbench
            </a>
            {!DEV_TOKEN && (
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                onClick={() => {
                  clearTokens();
                  setAuthed(false);
                  setUserId(null);
                }}
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      )}

      <main class="flex-1 flex flex-col min-h-0">
        {activeTab === "query" && (
          <QueryPanel
            workerBase={WORKER_BASE}
            getAuthHeaders={getAuthHeaders}
            catalogTables={catalogTables}
            catalogLoading={catalogLoading}
            catalogError={catalogError}
            catalogFailed={catalogFailed}
            onRefreshCatalog={runCatalogInit}
            dbReady={dbReady}
            dbError={dbError}
            sessionEnabled={sessionEnabled}
          />
        )}
        {activeTab === "catalog" && (
          <CatalogPanel workerBase={WORKER_BASE} getAuthHeaders={getAuthHeaders} />
        )}
        {activeTab === "jobs" && (
          <LoadJobsPanel workerBase={WORKER_BASE} getAuthHeaders={getAuthHeaders} />
        )}
        {activeTab === "transforms" && (
          <TransformJobsPanel
            workerBase={WORKER_BASE}
            getAuthHeaders={getAuthHeaders}
            setJobListener={setJobListener}
          />
        )}
        {activeTab === "settings" && (
          <SettingsPanel workerBase={WORKER_BASE} getAuthHeaders={getAuthHeaders} />
        )}
        {activeTab === "dashboards" && (
          <DashboardsPanel
            workerBase={WORKER_BASE}
            getAuthHeaders={getAuthHeaders}
            dbReady={dbReady}
            setCatalogCommitListener={setDashboardCommitListener}
            sessionEnabled={sessionEnabled}
            getCatalogReady={getCatalogReady}
            isStandalone={isStandalone}
          />
        )}
      </main>
    </div>
  );
}
