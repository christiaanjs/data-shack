import { useEffect, useRef, useState } from "preact/hooks";
import { CatalogPanel } from "./CatalogPanel.tsx";
import { LoadJobsPanel } from "./LoadJobsPanel.tsx";
import { QueryPanel } from "./QueryPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { clearTokens, getAccessToken, getValidToken, handleCallback, startLogin } from "./auth.ts";
import { initDuckDB } from "./duckdb.ts";
import { type SessionConnection, connectSession } from "./sessionWs.ts";

const WORKER_BASE = import.meta.env.VITE_WORKER_URL ?? "";
const DEV_TOKEN = import.meta.env.VITE_DEV_TOKEN as string | undefined;

type Tab = "query" | "catalog" | "jobs" | "settings";

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
  const sessionRef = useRef<SessionConnection | null>(null);

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

  // Establish Session DO WebSocket after auth to receive MCP queries and transform jobs.
  useEffect(() => {
    if (!authed) {
      sessionRef.current?.close();
      sessionRef.current = null;
      setSessionConnected(false);
      return;
    }

    const conn = connectSession({
      workerBase: WORKER_BASE,
      getAuthHeaders,
      getDb: initDuckDB,
      onStatusChange: setSessionConnected,
    });
    sessionRef.current = conn;

    return () => {
      conn.close();
      sessionRef.current = null;
    };
  }, [authed]);

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
              class={`tab${activeTab === "settings" ? " tab-active" : ""}`}
              onClick={() => setActiveTab("settings")}
            >
              Settings
            </button>
          </div>
        </div>
        <div class="navbar-end gap-3 pr-2">
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
          <QueryPanel workerBase={WORKER_BASE} getAuthHeaders={getAuthHeaders} />
        )}
        {activeTab === "catalog" && (
          <CatalogPanel workerBase={WORKER_BASE} getAuthHeaders={getAuthHeaders} />
        )}
        {activeTab === "jobs" && (
          <LoadJobsPanel workerBase={WORKER_BASE} getAuthHeaders={getAuthHeaders} />
        )}
        {activeTab === "settings" && (
          <SettingsPanel workerBase={WORKER_BASE} getAuthHeaders={getAuthHeaders} />
        )}
      </main>
    </div>
  );
}
