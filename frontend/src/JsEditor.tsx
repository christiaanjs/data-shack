import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import type { CompletionSource } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
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
import { forwardRef } from "preact/compat";
import { useEffect, useImperativeHandle, useRef } from "preact/hooks";
import { baseTheme, cmSyntaxHighlighting } from "./cmTheme.ts";

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
      cmSyntaxHighlighting,
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
