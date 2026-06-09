import { useLocation } from "preact-iso";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { CatalogCommitEvent } from "./catalogWs.ts";
import { buildIframeHtml, runProxyQuery } from "./dashboardUtils.ts";
import { initDuckDB, runQuery } from "./duckdb.ts";

interface DashboardsPanelProps {
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  dbReady: boolean;
  setCatalogCommitListener: (listener: ((ev: CatalogCommitEvent) => void) | null) => void;
  sessionEnabled: boolean;
  getCatalogReady: () => Promise<void>;
  isStandalone?: boolean;
}

interface DashboardListRow {
  id: string;
  title: string;
  slug: string | null;
  created_at: number;
}

interface DashboardDetail {
  id: string;
  title: string;
  slug: string | null;
  artifact_source: string;
  queries: string[];
  created_at: number;
  updated_at: number;
}

export function DashboardsPanel({
  workerBase,
  getAuthHeaders,
  dbReady,
  setCatalogCommitListener,
  sessionEnabled,
  getCatalogReady,
  isStandalone = false,
}: DashboardsPanelProps) {
  const { path, route } = useLocation();

  // Derive viewer state from URL: /dashboards/dash_abc123 or /dashboards/my-slug
  const dashboardId = /^\/dashboards\/([^/?#]+)/.exec(path)?.[1] ?? null;

  const [dashboards, setDashboards] = useState<DashboardListRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [activeDashboard, setActiveDashboard] = useState<DashboardDetail | null>(null);
  const [iframeHtml, setIframeHtml] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Stable ref so the commit listener closure always sees the latest dashboard.
  const activeDashboardRef = useRef<DashboardDetail | null>(null);
  activeDashboardRef.current = activeDashboard;

  const fetchList = useCallback(async () => {
    setListError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${workerBase}/api/dashboards`, { headers });
      if (!res.ok) throw new Error(`Failed to load dashboards (${res.status})`);
      const data = (await res.json()) as { dashboards: DashboardListRow[] };
      setDashboards(data.dashboards);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load dashboards");
    }
  }, [workerBase, getAuthHeaders]);

  useEffect(() => {
    fetchList().catch(() => {});
  }, [fetchList]);

  const runAllQueries = useCallback(
    async (detail: DashboardDetail) => {
      setRunning(true);
      setRunError(null);
      try {
        let results: { columns: string[]; rows: unknown[][] }[];
        if (sessionEnabled) {
          await getCatalogReady();
          const db = await initDuckDB();
          results = await Promise.all(detail.queries.map((q) => runQuery(db, q)));
        } else {
          results = await Promise.all(
            detail.queries.map((q) => runProxyQuery(q, workerBase, getAuthHeaders)),
          );
        }
        setIframeHtml(buildIframeHtml(detail.artifact_source, results));
      } catch (err) {
        setRunError(err instanceof Error ? err.message : "Query failed");
      } finally {
        setRunning(false);
      }
    },
    [sessionEnabled, getCatalogReady, workerBase, getAuthHeaders],
  );

  // Load and run whenever the URL-derived dashboard id changes.
  useEffect(() => {
    if (!dashboardId) {
      setActiveDashboard(null);
      setIframeHtml(null);
      setRunError(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setRunning(true);
      setRunError(null);
      setIframeHtml(null);
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${workerBase}/api/dashboards/${dashboardId}`, { headers });
        if (!res.ok) throw new Error(`Failed to load dashboard (${res.status})`);
        const detail = (await res.json()) as DashboardDetail;
        if (cancelled) return;
        setActiveDashboard(detail);
        await runAllQueries(detail);
      } catch (err) {
        if (!cancelled) {
          setRunError(err instanceof Error ? err.message : "Failed to open dashboard");
          setRunning(false);
        }
      }
    };
    load().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dashboardId, workerBase, getAuthHeaders, runAllQueries]);

  const handleDelete = useCallback(
    async (id: string) => {
      setDeleting(id);
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${workerBase}/api/dashboards/${id}`, {
          method: "DELETE",
          headers,
        });
        if (!res.ok && res.status !== 404) throw new Error(`Delete failed (${res.status})`);
        await fetchList();
      } catch {
        // ignore — list will reflect server state on next fetch
      } finally {
        setDeleting(null);
      }
    },
    [workerBase, getAuthHeaders, fetchList],
  );

  // Register catalog commit listener while a dashboard is open.
  useEffect(() => {
    if (!dashboardId) {
      setCatalogCommitListener(null);
      return;
    }
    setCatalogCommitListener((_ev) => {
      const dash = activeDashboardRef.current;
      if (dash) runAllQueries(dash).catch(() => {});
    });
    return () => setCatalogCommitListener(null);
  }, [dashboardId, setCatalogCommitListener, runAllQueries]);

  // ── Viewer ────────────────────────────────────────────────────────────────

  if (dashboardId) {
    return (
      <div class="flex-1 flex flex-col min-h-0">
        {!isStandalone && (
          <div class="flex items-center gap-2 px-3 py-2 border-b border-base-300 flex-shrink-0">
            <button type="button" class="btn btn-ghost btn-sm" onClick={() => route("/dashboards")}>
              ← Back
            </button>
            {activeDashboard && (
              <h2 class="text-base font-semibold flex-1 truncate">{activeDashboard.title}</h2>
            )}
            {running && <span class="loading loading-spinner loading-sm flex-shrink-0" />}
            {!sessionEnabled && (
              <span class="badge badge-outline badge-sm text-base-content/50 flex-shrink-0">
                proxy
              </span>
            )}
          </div>
        )}

        {runError && (
          <div class="alert alert-error flex-shrink-0 m-2">
            <span>{runError}</span>
            {activeDashboard && (
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                onClick={() => runAllQueries(activeDashboard).catch(() => {})}
              >
                Retry
              </button>
            )}
          </div>
        )}

        {sessionEnabled && !dbReady && !runError && (
          <div class="alert alert-warning flex-shrink-0 m-2">
            <span>DuckDB is still initialising…</span>
          </div>
        )}

        {iframeHtml && (
          <iframe
            sandbox="allow-scripts"
            srcdoc={iframeHtml}
            title={activeDashboard?.title ?? "Dashboard"}
            class="flex-1 min-h-0 w-full"
            style="border:none;background:white;"
          />
        )}
      </div>
    );
  }

  // ── List ─────────────────────────────────────────────────────────────────

  return (
    <div class="p-4 flex flex-col gap-4 max-w-3xl">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Dashboards</h2>
        <span class="text-sm text-base-content/50">
          Created via the MCP <code>submit_dashboard</code> tool
        </span>
      </div>

      {listError && (
        <div class="alert alert-error">
          <span>{listError}</span>
          <button type="button" class="btn btn-sm btn-ghost" onClick={fetchList}>
            Retry
          </button>
        </div>
      )}

      {dashboards.length === 0 && !listError && (
        <div class="text-base-content/50 text-sm py-8 text-center">
          No dashboards yet. Ask Claude to create one and call <code>submit_dashboard</code>.
        </div>
      )}

      {dashboards.length > 0 && (
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr>
                <th>Title</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dashboards.map((d) => (
                <tr key={d.id} class="hover">
                  <td class="font-medium">
                    {d.title}
                    {d.slug && (
                      <span class="ml-2 font-mono text-xs text-base-content/40">/{d.slug}</span>
                    )}
                  </td>
                  <td class="text-base-content/60 text-xs">
                    {new Date(d.created_at).toLocaleString()}
                  </td>
                  <td class="text-right">
                    <div class="flex gap-2 justify-end">
                      <button
                        type="button"
                        class="btn btn-primary btn-xs"
                        onClick={() => route(`/dashboards/${d.slug ?? d.id}`)}
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs text-error"
                        disabled={deleting === d.id}
                        onClick={() => handleDelete(d.id).catch(() => {})}
                      >
                        {deleting === d.id ? (
                          <span class="loading loading-spinner loading-xs" />
                        ) : (
                          "Delete"
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
