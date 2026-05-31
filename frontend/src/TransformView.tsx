import { useEffect, useRef, useState } from "preact/hooks";
import { ResultGrid } from "./ResultGrid.tsx";
import type { SqlEditorHandle } from "./SqlEditor.tsx";
import { SqlEditor } from "./SqlEditor.tsx";
import { WORKER_BASE, authHeaders } from "./wb-api.ts";
import { PlayIcon, SaveIcon, TransformIcon } from "./wbIcons.tsx";
import type { QueryResult, WbCtx, WbTab, WbTransform } from "./workbench-types.ts";

interface TrTrigger {
  id: string;
  watches: string[];
  policy: string;
  job_id: string;
}

function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return "—";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function TransformView({ tab, ctx }: { tab: WbTab; ctx: WbCtx }) {
  const tr = tab.item as WbTransform | null;
  const isNew = !tr;

  const edRef = useRef<SqlEditorHandle>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  // Editable fields
  const [name, setName] = useState(tr?.name ?? "");
  const [outputTable, setOutputTable] = useState(tr?.output_table ?? "");
  const [outputUri, setOutputUri] = useState(tr?.output_uri ?? "");
  const [outputBackend, setOutputBackend] = useState(tr?.output_backend ?? "");

  // Triggers for config strip
  const [trTriggers, setTrTriggers] = useState<TrTrigger[]>([]);
  const trId = tr?.id ?? null;
  useEffect(() => {
    if (!trId) return;
    authHeaders()
      .then((headers) =>
        fetch(`${WORKER_BASE}/api/triggers`, { headers })
          .then((r) =>
            r.ok
              ? (r.json() as Promise<{ triggers: TrTrigger[] }>)
              : Promise.resolve({ triggers: [] as TrTrigger[] }),
          )
          .then(({ triggers }) => setTrTriggers(triggers.filter((t) => t.job_id === trId))),
      )
      .catch(() => {});
  }, [trId]);

  const watches = trTriggers.flatMap((t) => t.watches);
  const policy = trTriggers[0]?.policy ?? "any";
  const statusStr = tr?.status ?? "draft";
  const statusClass = statusStr === "draft" ? "idle" : statusStr;

  async function dryRun() {
    const sql = edRef.current?.getDoc() ?? tr?.sql ?? "";
    if (!sql.trim()) return;
    setRunning(true);
    setResult(null);
    const res = await ctx.execute(sql, { source: name || tr?.name || "transform" });
    setResult(res);
    setRunning(false);
  }

  async function save() {
    const sql = edRef.current?.getDoc() ?? tr?.sql ?? "";
    setSaving(true);
    setSaveError(null);
    try {
      const headers = { ...(await authHeaders()), "Content-Type": "application/json" };
      if (isNew) {
        const res = await fetch(`${WORKER_BASE}/api/transform-jobs`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: name || null,
            sql,
            output_table: outputTable,
            output_uri: outputUri,
            output_backend: outputBackend,
          }),
        });
        if (!res.ok) {
          const txt = await res.text();
          setSaveError(txt || "Failed to create transform");
          return;
        }
      } else {
        const res = await fetch(`${WORKER_BASE}/api/transform-jobs/${tr.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ name: name || null, sql }),
        });
        if (!res.ok) {
          const txt = await res.text();
          setSaveError(txt || "Failed to save transform");
          return;
        }
      }
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  const defaultSql =
    tr?.sql ??
    "-- New transform\nCREATE OR REPLACE TABLE my_table AS\nSELECT *\nFROM transactions;";

  return (
    <div class="wb-sql">
      <div class="wb-sql-toolbar" style={{ gap: 10 }}>
        <span class="wb-doc-kicker" style={{ textTransform: "none", letterSpacing: 0 }}>
          <TransformIcon size={13} />
        </span>
        {isNew ? (
          <input
            class="input input-sm font-mono"
            style={{ width: 220 }}
            placeholder="transform name"
            value={name}
            onChange={(e) => setName((e.target as HTMLInputElement).value)}
          />
        ) : (
          <span class="wb-sql-name" style={{ fontWeight: 600, color: "var(--color-base-content)" }}>
            {tr.name ?? tr.output_table}
          </span>
        )}
        <span class="wb-con-hint">→ output</span>
        {isNew ? (
          <input
            class="input input-sm font-mono"
            style={{ width: 160 }}
            placeholder="output_table"
            value={outputTable}
            onChange={(e) => setOutputTable((e.target as HTMLInputElement).value)}
          />
        ) : (
          <span class="wb-tag wb-tag-type">{tr.output_table}</span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={dryRun}
          disabled={!ctx.session.enabled || running}
        >
          {running ? <span class="loading loading-xs" /> : <PlayIcon size={13} />}
          Dry run
        </button>
        <button type="button" class="btn btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? <span class="loading loading-xs" /> : <SaveIcon size={13} />}
          {isNew ? "Create" : "Save"}
        </button>
      </div>

      {isNew && (
        <div class="wb-transform-config" style={{ flexWrap: "wrap", gap: 10 }}>
          <fieldset class="fieldset" style={{ margin: 0, flex: "1 1 200px" }}>
            <legend class="fieldset-legend">Output URI</legend>
            <input
              class="input input-sm font-mono w-full"
              placeholder="r2://bucket/path/table.parquet"
              value={outputUri}
              onChange={(e) => setOutputUri((e.target as HTMLInputElement).value)}
            />
          </fieldset>
          <fieldset class="fieldset" style={{ margin: 0, flex: "1 1 160px" }}>
            <legend class="fieldset-legend">Output backend</legend>
            <input
              class="input input-sm font-mono w-full"
              placeholder="primary-r2"
              value={outputBackend}
              onChange={(e) => setOutputBackend((e.target as HTMLInputElement).value)}
            />
          </fieldset>
        </div>
      )}

      {saveError && (
        <div
          class="alert alert-error"
          style={{ margin: "0 14px", borderRadius: "var(--radius-field)" }}
        >
          <span>{saveError}</span>
        </div>
      )}
      {saveOk && (
        <div
          class="alert alert-success"
          style={{ margin: "0 14px", borderRadius: "var(--radius-field)" }}
        >
          <span>{isNew ? "Transform created." : "Saved."}</span>
        </div>
      )}

      <div class="wb-sql-split">
        <div class="wb-transform-config">
          <span style={{ display: "flex", gap: 7, alignItems: "center" }}>
            watches:{" "}
            {watches.length > 0 ? (
              watches.map((w) => (
                <span key={w} class="badge badge-sm badge-outline font-mono">
                  {w}
                </span>
              ))
            ) : (
              <em class="wb-empty-inline">none</em>
            )}
          </span>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            trigger policy: <span class="badge badge-sm badge-ghost">{policy}</span>
          </span>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            status: <span class={`ds-status ds-status-${statusClass}`}>{statusStr}</span>
            {" · "}
            {fmtAgo(tr?.last_completed_at ?? tr?.last_run_at)}
          </span>
        </div>
        <div class="wb-sql-editor">
          <SqlEditor
            ref={edRef}
            value={defaultSql}
            schema={ctx.schema}
            autoFocus
            onChange={() => {}}
            onRun={dryRun}
          />
        </div>
        <div class="wb-result wb-scrollbar-thin">
          <ResultGrid result={result} running={running} />
        </div>
      </div>
    </div>
  );
}
