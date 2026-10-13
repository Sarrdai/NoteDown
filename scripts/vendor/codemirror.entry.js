// The parts of CodeMirror 6 the prototype's editor uses, bundled into one
// vendored ES module (app/vendor/codemirror.esm.js) so the app needs no
// build step. Add an export here and rebuild when the editor needs more.
export { EditorState, EditorSelection, StateField, StateEffect, RangeSetBuilder, Prec } from "@codemirror/state";
export { EditorView, Decoration, ViewPlugin, WidgetType, keymap, drawSelection, placeholder } from "@codemirror/view";
export { history, historyKeymap, defaultKeymap, undo, redo, indentLess, indentMore, insertNewlineAndIndent } from "@codemirror/commands";
export { Language, defineLanguageFacet, LanguageSupport, syntaxTree, syntaxHighlighting, HighlightStyle, indentUnit } from "@codemirror/language";
export { parser as markdownParser, GFM } from "@lezer/markdown";
export { tags } from "@lezer/highlight";
