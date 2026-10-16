// Markdown helpers on a note's body: rendering, headings and sections for
// the table of contents, the preview title, and toggling task checkboxes in
// the source.
import { Marked } from "../../vendor/marked.esm.js";
import { LABEL_AT } from "./labels.js";
import { mediaSource, mediaKind } from "./external.js";
import { COUNTER_AT, counterStart, parseSteps, counterHtml } from "./counter.js";

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
  // Labels (core/labels.js) render as chips; a tap filters the list by them.
  extensions: [{
    name: "label",
    level: "inline",
    start(src) {
      const m = /(^|[\s(])#[\p{L}\p{N}_]/u.exec(src);
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
      const m = COUNTER_AT.exec(src);
      if (m) return { type: "counter", raw: m[0], value: m[1], steps: parseSteps(m[2]) };
    },
    renderer({ value, steps }) {
      return counterHtml(value, steps);
    },
  }],
  renderer: {
    // Task checkboxes stay clickable; the view maps a click to taskIndex.
    checkbox({ checked }) {
      return `<input type="checkbox" class="task"${checked ? " checked" : ""}> `;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
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

export function renderMarkdown(body) {
  return marked.parse(body);
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

/** Flips the n-th task checkbox (0-based, document order) in the source. */
export function toggleTask(body, index) {
  const lines = body.split("\n");
  let fence = null;
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s*(```|~~~)/.exec(lines[i]);
    if (f) { fence = fence === null ? f[1] : fence === f[1] ? null : fence; continue; }
    if (fence !== null) continue;
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(lines[i]);
    if (!m) continue;
    if (n++ === index) {
      lines[i] = m[1] + (m[2] === " " ? "x" : " ") + m[3] + lines[i].slice(m[0].length);
      return lines.join("\n");
    }
  }
  return body;
}

// Markdown inline syntax stripped to plain text.
function plain(md) {
  return md
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/(\d)[ \t]?\[[ \t]*[+-]\d[\d.,+\- \t]*\]/g, "$1")
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
