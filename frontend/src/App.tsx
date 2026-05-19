import { useEffect, useState } from "preact/hooks";
import { QueryPanel } from "./QueryPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { clearTokens, getAccessToken, getValidToken, handleCallback, startLogin } from "./auth.ts";

const WORKER_BASE = import.meta.env.VITE_WORKER_URL ?? "";
const DEV_TOKEN = import.meta.env.VITE_DEV_TOKEN as string | undefined;

type Tab = "query" | "settings";

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
          const msg = err instanceof Error ? err.message : "Auth failed";
          setCallbackError(msg);
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

  if (authed === null) return <div class="loading">Loading…</div>;

  if (!authed) {
    return (
      <div class="login-screen">
        <h1>Data Shack</h1>
        <p class="tagline">Your personal data warehouse</p>
        {callbackError && <p class="error-banner">{callbackError}</p>}
        <button type="button" class="login-btn" onClick={() => startLogin()}>
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <>
      <header class="app-header">
        <h1>Data Shack</h1>
        <nav class="tab-nav">
          <button
            type="button"
            class={`tab-btn${activeTab === "query" ? " active" : ""}`}
            onClick={() => setActiveTab("query")}
          >
            Query
          </button>
          <button
            type="button"
            class={`tab-btn${activeTab === "settings" ? " active" : ""}`}
            onClick={() => setActiveTab("settings")}
          >
            Settings
          </button>
        </nav>
        <div class="spacer" />
        {userId && <span class="user-id">{userId}</span>}
        {!DEV_TOKEN && (
          <button
            type="button"
            class="sign-out-btn"
            onClick={() => {
              clearTokens();
              setAuthed(false);
              setUserId(null);
            }}
          >
            Sign out
          </button>
        )}
      </header>
      <main class="app-main">
        {activeTab === "query" && (
          <QueryPanel workerBase={WORKER_BASE} getAuthHeaders={getAuthHeaders} />
        )}
        {activeTab === "settings" && (
          <SettingsPanel workerBase={WORKER_BASE} getAuthHeaders={getAuthHeaders} />
        )}
      </main>
    </>
  );
}
