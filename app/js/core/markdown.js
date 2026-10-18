// Markdown helpers on a note's body: rendering, headings and sections for
// the table of contents, the preview title, and the task checkboxes and their
// states in the source.
import { Marked } from "../../vendor/marked.esm.js";
import { LABEL_AT, LABEL_START } from "./labels.js";
import { mediaSource, mediaKind } from "./external.js";
import { counterAt, counterStart, counterHtml } from "./counter.js";
import { ratingAt, ratingStart, ratingHtml } from "./rating.js";
import { noteLinkId } from "./note-links.js";

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
  // Labels (core/labels.js) render as chips; a tap filters the list by them.
  extensions: [{
    name: "label",
    level: "inline",
    start(src) {
      const m = LABEL_START.exec(src);
      return m ? m.index + m[1].length : undefined;
    },
    tokenizer(src) {
      const m = LABEL_AT.exec(src);
      if (m) return { type: "label", raw: m[0], name: m[1] };
    },
    renderer({ name }) {
      return `<button type="button" class="label-chip" data-label="${escapeAttr(name)}">#${escapeHtml(name)}</button>`;
    },
  }, {
    // Counters (core/counter.js) render with their step buttons; the view maps a tap to the counter's index.
    name: "counter",
    level: "inline",
    start(src) {
      const i = counterStart(src);
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const c = counterAt(src);
      if (c) return { type: "counter", raw: c.raw, counter: c };
    },
    renderer({ counter }) {
      return counterHtml(counter);
    },
  }, {
    // Star ratings (core/rating.js); the view maps a tap to the rating's index.
    name: "rating",
    level: "inline",
    start(src) {
      const i = ratingStart(src);
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const r = ratingAt(src);
      if (r) return { type: "rating", raw: r.raw, rating: r };
    },
    renderer({ rating }) {
      return ratingHtml(rating);
    },
  }, {
    // Highlight: ==text== (Obsidian syntax).
    name: "highlight",
    level: "inline",
    start(src) {
      const i = src.indexOf("==");
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const m = /^==(?!=)([^\n]*?[^\s=])==(?!=)/.exec(src);
      if (m) return { type: "highlight", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
    },
    renderer({ tokens }) {
      return `<mark class="hl">${this.parser.parseInline(tokens)}</mark>`;
    },
  }, {
    // A task's due date (core/task-due.js): a chip only at the end of a task's first line (walkTokens below
    // marks it); anywhere else it stays text. The view fills in its label (ui/note-list.js).
    name: "taskDue",
    level: "inline",
    start(src) {
      const i = src.indexOf("📅");
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const m = /^📅\uFE0F?[ \t]?(\d{4}-\d{2}-\d{2})(?=[ \t]*(?:✅\uFE0F?[ \t]?\d{4}-\d{2}-\d{2}[ \t]*)?(?:\n|$))/.exec(src);
      if (m) return { type: "taskDue", raw: m[0], due: m[1], inTask: false };
    },
    renderer({ raw, due, inTask }) {
      return inTask ? `<button type="button" class="chip task-due" data-due="${due}">${escapeHtml(raw)}</button>` : escapeHtml(raw);
    },
  }, {
    // A done task's done date (DONE_AT_END): hidden at the end of a task's first line, which only counts it
    // for "done today"; anywhere else it stays text.
    name: "taskDone",
    level: "inline",
    start(src) {
      const i = src.indexOf("✅");
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const m = /^✅\uFE0F?[ \t]?(\d{4}-\d{2}-\d{2})(?=[ \t]*(?:\n|$))/.exec(src);
      if (m) return { type: "taskDone", raw: m[0], inTask: false };
    },
    renderer({ raw, inTask }) {
      return inTask ? "" : escapeHtml(raw);
    },
  }, {
    // A task in progress or cancelled (`[/]`, `[-]`), set up by walkTokens below.
    name: "taskState",
    renderer({ state }) {
      return taskBox(state);
    },
  }],
  // Task items: the extra states `[/]` `[-]` and the due date at the end of the first line.
  walkTokens(token) {
    if (token.type !== "list_item") return;
    if (!token.task) taskState(token);
    if (token.task) markTaskDue(token);
  },
  renderer: {
    // Task checkboxes stay clickable; the view maps a click to taskIndex.
    checkbox({ checked }) {
      return taskBox(checked ? "done" : "open");
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      // A link to another note (core/note-links.js) has no address: the view resolves it (ui/note-links.js).
      const target = noteLinkId(href);
      if (target) return `<a class="note-link" data-note="${escapeAttr(target)}" role="link" tabindex="0">${text}</a>`;
      // Browsers drop tabs, newlines and leading controls from a URL, so "java\tscript:" must count too.
      if (/^(javascript|data|vbscript):/i.test(href.replace(/[\u0000-\u0020]/g, ""))) href = "#";
      return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener"${title ? ` title="${escapeAttr(title)}"` : ""}>${text}</a>`;
    },
    // An embedded image or video is never an <img> here: the view decides
    // per this device's setting whether it loads (core/external.js, ui/external.js).
    image({ href, text }) {
      const src = mediaSource(href);
      return `<span class="ext-media" data-kind="${mediaKind(href)}"${src ? ` data-src="${escapeAttr(src)}"` : ""} data-alt="${escapeAttr(text || "")}"></span>`;
    },
    // Raw HTML in a note is shown as text, never executed.
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

// GFM knows `[ ]` and `[x]` only: a list item starting with `[/]` or `[-]`
// becomes a task too, its box drawn by the taskState renderer.
function taskState(token) {
  const m = /^\[([/-])\] +(?=\S)/.exec(token.text);
  const block = token.tokens[0];
  const first = block && (block.type === "text" || block.type === "paragraph") && block.tokens?.[0];
  if (!m || !first || first.type !== "text" || !first.text.startsWith(m[0])) return;
  first.text = first.text.slice(m[0].length);
  first.raw = first.raw.slice(m[0].length);
  block.tokens.unshift({ type: "taskState", raw: "", state: STATES[m[1]] });
  token.task = true;
}

// The date at the end of a task's first line becomes its chip (before the first line break).
function markTaskDue(token) {
  const block = token.tokens.find(t => t.type === "text" || t.type === "paragraph");
  for (const t of block?.tokens || []) {
    if (t.type === "br" || (t.type === "text" && t.raw.includes("\n"))) return;
    if (t.type === "taskDue" || t.type === "taskDone") t.inTask = true;
  }
}

export function renderMarkdown(body) {
  // A table sits in a box that scrolls sideways (backlog #44), so it keeps its natural width on the phone.
  // Safe as a text replace: raw HTML in a note is escaped (renderer.html above).
  return marked.parse(body).replace(/<table>/g, '<div class="md-table"><table>').replace(/<\/table>/g, "</table></div>");
}

/** Headings of a body in document order: [{ depth, text }]. */
export function headings(body) {
  const out = [];
  marked.walkTokens(marked.lexer(body), t => {
    if (t.type === "heading") out.push({ depth: t.depth, text: plain(t.text) });
  });
  return out;
}

/**
 * The note's sections in document order: one per top-level heading, up to
 * the next one, and before them an untitled one for text ahead of the first
 * heading (the whole note when it has no heading). Lines are 0-based, `end`
 * exclusive: [{ start, end, depth (null = untitled), text }].
 */
export function sections(body) {
  const tokens = marked.lexer(body);
  const lines = body.split("\n");
  const starts = [];
  // Line numbers come from the tokens' raw text, which adds up to the body.
  if (tokens.map(t => t.raw).join("") === body) {
    let line = 0;
    for (const t of tokens) {
      if (t.type === "heading") starts.push({ start: line, depth: t.depth, text: plain(t.text) });
      line += (t.raw.match(/\n/g) || []).length;
    }
  }
  const lead = lines.slice(0, starts.length ? starts[0].start : lines.length).join("\n");
  if (!starts.length || lead.trim()) starts.unshift({ start: 0, depth: null, text: firstSentence(lead) });
  return starts.map((s, i) => ({ ...s, end: i + 1 < starts.length ? starts[i + 1].start : lines.length }));
}

/** The note's display title: first heading, else its first sentence. */
export function noteTitle(body) {
  const h = headings(body)[0];
  if (h) return { text: h.text, fromHeading: true };
  return { text: firstSentence(body), fromHeading: false };
}

export function firstSentence(body, max = 80) {
  const text = plain(body).replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  const s = m ? m[1] : text;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// A task's state by the character in its box, and back.
const STATES = { " ": "open", x: "done", X: "done", "/": "doing", "-": "cancelled" };
const MARKS = { open: " ", done: "x", doing: "/", cancelled: "-" };
/** A task line (as GFM: text after the box): the marker up to "[", the state character, "]". */
export const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX/-])(\])(?= +\S)/;

function taskBox(state) {
  const extra = state === "done" ? " checked" : state === "open" ? "" : ` data-state="${state}"`;
  return `<input type="checkbox" class="task"${extra}> `;
}

/**
 * The tasks of a body in document order, outside code fences:
 * [{ line (0-based), indent, state: open | done | doing | cancelled }].
 */
export function tasks(body) {
  const out = [];
  let fence = null;
  body.split("\n").forEach((text, line) => {
    const f = /^\s*(```|~~~)/.exec(text);
    if (f) { fence = fence === null ? f[1] : fence === f[1] ? null : fence; return; }
    if (fence !== null) return;
    const m = TASK_LINE.exec(text);
    if (m) out.push({ line, indent: /^\s*/.exec(text)[0].length, state: STATES[m[2]] });
  });
  return out;
}

/** A done task's done date at the end of its first line, Obsidian Tasks' `✅ YYYY-MM-DD` (docs/file-format.md). */
export const DONE_AT_END = /[ \t]*✅\uFE0F?[ \t]?(\d{4}-\d{2}-\d{2})[ \t]*$/;

/** A task line's state set to `state`: ticked with a `day` ("YYYY-MM-DD") it gets that done date (one it has
 *  stays); any other state drops it. */
export function setLineState(line, state, day = null) {
  let out = line.replace(TASK_LINE, (_, a, __, c) => a + MARKS[state] + c);
  if (state !== "done") out = out.replace(DONE_AT_END, "");
  else if (day && !DONE_AT_END.test(out)) out = `${out.trimEnd()} ✅ ${day}`;
  return out;
}

/** Sets the n-th task (0-based, document order) to `state` in the source; `day` as setLineState. */
export function setTaskState(body, index, state, day = null) {
  const t = tasks(body)[index];
  if (!t) return body;
  const lines = body.split("\n");
  lines[t.line] = setLineState(lines[t.line], state, day);
  return lines.join("\n");
}

/** What a tap on the n-th task does: open ↔ done, in progress → done, cancelled → open; `day` as setLineState. */
export function toggleTask(body, index, day = null) {
  const t = tasks(body)[index];
  if (!t) return body;
  return setTaskState(body, index, t.state === "open" || t.state === "doing" ? "done" : "open", day);
}

/** How many tasks of a body were ticked on `day` (their done date). */
export function doneTasksOn(body, day) {
  const lines = body.split("\n");
  return tasks(body).filter(t => t.state === "done" && DONE_AT_END.exec(lines[t.line])?.[1] === day).length;
}

// Markdown inline syntax stripped to plain text.
function plain(md) {
  return md
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX/-]\]\s+)?/gm, "")
    .replace(/(\d)([ \t]?h)?[ \t]?\[[ \t]*(?:[+-]\d|⏱)[^\]\n]*\]/g, "$1$2")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return escapeHtml(String(s)).replace(/"/g, "&quot;");
}
