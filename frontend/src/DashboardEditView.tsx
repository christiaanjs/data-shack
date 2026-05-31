import { useEffect, useRef, useState } from "preact/hooks";
import type { JsEditorHandle } from "./JsEditor.tsx";
import { JsEditor } from "./JsEditor.tsx";
import type { SqlEditorHandle } from "./SqlEditor.tsx";
import { SqlEditor } from "./SqlEditor.tsx";
import { buildIframeHtml } from "./dashboardUtils.ts";
import { WORKER_BASE, authHeaders } from "./wb-api.ts";
import { ChartIcon, PlusIcon, SaveIcon, XIcon } from "./wbIcons.tsx";
import type { WbCtx, WbDashboard, WbTab } from "./workbench-types.ts";

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

const DEFAULT_ARTIFACT = `import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

/** @param {{ data: Record<string, unknown>[][] }} props */
export default function Dashboard({ data }) {
  const rows = data[0] ?? [];
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Dashboard</h2>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip />
          <Bar dataKey="value" fill="#3b82f6" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}`;

interface DashboardApiDetail {
  id: string;
  title: string;
  slug: string | null;
  artifact_source: string;
  queries: string[];
  created_at: number;
  updated_at: number;
}

export function DashboardEditView({ tab, ctx }: { tab: WbTab; ctx: WbCtx }) {
  const dashItem = tab.item as WbDashboard | null;
  const dashId = dashItem?.id ?? null;

  const jsRef = useRef<JsEditorHandle>(null);
  // Per-query editor refs are not needed for save — we use onChange to keep queries state in sync.
  // We keep a ref array only for potential focus() calls.
  const queryEditorRefs = useRef<(SqlEditorHandle | null)[]>([]);

  const [title, setTitle] = useState(dashItem?.title ?? "");
  const [slug, setSlug] = useState(dashItem?.slug ?? "");
  const [artifactSrc, setArtifactSrc] = useState(DEFAULT_ARTIFACT);
  const [queries, setQueries] = useState<string[]>([""]);
  const [queryIds, setQueryIds] = useState<string[]>(() => [uid()]);
  const [iframeHtml, setIframeHtml] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [loading, setLoading] = useState(false);

  // On mount, fetch existing dashboard if we have an id
  useEffect(() => {
    if (!dashId) return;
    let cancelled = false;
    setLoading(true);
    authHeaders()
      .then((headers) =>
        fetch(`${WORKER_BASE}/api/dashboards/${dashId}`, { headers }).then(async (res) => {
          if (!res.ok) throw new Error(`Failed to load dashboard (${res.status})`);
          return res.json() as Promise<DashboardApiDetail>;
        }),
      )
      .then((detail) => {
        if (cancelled) return;
        setTitle(detail.title);
        setSlug(detail.slug ?? "");
        setArtifactSrc(detail.artifact_source);
        const qs = detail.queries.length > 0 ? detail.queries : [""];
        setQueries(qs);
        setQueryIds(qs.map(() => uid()));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dashId]);

  async function runPreview() {
    setRunning(true);
    setRunError(null);
    setIframeHtml(null);
    try {
      const results: { columns: string[]; rows: unknown[][] }[] = [];
      for (const q of queries) {
        if (!q.trim()) {
          results.push({ columns: [], rows: [] });
          continue;
        }
        const res = await ctx.execute(q, { source: "dashboard-preview" });
        if (res.error) {
          setRunError(res.error);
          setRunning(false);
          return;
        }
        results.push({ columns: res.columns, rows: res.rows });
      }
      const src = jsRef.current ? jsRef.current.getDoc() : artifactSrc;
      setIframeHtml(buildIframeHtml(src, results));
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    setSaving(true);
    setSaveErr(null);
    setSaveOk(false);
    try {
      const src = jsRef.current ? jsRef.current.getDoc() : artifactSrc;
      const headers = { ...(await authHeaders()), "Content-Type": "application/json" };
      const body = {
        title,
        ...(slug ? { slug } : {}),
        artifact_source: src,
        queries,
      };
      const url = dashId
        ? `${WORKER_BASE}/api/dashboards/${dashId}`
        : `${WORKER_BASE}/api/dashboards`;
      const method = dashId ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? `Failed: ${res.status}`);
      }
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function addQuery() {
    setQueries((prev) => [...prev, ""]);
    setQueryIds((prev) => [...prev, uid()]);
    queryEditorRefs.current = [...queryEditorRefs.current, null];
  }

  function removeQuery(i: number) {
    setQueries((prev) => prev.filter((_, j) => j !== i));
    setQueryIds((prev) => prev.filter((_, j) => j !== i));
    queryEditorRefs.current = queryEditorRefs.current.filter((_, j) => j !== i);
  }

  if (loading) {
    return (
      <div class="wb-sql">
        <div class="wb-result-empty">
          <span class="loading loading-sm" style={{ marginRight: 8 }} />
          Loading dashboard…
        </div>
      </div>
    );
  }

  return (
    <div class="wb-sql">
      {/* Toolbar */}
      <div class="wb-sql-toolbar" style={{ gap: 10 }}>
        <span class="wb-doc-kicker" style={{ textTransform: "none", letterSpacing: 0 }}>
          <ChartIcon size={13} />
        </span>
        <input
          class="input input-sm"
          style={{ width: 200 }}
          placeholder="Dashboard title"
          value={title}
          onChange={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
        <span class="wb-con-hint" style={{ fontSize: 11, marginLeft: 4 }}>
          slug
        </span>
        <input
          class="input input-sm font-mono"
          style={{ width: 160 }}
          placeholder="my-slug (optional)"
          value={slug}
          onChange={(e) => setSlug((e.target as HTMLInputElement).value)}
        />
        <span style={{ flex: 1 }} />
        {saveOk && <span style={{ fontSize: 12, color: "var(--color-success)" }}>Saved.</span>}
        {saveErr && <span style={{ fontSize: 12, color: "var(--color-error)" }}>{saveErr}</span>}
        <button
          type="button"
          class={`btn btn-ghost btn-sm${running || !ctx.session.enabled ? " btn-disabled" : ""}`}
          onClick={runPreview}
          disabled={running || !ctx.session.enabled}
          title={!ctx.session.enabled ? "Enable DuckDB to preview" : "Preview dashboard"}
        >
          {running ? <span class="loading loading-xs" /> : null}
          Preview
        </button>
        <button type="button" class="btn btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? <span class="loading loading-xs" /> : <SaveIcon size={13} />}
          Save
        </button>
      </div>

      {/* Split layout */}
      <div class="wb-dash-split">
        {/* Left: queries + artifact editor */}
        <div class="wb-dash-left">
          {/* Queries section */}
          <div class="wb-dash-queries">
            <div class="wb-dash-query-head">Queries</div>
            {queries.map((q, i) => (
              <div key={queryIds[i]}>
                <div class="wb-dash-query-head" style={{ paddingTop: 8 }}>
                  <span style={{ flex: 1 }}>Query {i + 1}</span>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    style={{ padding: "0 4px" }}
                    onClick={() => removeQuery(i)}
                    title="Remove query"
                    disabled={queries.length === 1}
                  >
                    <XIcon size={12} />
                  </button>
                </div>
                <div class="wb-dash-query-editor">
                  <SqlEditor
                    ref={(el: SqlEditorHandle | null) => {
                      queryEditorRefs.current[i] = el;
                    }}
                    value={q}
                    schema={ctx.schema}
                    onChange={(sql) =>
                      setQueries((prev) => prev.map((x, j) => (j === i ? sql : x)))
                    }
                    onRun={runPreview}
                  />
                </div>
              </div>
            ))}
            <div class="wb-dash-queries-add">
              <button type="button" class="btn btn-ghost btn-xs" onClick={addQuery}>
                <PlusIcon size={12} />
                Add query
              </button>
            </div>
          </div>

          {/* Artifact (JS) editor */}
          <div class="wb-dash-artifact">
            <div class="wb-dash-artifact-head">Component</div>
            <JsEditor ref={jsRef} value={artifactSrc} autoFocus onChange={setArtifactSrc} />
          </div>
        </div>

        {/* Right: preview */}
        <div class="wb-dash-preview">
          {running && (
            <div class="wb-dash-preview-empty">
              <span class="loading loading-sm" style={{ marginRight: 8 }} />
              Rendering…
            </div>
          )}
          {!running && runError && (
            <div
              class="wb-dash-preview-empty"
              style={{
                color: "var(--color-error)",
                padding: 16,
                flexDirection: "column",
                gap: 8,
                textAlign: "center",
              }}
            >
              <span>{runError}</span>
            </div>
          )}
          {!running && !runError && !iframeHtml && (
            <div class="wb-dash-preview-empty">Click Preview to render</div>
          )}
          {!running && !runError && iframeHtml && (
            <iframe
              srcdoc={iframeHtml}
              sandbox="allow-scripts"
              style={{ width: "100%", height: "100%", border: 0, background: "#fff" }}
              title="Dashboard preview"
            />
          )}
        </div>
      </div>
    </div>
  );
}
