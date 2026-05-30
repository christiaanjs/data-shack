import { useEffect, useRef, useState } from "preact/hooks";
import { HistoryIcon, PlayIcon, RefreshIcon, TerminalIcon, XIcon } from "./wbIcons.tsx";
import type { HistoryEntry, LogEntry, WbCtx } from "./workbench-types.ts";

interface ConsoleDockProps {
  ctx: WbCtx;
  log: LogEntry[];
  history: HistoryEntry[];
  dockTab: "console" | "history";
  setDockTab: (tab: "console" | "history") => void;
  onClear: () => void;
  onClose: () => void;
}

export function ConsoleDock({
  ctx,
  log,
  history,
  dockTab,
  setDockTab,
  onClear,
  onClose,
}: ConsoleDockProps) {
  const [input, setInput] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const logRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on log length change
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log.length, dockTab]);

  function submit() {
    const s = input.trim();
    if (!s) return;
    ctx.execute(s, { source: "console" });
    setInput("");
    setHistIdx(-1);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const ni = Math.min(histIdx + 1, history.length - 1);
      if (ni >= 0 && history[ni]) {
        setHistIdx(ni);
        setInput(history[ni].sql.replace(/\s+/g, " "));
      }
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const ni = histIdx - 1;
      if (ni < 0) {
        setHistIdx(-1);
        setInput("");
      } else {
        setHistIdx(ni);
        setInput(history[ni].sql.replace(/\s+/g, " "));
      }
    }
  }

  return (
    <>
      <div class="wb-dock-head">
        <button
          type="button"
          class={`wb-dock-tab${dockTab === "console" ? " active" : ""}`}
          onClick={() => setDockTab("console")}
        >
          <TerminalIcon size={13} />
          Console
        </button>
        <button
          type="button"
          class={`wb-dock-tab${dockTab === "history" ? " active" : ""}`}
          onClick={() => setDockTab("history")}
        >
          <HistoryIcon size={13} />
          History<span class="wb-badge-n">{history.length}</span>
        </button>
        <span class="wb-dock-spacer" />
        <div class="wb-dock-tools">
          <button type="button" class="wb-iconbtn" title="Clear" onClick={onClear}>
            <RefreshIcon size={14} />
          </button>
          <button type="button" class="wb-iconbtn" title="Hide panel" onClick={onClose}>
            <XIcon size={15} />
          </button>
        </div>
      </div>
      <div class="wb-dock-body">
        {dockTab === "console" ? (
          <div class="wb-console">
            <div class="wb-con-log wb-scrollbar-thin" ref={logRef}>
              {log.length === 0 && (
                <div class="wb-con-out" style={{ paddingLeft: 14 }}>
                  {ctx.session.enabled
                    ? "DuckDB-WASM session ready. Type SQL below or run a query from any tab."
                    : "Enable the DuckDB toggle to run queries."}
                </div>
              )}
              {log.map((e) => (
                <div class="wb-con-entry" key={e.id}>
                  <div class="wb-con-cmd">
                    <span class="wb-con-prompt">{e.source === "console" ? "dshk>" : "·"}</span>
                    <span class="wb-con-sql">
                      {e.sql.replace(/\s+/g, " ").slice(0, 240)}
                      {e.source !== "console" && <span class="wb-con-time"> ({e.source})</span>}
                    </span>
                  </div>
                  <LogLine entry={e} />
                </div>
              ))}
            </div>
            <div class="wb-con-input">
              <span class="wb-con-prompt">dshk&gt;</span>
              <input
                value={input}
                placeholder="SELECT … (↑ history · ↵ run)"
                spellcheck={false}
                onChange={(e) => setInput((e.target as HTMLInputElement).value)}
                onKeyDown={onKey}
                disabled={!ctx.session.enabled}
              />
              {!ctx.session.enabled && (
                <span class="wb-con-hint" style={{ color: "var(--color-warning)" }}>
                  session disabled
                </span>
              )}
            </div>
          </div>
        ) : (
          <div class="wb-hist wb-scrollbar-thin">
            {history.length === 0 && (
              <div class="wb-con-out" style={{ padding: 14 }}>
                No queries yet. Run something to build history.
              </div>
            )}
            {history.map((h, i) => (
              <button
                type="button"
                class="wb-hist-row"
                // biome-ignore lint/suspicious/noArrayIndexKey: history has no stable id
                key={`h-${i}`}
                onClick={() => ctx.openTab("sql", { title: "History", sql: h.sql })}
              >
                <span class="wb-hist-sql">{h.sql.replace(/\s+/g, " ")}</span>
                <span class="wb-hist-meta">
                  {h.rows != null ? `${h.rows} rows` : "err"} · {h.when}
                </span>
                <span class="wb-hist-actions">
                  <button
                    type="button"
                    class="wb-iconbtn"
                    title="Run in console"
                    style={{ width: 22, height: 22 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      ctx.execute(h.sql, { source: "console" });
                      setDockTab("console");
                    }}
                  >
                    <PlayIcon size={12} />
                  </button>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const r = entry.result;
  if (!r) return <div class="wb-con-out ok">→ ok · {entry.ms} ms</div>;
  if (r.error) return <div class="wb-con-out err">✕ {r.error}</div>;
  return (
    <div class="wb-con-out ok">
      → {r.rows.length} row{r.rows.length === 1 ? "" : "s"} · {r.columns.length} cols ·{" "}
      <span class="wb-con-time">{entry.ms} ms</span>
      {r.rows[0] && <div class="wb-con-minirow"> {r.columns.join(" │ ")}</div>}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────
