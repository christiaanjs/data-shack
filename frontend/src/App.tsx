import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { CatalogPanel } from "./CatalogPanel.tsx";
import { DashboardsPanel } from "./DashboardsPanel.tsx";
import { LoadJobsPanel } from "./LoadJobsPanel.tsx";
import { QueryPanel } from "./QueryPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { TransformJobsPanel } from "./TransformJobsPanel.tsx";
import { clearTokens, getAccessToken, getValidToken, handleCallback, startLogin } from "./auth.ts";
import { type CatalogTableWithSnapshot, registerCatalogViews } from "./catalogViews.ts";
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

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("query");
  const [sessionConnected, setSessionConnected] = useState(false);

  // ── Catalog state (lifted from QueryPanel) ───────────────────────────────
  const [catalogTables, setCatalogTables] = useState<CatalogTableWithSnapshot[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogFailed, setCatalogFailed] = useState<string[]>([]);
  // Flash indicator: true for 3s after any catalog commit arrives.
  const [hasNewData, setHasNewData] = useState(false);
  const newDataTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // DuckDB readiness (singleton across the app — initDuckDB() is already a module singleton).
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  // Promise tracking: kept current so getCatalogReady() always returns
  // a promise that resolves once catalog views are fully up to date.
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

  // Stable getter — sessionWs reads this ref on every message.
  const getCatalogReady = useCallback(() => catalogReadyRef.current, []);

  // ── Auth state machine ────────────────────────────────────────────────────

  useEffect(() => {
    if (DEV_TOKEN) {
      setAuthed(true);
      return;
    }

    const params = new URLSearchParams(location.search);

    if (location.pathname === "/callback") {
      handleCallback(params)
        .then(() => {
          history.replaceState(null, "", "/");
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

  // ── Catalog initialization ────────────────────────────────────────────────

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
    // Flash the new-data indicator for 3 seconds.
    setHasNewData(true);
    if (newDataTimerRef.current !== null) clearTimeout(newDataTimerRef.current);
    newDataTimerRef.current = setTimeout(() => setHasNewData(false), 3000);

    // Update the local catalog table list so new tables appear immediately.
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
      // New table — add a placeholder; id will be populated on the next full refresh.
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
    // Remove the table from the failed list if it was previously failing.
    setCatalogFailed((prev) => prev.filter((n) => n !== event.table));

    // refreshPromise was created before onCommit was called, so it accurately
    // covers this commit's view refresh (and any still-in-flight prior refreshes).
    catalogReadyRef.current = refreshPromise;

    dashboardCommitListenerRef.current?.(event);
  }, []);

  // ── Session + Catalog WebSocket connections ───────────────────────────────

  useEffect(() => {
    if (!authed) {
      sessionRef.current?.close();
      sessionRef.current = null;
      catalogWsRef.current?.close();
      catalogWsRef.current = null;
      setSessionConnected(false);
      return;
    }

    // 1. Init DuckDB (singleton — safe to call multiple times).
    initDuckDB()
      .then(() => setDbReady(true))
      .catch((err: unknown) => {
        setDbError(err instanceof Error ? err.message : "DuckDB failed to initialize");
      });

    // 2. Start catalog initialization; track the promise so transform jobs can await it.
    const initPromise = runCatalogInit();
    catalogReadyRef.current = initPromise;

    // 3. Connect catalog WebSocket for live commit updates.
    const catConn = connectCatalogWs({
      workerBase: WORKER_BASE,
      getAuthHeaders,
      getDb: initDuckDB,
      onCommit: handleCommit,
    });
    catalogWsRef.current = catConn;

    // 4. Connect session WebSocket (MCP queries + transform job dispatch).
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
      catConn.close();
      sessionRef.current = null;
      catalogWsRef.current = null;
    };
  }, [authed, runCatalogInit, handleCommit, getCatalogReady]);

  // ── Loading screen ────────────────────────────────────────────────────────

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
      <div class="navbar bg-base-200 border-b border-base-300 sticky top-0 z-10">
        <div class="navbar-start">
          <span class="text-lg font-bold px-2">Data Shack</span>
        </div>
        <div class="navbar-center">
          <div role="tablist" class="tabs tabs-border">
            <button
              type="button"
              role="tab"
              class={`tab${activeTab === "query" ? " tab-active" : ""}`}
              onClick={() => setActiveTab("query")}
            >
              Query
            </button>
            <button
              type="button"
              role="tab"
              class={`tab${activeTab === "catalog" ? " tab-active" : ""}`}
              onClick={() => setActiveTab("catalog")}
            >
              Catalog
            </button>
            <button
              type="button"
              role="tab"
              class={`tab${activeTab === "jobs" ? " tab-active" : ""}`}
              onClick={() => setActiveTab("jobs")}
            >
              Jobs
            </button>
            <button
              type="button"
              role="tab"
              class={`tab${activeTab === "transforms" ? " tab-active" : ""}`}
              onClick={() => setActiveTab("transforms")}
            >
              Transforms
            </button>
            <button
              type="button"
              role="tab"
              class={`tab${activeTab === "settings" ? " tab-active" : ""}`}
              onClick={() => setActiveTab("settings")}
            >
              Settings
            </button>
            <button
              type="button"
              role="tab"
              class={`tab${activeTab === "dashboards" ? " tab-active" : ""}`}
              onClick={() => setActiveTab("dashboards")}
            >
              Dashboards
            </button>
          </div>
        </div>
        <div class="navbar-end gap-3 pr-2">
          {/* New-data flash: turns amber for 3s after a catalog commit */}
          <span
            class={`w-2 h-2 rounded-full flex-shrink-0 transition-colors duration-300 ${hasNewData ? "bg-warning" : "bg-transparent"}`}
            title={hasNewData ? "New data committed" : undefined}
          />
          <span
            class={`w-2 h-2 rounded-full flex-shrink-0 ${sessionConnected ? "bg-success" : "bg-base-content/20"}`}
            title={sessionConnected ? "Browser session active" : "No MCP session"}
          />
          {userId && (
            <span class="text-xs text-base-content/50 font-mono hidden sm:block">{userId}</span>
          )}
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

      <main class="flex-1">
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
          />
        )}
      </main>
    </div>
  );
}
