/* ============================================================================
   Data Shack Workbench — shared primitives + CodeMirror React wrapper
   Babel-scoped; everything is exported to window at the end.
   ============================================================================ */
const { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } = React;

const cls = (...a) => a.filter(Boolean).join(" ");

/* ── Icons ────────────────────────────────────────────────────────────────
   NOTE: Data Shack ships NO icon library. These are Lucide line-icon paths,
   used here because a true IDE shell needs them (activity rail, tree, tabs).
   This is a *flagged substitution* — see the README iconography section.   */
const WB_ICONS = {
  files: '<path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  table: '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  transform: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  job: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  drive: '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  signout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  corner: '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  list: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
};
function Icon({ name, size = 16, stroke = 1.6, className = "", style }) {
  const d = WB_ICONS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style} aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: d || "" }} />
  );
}

/* ── Buttons / badges / dots ───────────────────────────────────────────── */
function Btn({ variant = "", size = "sm", loading = false, disabled = false, children, onClick, title, className = "" }) {
  return (
    <button type="button" title={title}
      className={cls("btn", variant && `btn-${variant}`, size && `btn-${size}`, (disabled || loading) && "btn-disabled", className)}
      onClick={disabled || loading ? undefined : onClick}>
      {loading && <span className="loading loading-xs"></span>}
      {children}
    </button>
  );
}
function Badge({ variant = "ghost", size = "sm", mono = false, children, onClick, title, className = "" }) {
  return (
    <span title={title} onClick={onClick}
      className={cls("badge", `badge-${variant}`, size && `badge-${size}`, mono && "font-mono", className)}
      style={onClick ? { cursor: "pointer" } : undefined}>{children}</span>
  );
}
function Dot({ state }) { return <span className={`dot dot-${state}`}></span>; }
function Spinner({ size = "sm" }) { return <span className={`loading loading-${size}`}></span>; }
function Field({ legend, hint, children, full }) {
  return (
    <fieldset className="fieldset" style={full ? { gridColumn: "1 / -1" } : undefined}>
      <legend className="fieldset-legend">{legend}</legend>
      {children}
      {hint && <span className="ds-fieldhint" style={{ fontSize: 11, color: "color-mix(in oklch, var(--color-base-content) 50%, transparent)", marginTop: 2 }}>{hint}</span>}
    </fieldset>
  );
}

/* ── localStorage hook ──────────────────────────────────────────────────── */
function useLocalStorage(key, initial) {
  const [val, setVal] = useState(() => {
    try { const s = localStorage.getItem(key); return s != null ? JSON.parse(s) : initial; }
    catch { return initial; }
  });
  const set = useCallback((v) => {
    setVal((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [key]);
  return [val, set];
}

/* ── CodeMirror readiness ──────────────────────────────────────────────── */
function useCmReady() {
  const [ready, setReady] = useState(() => !!(window.DSCodeMirror && window.DSCodeMirror.ready));
  useEffect(() => {
    if (ready) return;
    const on = () => setReady(true);
    window.addEventListener("cm-ready", on);
    // poll as a belt-and-braces in case the event fired before mount
    const iv = setInterval(() => { if (window.DSCodeMirror && window.DSCodeMirror.ready) { setReady(true); clearInterval(iv); } }, 120);
    return () => { window.removeEventListener("cm-ready", on); clearInterval(iv); };
  }, [ready]);
  return ready;
}

/* ── SqlEditor — CodeMirror 6 wrapper with textarea fallback ────────────── */
const SqlEditor = forwardRef(function SqlEditor(
  { value = "", schema = {}, editable = true, oneLine = false, autoFocus = false, onChange, onRun, className = "" }, ref) {
  const hostRef = useRef(null);
  const cmRef = useRef(null);
  const taRef = useRef(null);
  const ready = useCmReady();
  const [fellBack, setFellBack] = useState(false);
  const cbRef = useRef({ onChange, onRun });
  cbRef.current = { onChange, onRun };

  // If CM hasn't loaded after a grace period, fall back to a styled textarea.
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setFellBack(true), 6000);
    return () => clearTimeout(t);
  }, [ready]);

  useEffect(() => {
    if (!ready || !hostRef.current || cmRef.current) return;
    cmRef.current = window.DSCodeMirror.create({
      parent: hostRef.current, doc: value, schema, editable, oneLine,
      onChange: (t) => cbRef.current.onChange && cbRef.current.onChange(t),
      onRun: (t) => cbRef.current.onRun && cbRef.current.onRun(t),
    });
    if (autoFocus) setTimeout(() => cmRef.current && cmRef.current.focus(), 30);
    return () => { if (cmRef.current) { cmRef.current.destroy(); cmRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // keep schema fresh when the catalog changes
  useEffect(() => { if (cmRef.current) cmRef.current.setSchema(schema); }, [JSON.stringify(schema)]);

  useImperativeHandle(ref, () => ({
    getDoc: () => cmRef.current ? cmRef.current.getDoc() : (taRef.current ? taRef.current.value : value),
    setDoc: (t) => { if (cmRef.current) cmRef.current.setDoc(t); else if (taRef.current) taRef.current.value = t; },
    focus: () => { if (cmRef.current) cmRef.current.focus(); else if (taRef.current) taRef.current.focus(); },
  }), [value]);

  if (ready && !fellBack) return <div ref={hostRef} className={cls("wb-cm-host", className)} style={{ height: "100%" }} />;
  if (!fellBack) return <div className={cls("wb-cm-host", className)} style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "color-mix(in oklch, var(--color-base-content) 45%, transparent)", fontSize: 12, gap: 8 }}><Spinner size="sm" /> Loading editor…</div>;
  // textarea fallback
  return (
    <textarea ref={taRef} defaultValue={value} spellCheck={false}
      className={cls("font-mono", className)} readOnly={!editable}
      onChange={(e) => onChange && onChange(e.target.value)}
      onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); onRun && onRun(e.target.value); } }}
      style={{ width: "100%", height: "100%", border: 0, outline: "none", resize: "none", background: "transparent", color: "var(--color-base-content)", padding: "10px 14px", fontSize: 13, lineHeight: 1.6 }} />
  );
});

Object.assign(window, { cls, Icon, WB_ICONS, Btn, Badge, Dot, Spinner, Field, useLocalStorage, useCmReady, SqlEditor });
