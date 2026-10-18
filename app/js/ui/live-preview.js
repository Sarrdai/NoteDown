// Obsidian-style live preview for CodeMirror: Markdown syntax is hidden and
// rendered on every line except the ones the cursor or selection touch,
// which stay raw for editing. Inline styles (bold, code, links) come from
// the highlight style; this plugin hides marks, draws list markers and
// checkboxes, and adds the line classes for headings, quotes and code.
// An embedded image or video shows as in the rendered note, by this
// device's setting for the note's circle (`mediaMode`, ui/external.js).
import { Decoration, ViewPlugin, WidgetType, EditorView, StateField, syntaxTree, HighlightStyle, syntaxHighlighting, tags } from "../../vendor/codemirror.esm.js";
import { mediaSource, mediaKind } from "../core/external.js";
import { fillMedia } from "./external.js";
import { counterStart, counterAt, counters, changeCounter, counterHtml } from "../core/counter.js";
import { counterClick, fillWatches } from "./counter.js";
import { ratingStart, ratingAt, ratings, ratingHtml, setRating } from "../core/rating.js";
import { holdForStates } from "./task-menu.js";
import { DUE_AT_END, lineDue, setLineDue } from "../core/task-due.js";
import { DONE_AT_END, TASK_LINE, setLineState } from "../core/markdown.js";
import { today } from "./format.js";
import { openTaskDueMenu, fillTaskDue } from "./due-menu.js";

/** The media setting of the edited note's circle: auto | click | never (set with mediaMode.init). */
export const mediaMode = StateField.define({ create: () => "click", update: v => v });

const INDENT_EM = 1.5;

class BulletWidget extends WidgetType {
  constructor(level, text) { super(); this.level = level; this.text = text; }
  eq(o) { return o.level === this.level && o.text === this.text; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-bullet";
    s.style.width = markerWidth(this.level, false);
    s.textContent = this.text;
    return s;
  }
}

// A task's box; a tap ticks it (in progress → done, cancelled → open), a
// long-press or right-click picks its state (ui/task-menu.js). `pos` is the
// state character's position in the doc.
class CheckboxWidget extends WidgetType {
  constructor(level, state, pos) { super(); this.level = level; this.state = state; this.pos = pos; }
  eq(o) { return o.level === this.level && o.state === this.state && o.pos === this.pos; }
  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-task";
    wrap.style.width = markerWidth(this.level, true);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "task";
    box.checked = this.state === "done";
    if (this.state === "doing" || this.state === "cancelled") box.dataset.state = this.state;
    // Ticked, the line gets today's done date; any other state drops it (core/markdown.js → setLineState).
    const set = state => {
      const line = view.state.doc.lineAt(this.pos);
      view.dispatch({ changes: { from: line.from, to: line.to, insert: setLineState(line.text, state, today()) }, userEvent: "input" });
    };
    // Toggle without moving the cursor onto the line.
    box.addEventListener("mousedown", e => e.preventDefault());
    box.addEventListener("click", e => {
      e.preventDefault();
      set(this.state === "open" || this.state === "doing" ? "done" : "open");
    });
    holdForStates(box, set);
    wrap.append(box);
    return wrap;
  }
  ignoreEvent() { return true; }
}

// A counter (core/counter.js) as its chip; the steps it pops up and its
// stopwatch change it at `from` without moving the cursor onto the line.
class CounterWidget extends WidgetType {
  constructor(counter, from) { super(); this.counter = counter; this.from = from; }
  eq(o) { return o.counter.raw === this.counter.raw && o.from === this.from; }
  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.innerHTML = counterHtml(this.counter);
    fillWatches(wrap);
    const el = wrap.firstChild;
    el.addEventListener("mousedown", e => e.preventDefault());
    // The counter is read anew on each change: the floating buttons (ui/counter.js) outlive this widget.
    el.addEventListener("click", e => counterClick(e, change => {
      const line = view.state.doc.lineAt(this.from);
      const index = counters(line.text).findIndex(c => c.from === this.from - line.from);
      if (index < 0) return;
      const text = changeCounter(line.text, index, change);
      if (text !== line.text) view.dispatch({ changes: { from: line.from, to: line.to, insert: text }, userEvent: "input" });
    }));
    return el;
  }
  ignoreEvent() { return true; }
}

// A star rating (core/rating.js); a tap sets it at `from` without moving the cursor onto the line.
class RatingWidget extends WidgetType {
  constructor(rating, from) { super(); this.rating = rating; this.from = from; }
  eq(o) { return o.rating.raw === this.rating.raw && o.from === this.from; }
  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.innerHTML = ratingHtml(this.rating);
    const el = wrap.firstChild;
    el.addEventListener("mousedown", e => e.preventDefault());
    el.addEventListener("click", e => {
      const star = e.target.closest(".star");
      if (!star) return;
      const line = view.state.doc.lineAt(this.from);
      const index = ratings(line.text).findIndex(r => r.from === this.from - line.from);
      if (index < 0) return;
      const text = setRating(line.text, index, Number(star.dataset.star));
      if (text !== line.text) view.dispatch({ changes: { from: line.from, to: line.to, insert: text }, userEvent: "input" });
    });
    return el;
  }
  ignoreEvent() { return true; }
}

// A task's due date (backlog #41) as its chip; a tap opens the due-date menu without moving the cursor onto the line.
class TaskDueWidget extends WidgetType {
  constructor(due, from, plain) { super(); this.due = due; this.from = from; this.plain = plain; }
  eq(o) { return o.due === this.due && o.from === this.from && o.plain === this.plain; }
  toDOM(view) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.due = this.due;
    fillTaskDue(chip, { plain: this.plain });
    chip.addEventListener("mousedown", e => e.preventDefault());
    chip.addEventListener("click", () => openTaskDueMenu(chip, this.due, due => setDueAt(view, this.from, due)));
    return chip;
  }
  ignoreEvent() { return true; }
}

// Sets the due date of the task on the line at `pos`.
function setDueAt(view, pos, due) {
  const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
  const text = setLineDue(line.text, due);
  if (text !== line.text) view.dispatch({ changes: { from: line.from, to: line.to, insert: text }, userEvent: "input" });
}

class MediaWidget extends WidgetType {
  constructor(src, alt, mode) { super(); this.src = src; this.alt = alt; this.mode = mode; }
  eq(o) { return o.src === this.src && o.alt === this.alt && o.mode === this.mode; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "ext-media";
    const src = mediaSource(this.src);
    Object.assign(el.dataset, { kind: mediaKind(this.src), alt: this.alt }, src ? { src } : {});
    fillMedia(el, this.mode);
    return el;
  }
  // The tile loads and a video plays without moving the cursor onto the line.
  ignoreEvent(e) { return !!e.target.closest?.(".ext-tile, video"); }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-lp-hr"; return s; }
}

function markerWidth(level, task) {
  return `calc(${level * INDENT_EM}em + ${task ? "28px" : "1.4em"})`;
}

const hide = Decoration.replace({});

function build(view) {
  const { state } = view;
  const doc = state.doc;
  const active = new Set();
  if (view.hasFocus) {
    for (const r of state.selection.ranges) {
      for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l);
    }
  }
  const lineActive = pos => active.has(doc.lineAt(pos).number);
  const deco = [];
  const lineClass = (from, to, cls) => {
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) {
      deco.push(Decoration.line({ class: cls }).range(doc.line(l).from));
    }
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(node) {
        const name = node.name;
        const h = /^ATXHeading(\d)$/.exec(name);
        if (h) { lineClass(node.from, node.from, "cm-lp-h" + h[1]); return; }
        if (name === "Blockquote") { lineClass(node.from, node.to, "cm-lp-quote"); return; }
        if (name === "FencedCode") { lineClass(node.from, node.to, "cm-lp-codeblock"); return false; }
        if (name === "HorizontalRule") {
          if (!lineActive(node.from)) deco.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
          return;
        }
        if (lineActive(node.from)) return;
        if (name === "Image") {
          const m = /^!\[([^\]]*)\]\(\s*<?([^\s>)]+)/.exec(doc.sliceString(node.from, node.to));
          if (m) deco.push(Decoration.replace({ widget: new MediaWidget(m[2], m[1], state.field(mediaMode)) }).range(node.from, node.to));
          return false;
        }
        if (name === "HeaderMark") {
          const line = doc.lineAt(node.from);
          const opening = node.from - line.from <= 3;
          const start = opening ? node.from : skipSpacesBack(doc, node.from, line.from);
          const end = opening ? Math.min(node.to + 1, line.to) : node.to;
          if (end > start) deco.push(hide.range(start, end));
        } else if (name === "EmphasisMark" || name === "StrikethroughMark" || name === "LinkMark") {
          deco.push(hide.range(node.from, node.to));
        } else if (name === "CodeMark" && node.node.parent && node.node.parent.name === "InlineCode") {
          deco.push(hide.range(node.from, node.to));
        } else if (name === "URL" && node.node.parent && node.node.parent.name === "Link") {
          deco.push(hide.range(node.from, node.to));
        } else if (name === "LinkTitle") {
          deco.push(hide.range(node.from, node.to));
        } else if (name === "QuoteMark") {
          deco.push(hide.range(node.from, Math.min(node.to + 1, doc.lineAt(node.from).to)));
        } else if (name === "ListMark") {
          listMarker(node, doc, deco);
        }
      },
    });
  }
  for (const { from, to } of view.visibleRanges) {
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) {
      counterMarks(doc.line(l), state, deco, active.has(l));
      ratingMarks(doc.line(l), state, deco, active.has(l));
      taskDueMarks(doc.line(l), state, deco, active.has(l));
      highlightMarks(doc.line(l), state, deco, active.has(l));
    }
  }
  return Decoration.set(deco, true);
}

// The counters of a line outside code, each replaced by its widget; on a raw
// line the steps' brackets just don't look like a link.
const rawCounter = Decoration.mark({ class: "cm-lp-counter-raw" });
function counterMarks(line, state, deco, raw) {
  let at = 0;
  for (let i; (i = counterStart(line.text.slice(at))) >= 0;) {
    const start = at + i;
    const c = counterAt(line.text.slice(start));
    at = start + c.raw.length;
    const pos = line.from + start;
    let code = false;
    for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) if (/Code/.test(n.name)) code = true;
    if (code) continue;
    if (raw) deco.push(rawCounter.range(pos, line.from + at));
    else deco.push(Decoration.replace({ widget: new CounterWidget(c, pos) }).range(pos, line.from + at));
  }
}

const inCode = (state, pos) => {
  for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) if (/Code/.test(n.name)) return true;
  return false;
};

// The ratings of a line outside code become widgets on lines that aren't being edited.
function ratingMarks(line, state, deco, raw) {
  if (raw) return;
  let at = 0;
  for (let i; (i = ratingStart(line.text.slice(at))) >= 0;) {
    const start = at + i;
    const r = ratingAt(line.text.slice(start));
    at = start + r.raw.length;
    const pos = line.from + start;
    if (!inCode(state, pos)) deco.push(Decoration.replace({ widget: new RatingWidget(r, pos) }).range(pos, line.from + at));
  }
}

// A task line's due date becomes its chip on lines that aren't being edited; a done or cancelled task's is plain.
// A done date (core/markdown.js → DONE_AT_END) is hidden there too: it only counts the task for "done today".
function taskDueMarks(line, state, deco, raw) {
  if (raw || !TASK_LINE.test(line.text) || inCode(state, line.from)) return;
  const done = DONE_AT_END.exec(line.text);
  const text = done ? line.text.slice(0, done.index) : line.text;
  if (done) deco.push(hide.range(line.from + done.index, line.to));
  if (!lineDue(text)) return;
  const m = DUE_AT_END.exec(text);
  const box = /\[([ xX/-])\]/.exec(line.text)[1];
  const plain = box !== " " && box !== "/";
  const from = line.from + m.index + (m[0].length - m[0].trimStart().length);
  deco.push(Decoration.replace({ widget: new TaskDueWidget(m[1], from, plain) }).range(from, line.from + text.length));
}

// ==text== : the text is highlighted; the marks hide on lines that aren't being edited.
const hlMark = Decoration.mark({ class: "cm-lp-hl" });
function highlightMarks(line, state, deco, raw) {
  const re = /==(?!=)([^\n]*?[^\s=])==(?!=)/g;
  for (const m of line.text.matchAll(re)) {
    const pos = line.from + m.index;
    if (inCode(state, pos)) continue;
    const end = pos + m[0].length;
    deco.push(hlMark.range(pos + 2, end - 2));
    if (!raw) deco.push(hide.range(pos, pos + 2), hide.range(end - 2, end));
  }
}

function listMarker(node, doc, deco) {
  const line = doc.lineAt(node.from);
  const indent = line.text.slice(0, node.from - line.from);
  if (/\S/.test(indent)) return; // a marker after a quote mark etc. stays raw
  const level = Math.floor(indent.replace(/\t/g, "  ").length / 2);
  const item = node.node.parent;
  const task = item && item.getChild("Task");
  const marker = task && task.getChild("TaskMarker");
  let end = Math.min(node.to + 1, line.to);
  let widget;
  // GFM's parser knows `[ ]` and `[x]`; in progress `[/]` and cancelled `[-]` are found here.
  const other = !marker && /^ \[([/-])\] +\S/.exec(doc.sliceString(node.to, line.to));
  const box = marker && marker.from >= node.to && marker.from - node.to <= 1 ? marker.from
    : other ? node.to + 1 : -1;
  if (box >= 0) {
    const state = { " ": "open", x: "done", X: "done", "/": "doing", "-": "cancelled" }[doc.sliceString(box + 1, box + 2)];
    end = Math.min(box + 4, line.to);
    widget = new CheckboxWidget(level, state, box + 1);
    if (state === "done" || state === "cancelled") deco.push(Decoration.mark({ class: "cm-lp-done" }).range(end, line.to));
  } else {
    const text = doc.sliceString(node.from, node.to);
    widget = new BulletWidget(level, /^\d/.test(text) ? text : "•");
  }
  const width = markerWidth(level, widget instanceof CheckboxWidget);
  deco.push(Decoration.line({ attributes: { style: `padding-left: ${width}; text-indent: calc(-1 * ${width})` } }).range(line.from));
  deco.push(Decoration.replace({ widget }).range(line.from, end));
}

function skipSpacesBack(doc, pos, min) {
  while (pos > min && doc.sliceString(pos - 1, pos) === " ") pos--;
  return pos;
}

export const livePreview = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = build(view); }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) this.decorations = build(u.view);
  }
}, { decorations: v => v.decorations });

// Inline styles that hold on raw and rendered lines alike; marks are dimmed.
export const markdownHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.processingInstruction, color: "var(--text-faint)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.monospace, fontFamily: "var(--mono)", fontSize: "0.88em", background: "var(--code-bg)", borderRadius: "5px" },
  { tag: tags.link, color: "var(--link)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--text-faint)" },
  { tag: tags.quote, color: "var(--text-muted)" },
  { tag: tags.heading, fontWeight: "700" },
]));

export const previewTheme = EditorView.theme({
  "&": { background: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { padding: "0", fontFamily: "inherit", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
});
