// The note editor: CodeMirror with the live preview, Markdown shortcuts and
// the commands the toolbar calls. One editor exists at a time, mounted in
// place of the note's rendered body.
import {
  EditorState, EditorView, StateField, StateEffect, Decoration, WidgetType, keymap, drawSelection, Prec,
  history, historyKeymap, defaultKeymap, undo, redo, indentLess, indentMore,
  Language, defineLanguageFacet, markdownParser, GFM,
} from "../../vendor/codemirror.esm.js";
import { livePreview, markdownHighlight, previewTheme } from "./live-preview.js";
import {
  cycleHeading, toggleBullet, toggleTaskItem, toggleTaskChecked, indentLine, outdentLine,
  continueList, toggleWrap, insertLink, joinDictation,
} from "../core/md-commands.js";

const markdown = new Language(defineLanguageFacet(), markdownParser.configure([GFM]), [], "markdown");

// Interim dictation text, shown greyed at the cursor until it is final.
const setInterim = StateEffect.define();
class InterimWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-interim"; s.textContent = this.text; return s; }
}
const interimField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setInterim)) {
        value = e.value ? Decoration.set([Decoration.widget({ widget: new InterimWidget(e.value), side: 1 }).range(tr.state.selection.main.head)]) : Decoration.none;
      }
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

/** Replaces only the part of [from, from + old.length) that differs. */
function minimalChange(from, oldText, newText) {
  let a = 0;
  while (a < oldText.length && a < newText.length && oldText[a] === newText[a]) a++;
  let b = 0;
  while (b < oldText.length - a && b < newText.length - a && oldText[oldText.length - 1 - b] === newText[newText.length - 1 - b]) b++;
  return { from: from + a, to: from + oldText.length - b, insert: newText.slice(a, newText.length - b) };
}

function mapLines(view, fn) {
  const { state } = view;
  const seen = new Set();
  const changes = [];
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) {
      if (seen.has(l)) continue;
      seen.add(l);
      const line = state.doc.line(l);
      const text = fn(line.text);
      if (text !== line.text) changes.push(minimalChange(line.from, line.text, text));
    }
  }
  if (changes.length) view.dispatch({ changes, scrollIntoView: true, userEvent: "input" });
  return true;
}

// Bold / italic never wrap a line's list or heading marker.
function selectionEdit(view, fn) {
  const { state } = view;
  let { from, to } = state.selection.main;
  const line = state.doc.lineAt(from);
  const prefix = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|\s{0,3}#{1,6}\s+)/.exec(line.text);
  const start = line.from + (prefix ? prefix[0].length : 0);
  if (from < start) { from = start; to = Math.max(to, start); }
  const doc = view.state.doc.toString();
  const r = fn(doc, from, to);
  view.dispatch({ changes: minimalChange(0, doc, r.text), selection: { anchor: r.from, head: r.to }, scrollIntoView: true, userEvent: "input" });
  return true;
}

// Enter continues a list item, or ends the list on an empty item.
function enterInList(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false;
  const next = continueList(line.text);
  if (!next) return false;
  if (next.clear) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "" }, userEvent: "input" });
  } else {
    view.dispatch(state.replaceSelection("\n" + next.prefix), { scrollIntoView: true, userEvent: "input" });
  }
  return true;
}

export const COMMANDS = {
  heading: v => mapLines(v, cycleHeading),
  bullet: v => mapLines(v, toggleBullet),
  task: v => mapLines(v, toggleTaskItem),
  indent: v => mapLines(v, l => indentLine(l)),
  outdent: v => mapLines(v, l => outdentLine(l)),
  bold: v => selectionEdit(v, (t, f, to) => toggleWrap(t, f, to, "**")),
  italic: v => selectionEdit(v, (t, f, to) => toggleWrap(t, f, to, "*")),
  link: v => selectionEdit(v, insertLink),
  undo: v => undo(v),
  redo: v => redo(v),
};

export function createEditor({ parent, doc, onChange, onEscape }) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        markdown,
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        // Keep the caret clear of the sticky top bar and the toolbar.
        EditorView.scrollMargins.of(() => ({ top: 72, bottom: 96 })),
        EditorView.contentAttributes.of({ "aria-label": "Note text", spellcheck: "true", autocapitalize: "sentences" }),
        Prec.high(keymap.of([
          { key: "Enter", run: enterInList },
          { key: "Mod-b", run: COMMANDS.bold },
          { key: "Mod-i", run: COMMANDS.italic },
          { key: "Mod-k", run: COMMANDS.link },
          { key: "Mod-Enter", run: v => mapLines(v, toggleTaskChecked) },
          { key: "Tab", run: indentMore, shift: indentLess },
          { key: "Escape", run: () => { onEscape(); return true; } },
        ])),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        livePreview,
        markdownHighlight,
        previewTheme,
        interimField,
        EditorView.updateListener.of(u => { if (u.docChanged) onChange(u.state.doc.toString()); }),
      ],
    }),
  });

  return {
    view,
    /** Puts the caret where the user tapped the rendered note (or at the end). */
    focusAt(x, y) {
      const pos = x === undefined ? null : view.posAtCoords({ x, y }, false);
      const at = pos === null ? view.state.doc.length : pos;
      view.dispatch({ selection: { anchor: at } });
      view.focus();
    },
    run(name) { COMMANDS[name](view); view.focus(); },
    setInterim(text) { view.dispatch({ effects: setInterim.of(text) }); },
    insertDictation(text) {
      const { head } = view.state.selection.main;
      const before = view.state.doc.sliceString(Math.max(0, head - 1), head);
      const after = view.state.doc.sliceString(head, head + 1);
      let insert = joinDictation(before, text);
      if (!insert) return;
      if (/[^\s.,;:!?)]/.test(after)) insert += " ";
      view.dispatch({ changes: { from: head, insert }, selection: { anchor: head + insert.length }, scrollIntoView: true, userEvent: "input" });
    },
    text: () => view.state.doc.toString(),
    destroy: () => view.destroy(),
  };
}
