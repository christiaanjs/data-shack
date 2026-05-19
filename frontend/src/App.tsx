import { useEffect, useState } from "preact/hooks";
import { clearTokens, getAccessToken, getValidToken, handleCallback, startLogin } from "./auth.ts";

const WORKER_BASE = import.meta.env.VITE_WORKER_URL ?? "";
const DEV_TOKEN = import.meta.env.VITE_DEV_TOKEN as string | undefined;

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null = loading
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

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

    const headers: Record<string, string> = DEV_TOKEN ? { "X-Dev-Token": DEV_TOKEN } : {};

    const fetchUserId = async () => {
      if (!DEV_TOKEN) {
        const token = await getValidToken();
        if (!token) {
          clearTokens();
          setAuthed(false);
          return;
        }
        headers.Authorization = `Bearer ${token}`;
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
        <div class="spacer" />
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
        <div class="home">
          <h2>Welcome to your data warehouse</h2>
          {userId && <p class="user-id">Signed in as {userId}</p>}
          <p class="placeholder-note">The warehouse is being built. Check back soon.</p>
        </div>
      </main>
    </>
  );
}
