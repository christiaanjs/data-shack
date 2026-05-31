import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
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
import { forwardRef } from "preact/compat";
import { useEffect, useImperativeHandle, useRef } from "preact/hooks";
import { baseTheme, cmSyntaxHighlighting } from "./cmTheme.ts";

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
