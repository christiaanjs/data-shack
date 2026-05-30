import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef } from "preact/compat";
import { useEffect, useImperativeHandle, useRef } from "preact/hooks";

export type SqlSchema = Record<string, string[]>;

export interface SqlEditorHandle {
  getDoc: () => string;
  setDoc: (text: string) => void;
  focus: () => void;
}

interface SqlEditorProps {
  value?: string;
  schema?: SqlSchema;
  editable?: boolean;
  oneLine?: boolean;
  autoFocus?: boolean;
  onChange?: (value: string) => void;
  onRun?: (value: string) => void;
  class?: string;
}

const dsHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier], color: "var(--cm-keyword)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--cm-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--cm-number)" },
  {
    tag: [t.lineComment, t.blockComment, t.comment],
    color: "var(--cm-comment)",
    fontStyle: "italic",
  },
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
    fontFamily: "var(--font-mono, monospace)",
    padding: "10px 0",
    caretColor: "var(--color-primary)",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono, monospace)", lineHeight: "1.6" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--cm-gutter)",
    border: "none",
    fontFamily: "var(--font-mono, monospace)",
  },
  ".cm-activeLine": { backgroundColor: "var(--cm-active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--cm-active-line)", color: "var(--cm-text)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-primary)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--cm-selection)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "var(--cm-selection)",
    outline: "1px solid var(--color-primary)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--cm-selection)" },
  ".cm-tooltip": {
    backgroundColor: "var(--color-base-100)",
    border: "1px solid var(--color-base-300)",
    borderRadius: "var(--radius-field, 0.25rem)",
    boxShadow: "0 8px 24px color-mix(in oklch, var(--color-base-content) 18%, transparent)",
    fontFamily: "var(--font-mono, monospace)",
  },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 8px", fontSize: "12px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--color-primary)",
    color: "var(--color-primary-content)",
  },
  ".cm-completionLabel": { fontFamily: "var(--font-mono, monospace)" },
  ".cm-completionDetail": { color: "var(--cm-comment)", fontStyle: "normal", marginLeft: "1em" },
});

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  {
    value = "",
    schema = {},
    editable = true,
    oneLine = false,
    autoFocus = false,
    onChange,
    onRun,
    class: className = "",
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartmentRef = useRef(new Compartment());
  const editCompartmentRef = useRef(new Compartment());
  const cbRef = useRef({ onChange, onRun });
  cbRef.current = { onChange, onRun };

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only setup, deps are stable refs
  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    const langCompartment = langCompartmentRef.current;
    const editCompartment = editCompartmentRef.current;

    const runKey = keymap.of([
      {
        key: "Mod-Enter",
        preventDefault: true,
        run: (v) => {
          cbRef.current.onRun?.(v.state.doc.toString());
          return true;
        },
      },
      {
        key: "Shift-Enter",
        preventDefault: true,
        run: (v) => {
          cbRef.current.onRun?.(v.state.doc.toString());
          return true;
        },
      },
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
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      langCompartment.of(sql({ dialect: PostgreSQL, schema, upperCaseKeywords: false })),
      editCompartment.of(EditorView.editable.of(editable)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) cbRef.current.onChange?.(u.state.doc.toString());
      }),
    ];

    if (!oneLine) {
      extensions.push(
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        foldGutter(),
      );
    } else {
      extensions.push(EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr)));
    }

    viewRef.current = new EditorView({ doc: value, parent: hostRef.current, extensions });
    if (autoFocus) setTimeout(() => viewRef.current?.focus(), 30);

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep schema in sync
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reconfigure only when schema changes
  useEffect(() => {
    if (!viewRef.current) return;
    viewRef.current.dispatch({
      effects: langCompartmentRef.current.reconfigure(
        sql({ dialect: PostgreSQL, schema, upperCaseKeywords: false }),
      ),
    });
  }, [JSON.stringify(schema)]);

  // Keep editable in sync
  useEffect(() => {
    if (!viewRef.current) return;
    viewRef.current.dispatch({
      effects: editCompartmentRef.current.reconfigure(EditorView.editable.of(editable)),
    });
  }, [editable]);

  useImperativeHandle(ref, () => ({
    getDoc: () => viewRef.current?.state.doc.toString() ?? "",
    setDoc: (text: string) => {
      if (!viewRef.current) return;
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: text },
      });
    },
    focus: () => viewRef.current?.focus(),
  }));

  return (
    <div
      ref={hostRef}
      class={`wb-cm-host${className ? ` ${className}` : ""}`}
      style={{ height: "100%" }}
    />
  );
});
