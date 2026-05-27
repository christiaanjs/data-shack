import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { CatalogCommitEvent } from "./catalogWs.ts";
import { initDuckDB, runQuery } from "./duckdb.ts";

interface DashboardsPanelProps {
  workerBase: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  dbReady: boolean;
  setCatalogCommitListener: (listener: ((ev: CatalogCommitEvent) => void) | null) => void;
}

interface DashboardListRow {
  id: string;
  title: string;
  created_at: number;
}

interface DashboardDetail {
  id: string;
  title: string;
  artifact_source: string;
  queries: string[];
  created_at: number;
  updated_at: number;
}

function buildIframeHtml(
  artifactSource: string,
  results: { columns: string[]; rows: unknown[][] }[],
): string {
  // Convert columnar results to arrays of row objects for ergonomic use in artifacts.
  const rowObjects = results.map(({ columns, rows }) =>
    rows.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]]))),
  );
  // Escape </script> so the HTML parser doesn't terminate the script block early.
  const safeData = JSON.stringify(rowObjects).replace(/<\/script/gi, "<\\/script");
  const safeSource = artifactSource.replace(/<\/script/gi, "<\\/script");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>* { box-sizing: border-box; } body { margin: 0; padding: 12px; font-family: system-ui, -apple-system, sans-serif; }</style>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://unpkg.com/recharts/umd/Recharts.js"></script>
</head>
<body>
<div id="root"></div>
<script>window.__DATA__ = ${safeData};<\/script>
<script type="text/babel">
const { useState, useEffect, useMemo, useCallback, useRef } = React;
const {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ComposedChart, ScatterChart, Scatter,
} = window.Recharts ?? {};

${safeSource}

try {
  ReactDOM.createRoot(document.getElementById('root')).render(
    React.createElement(Dashboard, { data: window.__DATA__ })
  );
} catch (err) {
  document.getElementById('root').innerHTML =
    '<pre style="color:red;white-space:pre-wrap;padding:8px">Render error: ' + String(err) + '</pre>';
}
<\/script>
</body>
</html>`;
}

export function DashboardsPanel({
  workerBase,
  getAuthHeaders,
  dbReady,
  setCatalogCommitListener,
}: DashboardsPanelProps) {
  const [view, setView] = useState<"list" | "viewer">("list");
  const [dashboards, setDashboards] = useState<DashboardListRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [activeDashboard, setActiveDashboard] = useState<DashboardDetail | null>(null);
  const [iframeHtml, setIframeHtml] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Keep activeDashboard accessible inside the commit listener without stale closure.
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

  const runAllQueries = useCallback(async (detail: DashboardDetail) => {
    setRunning(true);
    setRunError(null);
    try {
      const db = await initDuckDB();
      const results = await Promise.all(detail.queries.map((q) => runQuery(db, q)));
      setIframeHtml(buildIframeHtml(detail.artifact_source, results));
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Query failed");
    } finally {
      setRunning(false);
    }
  }, []);

  const openDashboard = useCallback(
    async (id: string) => {
      setRunError(null);
      setIframeHtml(null);
      setRunning(true);
      setView("viewer");
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${workerBase}/api/dashboards/${id}`, { headers });
        if (!res.ok) throw new Error(`Failed to load dashboard (${res.status})`);
        const detail = (await res.json()) as DashboardDetail;
        setActiveDashboard(detail);
        await runAllQueries(detail);
      } catch (err) {
        setRunError(err instanceof Error ? err.message : "Failed to open dashboard");
        setRunning(false);
      }
    },
    [workerBase, getAuthHeaders, runAllQueries],
  );

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
        // ignore — list will still reflect server state on next fetch
      } finally {
        setDeleting(null);
      }
    },
    [workerBase, getAuthHeaders, fetchList],
  );

  const handleBack = useCallback(() => {
    setView("list");
    setActiveDashboard(null);
    setIframeHtml(null);
    setRunError(null);
  }, []);

  // Register catalog commit listener while a dashboard is open.
  useEffect(() => {
    if (view !== "viewer") {
      setCatalogCommitListener(null);
      return;
    }
    setCatalogCommitListener((_ev) => {
      const dash = activeDashboardRef.current;
      if (dash) runAllQueries(dash).catch(() => {});
    });
    return () => setCatalogCommitListener(null);
  }, [view, setCatalogCommitListener, runAllQueries]);

  if (view === "viewer") {
    return (
      <div class="p-4 flex flex-col gap-3">
        <div class="flex items-center gap-3">
          <button type="button" class="btn btn-ghost btn-sm" onClick={handleBack}>
            ← Back
          </button>
          {activeDashboard && <h2 class="text-lg font-semibold">{activeDashboard.title}</h2>}
          {running && <span class="loading loading-spinner loading-sm" />}
        </div>

        {runError && (
          <div class="alert alert-error">
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

        {!dbReady && !runError && (
          <div class="alert alert-warning">
            <span>DuckDB is still initialising…</span>
          </div>
        )}

        {iframeHtml && (
          <iframe
            sandbox="allow-scripts"
            srcdoc={iframeHtml}
            title={activeDashboard?.title ?? "Dashboard"}
            style="width:100%;height:600px;border:1px solid var(--fallback-b3,oklch(var(--b3)));border-radius:8px;background:white;"
          />
        )}
      </div>
    );
  }

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
                  <td class="font-medium">{d.title}</td>
                  <td class="text-base-content/60 text-xs">
                    {new Date(d.created_at).toLocaleString()}
                  </td>
                  <td class="text-right">
                    <div class="flex gap-2 justify-end">
                      <button
                        type="button"
                        class="btn btn-primary btn-xs"
                        onClick={() => openDashboard(d.id).catch(() => {})}
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
