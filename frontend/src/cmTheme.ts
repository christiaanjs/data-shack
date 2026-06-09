import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const dsHighlight = HighlightStyle.define([
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

export const baseTheme = EditorView.theme({
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

export const cmSyntaxHighlighting = syntaxHighlighting(dsHighlight);
