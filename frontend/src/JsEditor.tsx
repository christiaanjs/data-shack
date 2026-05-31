import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import type { CompletionSource } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
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

export interface JsEditorHandle {
  getDoc: () => string;
  setDoc: (text: string) => void;
  focus: () => void;
}

interface JsEditorProps {
  value?: string;
  autoFocus?: boolean;
  onChange?: (value: string) => void;
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

const RECHARTS_COMPLETIONS = [
  "BarChart",
  "LineChart",
  "PieChart",
  "AreaChart",
  "ScatterChart",
  "Bar",
  "Line",
  "Area",
  "Pie",
  "Scatter",
  "Cell",
  "XAxis",
  "YAxis",
  "ZAxis",
  "CartesianGrid",
  "Tooltip",
  "Legend",
  "ResponsiveContainer",
  "ReferenceLine",
  "ReferenceArea",
];

const REACT_HOOK_COMPLETIONS = ["useState", "useEffect", "useMemo", "useCallback"];

const dashboardCompletionSource: CompletionSource = (context) => {
  const word = context.matchBefore(/\w*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  const options = [
    {
      label: "data",
      type: "variable",
      detail: "Record<string, unknown>[][]",
      info: "Array of query results — each element is an array of row objects",
    },
    ...RECHARTS_COMPLETIONS.map((label) => ({
      label,
      type: "class",
      detail: "recharts",
    })),
    ...REACT_HOOK_COMPLETIONS.map((label) => ({
      label,
      type: "function",
      detail: "react",
    })),
  ];

  return { from: word.from, options };
};

export const JsEditor = forwardRef<JsEditorHandle, JsEditorProps>(function JsEditor(
  { value = "", autoFocus = false, onChange, class: className = "" },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cbRef = useRef({ onChange });
  cbRef.current = { onChange };

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only setup
  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;

    const extensions = [
      history(),
      drawSelection(),
      rectangularSelection(),
      highlightSpecialChars(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      autocompletion({
        activateOnTyping: true,
        icons: false,
        override: [dashboardCompletionSource],
      }),
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
      javascript({ jsx: true }),
      EditorView.editable.of(true),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) cbRef.current.onChange?.(u.state.doc.toString());
      }),
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      foldGutter(),
      EditorState.tabSize.of(2),
    ];

    viewRef.current = new EditorView({ doc: value, parent: hostRef.current, extensions });
    if (autoFocus) setTimeout(() => viewRef.current?.focus(), 30);

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
