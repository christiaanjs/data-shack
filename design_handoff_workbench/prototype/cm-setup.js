// ============================================================================
// Data Shack Workbench — CodeMirror 6 setup
// Loaded as an ES module. Builds a small factory and publishes it on
// window.DSCodeMirror, then fires a "cm-ready" event so the React layer
// (loaded via Babel, separate scope) can mount editors once CM is available.
// ============================================================================
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, rectangularSelection,
  highlightSpecialChars,
} from "@codemirror/view";
import {
  syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput,
  foldGutter,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { tags as t } from "@lezer/highlight";

// Token colors are driven by CSS variables (defined per-theme in workbench.css)
// so light/dark switch for free with the rest of the app.
const dsHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier], color: "var(--cm-keyword)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--cm-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--cm-number)" },
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [t.operator, t.compareOperator, t.arithmeticOperator], color: "var(--cm-operator)" },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: "var(--cm-func)" },
  { tag: [t.propertyName], color: "var(--cm-prop)" },
  { tag: [t.typeName, t.className], color: "var(--cm-type)" },
  { tag: [t.punctuation, t.separator, t.bracket], color: "var(--cm-punct)" },
  { tag: [t.variableName, t.name], color: "var(--cm-text)" },
]);

const baseTheme = EditorView.theme({
  "&": {
    fontSize: "13px",
    backgroundColor: "transparent",
    color: "var(--cm-text)",
    height: "100%",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "10px 0",
    caretColor: "var(--color-primary)",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--cm-gutter)",
    border: "none",
    fontFamily: "var(--font-mono)",
  },
  ".cm-activeLine": { backgroundColor: "var(--cm-active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--cm-active-line)", color: "var(--cm-text)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-primary)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--cm-selection)",
  },
  ".cm-matchingBracket": { backgroundColor: "var(--cm-selection)", outline: "1px solid var(--color-primary)" },
  ".cm-selectionMatch": { backgroundColor: "var(--cm-selection)" },
  ".cm-tooltip": {
    backgroundColor: "var(--color-base-100)",
    border: "1px solid var(--color-base-300)",
    borderRadius: "var(--radius-field)",
    boxShadow: "0 8px 24px color-mix(in oklch, var(--color-base-content) 18%, transparent)",
    fontFamily: "var(--font-mono)",
  },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 8px", fontSize: "12px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--color-primary)",
    color: "var(--color-primary-content)",
  },
  ".cm-completionLabel": { fontFamily: "var(--font-mono)" },
  ".cm-completionDetail": { color: "var(--cm-comment)", fontStyle: "normal", marginLeft: "1em" },
});

function create(opts = {}) {
  const {
    parent, doc = "", schema = {}, editable = true,
    onChange, onRun, oneLine = false, placeholder: ph,
  } = opts;

  const langCompartment = new Compartment();
  const editCompartment = new Compartment();

  const runKey = keymap.of([
    { key: "Mod-Enter", preventDefault: true, run: (v) => { onRun && onRun(v.state.doc.toString()); return true; } },
    { key: "Shift-Enter", preventDefault: true, run: (v) => { onRun && onRun(v.state.doc.toString()); return true; } },
  ]);

  const extensions = [
    runKey,
    history(),
    drawSelection(),
    rectangularSelection(),
    highlightSpecialChars(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    autocompletion({ activateOnTyping: true, icons: false }),
    syntaxHighlighting(dsHighlight),
    baseTheme,
    keymap.of([
      ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap,
      ...completionKeymap, ...searchKeymap, indentWithTab,
    ]),
    langCompartment.of(sql({ dialect: PostgreSQL, schema, upperCaseKeywords: false })),
    editCompartment.of(EditorView.editable.of(editable)),
    EditorView.updateListener.of((u) => { if (u.docChanged && onChange) onChange(u.state.doc.toString()); }),
  ];

  if (!oneLine) {
    extensions.push(lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), foldGutter());
  } else {
    extensions.push(EditorState.transactionFilter.of((tr) =>
      tr.newDoc.lines > 1 ? [] : tr));
  }

  const view = new EditorView({ doc, parent, extensions });

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    setSchema: (s) => view.dispatch({ effects: langCompartment.reconfigure(sql({ dialect: PostgreSQL, schema: s, upperCaseKeywords: false })) }),
    setEditable: (e) => view.dispatch({ effects: editCompartment.reconfigure(EditorView.editable.of(e)) }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

window.DSCodeMirror = { create, ready: true };
window.dispatchEvent(new Event("cm-ready"));
