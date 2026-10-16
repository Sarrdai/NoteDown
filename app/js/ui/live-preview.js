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
import { counterStart, COUNTER_AT, parseSteps, addStep, counterHtml } from "../core/counter.js";
import { counterClick } from "./counter.js";

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

class CheckboxWidget extends WidgetType {
  constructor(level, checked, pos) { super(); this.level = level; this.checked = checked; this.pos = pos; }
  eq(o) { return o.level === this.level && o.checked === this.checked && o.pos === this.pos; }
  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-task";
    wrap.style.width = markerWidth(this.level, true);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "task";
    box.checked = this.checked;
    // Toggle without moving the cursor onto the line.
    box.addEventListener("mousedown", e => e.preventDefault());
    box.addEventListener("click", e => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos, to: this.pos + 1, insert: this.checked ? " " : "x" }, userEvent: "input" });
    });
    wrap.append(box);
    return wrap;
  }
  ignoreEvent() { return true; }
}

// A counter (core/counter.js) as its chip; the steps it pops up change the
// number at `from` without moving the cursor onto the line.
class CounterWidget extends WidgetType {
  constructor(value, steps, from) { super(); this.value = value; this.steps = steps; this.from = from; }
  eq(o) { return o.value === this.value && o.steps.join() === this.steps.join() && o.from === this.from; }
  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.innerHTML = counterHtml(this.value, this.steps);
    const el = wrap.firstChild;
    el.addEventListener("mousedown", e => e.preventDefault());
    // The number is read anew on each step: the floating buttons (ui/counter.js) outlive this widget.
    el.addEventListener("click", e => counterClick(e, step => {
      const line = view.state.doc.lineAt(this.from);
      const m = COUNTER_AT.exec(line.text.slice(this.from - line.from));
      if (m) view.dispatch({ changes: { from: this.from, to: this.from + m[1].length, insert: addStep(m[1], step) }, userEvent: "input" });
    }));
    return el;
  }
  ignoreEvent() { return true; }
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
    const m = COUNTER_AT.exec(line.text.slice(start));
    at = start + m[0].length;
    const pos = line.from + start;
    let code = false;
    for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) if (/Code/.test(n.name)) code = true;
    if (code) continue;
    if (raw) deco.push(rawCounter.range(pos, line.from + at));
    else deco.push(Decoration.replace({ widget: new CounterWidget(m[1], parseSteps(m[2]), pos) }).range(pos, line.from + at));
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
  if (marker && marker.from >= node.to && marker.from - node.to <= 1) {
    const checked = /x/i.test(doc.sliceString(marker.from, marker.to));
    end = Math.min(marker.to + 1, line.to);
    widget = new CheckboxWidget(level, checked, marker.from + 1);
    if (checked) deco.push(Decoration.mark({ class: "cm-lp-done" }).range(end, line.to));
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
