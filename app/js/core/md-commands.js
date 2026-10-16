// Markdown editing commands as pure text transforms, used by the editor's
// toolbar and shortcuts. Line commands take and return one line; selection
// commands take the text and a selection and return { text, from, to }.

const LIST = /^(\s*)(?:([-*+])|(\d+)([.)]))\s+(\[[ xX/-]\]\s+)?/;
const TASK_STATE = { " ": "open", x: "checked", X: "checked", "/": "doing", "-": "cancelled" };
const HEADING = /^(\s{0,3})(#{1,6})\s+/;

/** Parsed list prefix of a line, or null. */
export function listPrefix(line) {
  const m = LIST.exec(line);
  if (!m) return null;
  return {
    indent: m[1],
    bullet: m[2] || null,
    number: m[3] ? Number(m[3]) : null,
    delimiter: m[4] || null,
    task: m[5] ? TASK_STATE[m[5][1]] : null,   // open | checked | doing | cancelled
    length: m[0].length,
  };
}

/** Cycles a line through no heading → # → ## → ### → #### → no heading. */
export function cycleHeading(line) {
  const m = HEADING.exec(line);
  const text = m ? line.slice(m[0].length) : stripList(line);
  const level = m ? m[2].length : 0;
  const next = level >= 4 ? 0 : level + 1;
  return next ? "#".repeat(next) + " " + text : text;
}

/** Plain line → bullet; bullet → plain; task or numbered → bullet. */
export function toggleBullet(line) {
  const p = listPrefix(line);
  const rest = p ? line.slice(p.length) : line.replace(/^\s+/, "");
  const indent = p ? p.indent : /^\s*/.exec(line)[0];
  if (p && p.bullet && !p.task) return indent + rest;
  return indent + "- " + stripHeading(rest);
}

/** Plain line or bullet → open task; task → plain line. */
export function toggleTaskItem(line) {
  const p = listPrefix(line);
  const rest = p ? line.slice(p.length) : line.replace(/^\s+/, "");
  const indent = p ? p.indent : /^\s*/.exec(line)[0];
  if (p && p.task) return indent + rest;
  return indent + "- [ ] " + stripHeading(rest);
}

/** Ticks / unticks a task line as a tap does (in progress → done, cancelled → open); any other line becomes an open task. */
export function toggleTaskChecked(line) {
  const p = listPrefix(line);
  if (!p || !p.task) return toggleTaskItem(line);
  const box = line.slice(0, p.length).replace(/\[[ xX/-]\]/, p.task === "open" || p.task === "doing" ? "[x]" : "[ ]");
  return box + line.slice(p.length);
}

export function indentLine(line, unit = "  ") {
  return unit + line;
}

export function outdentLine(line, unit = "  ") {
  if (line.startsWith(unit)) return line.slice(unit.length);
  if (line.startsWith("\t")) return line.slice(1);
  return line.replace(/^ +/, "");
}

/**
 * What Enter does at the end of a list line: { prefix } to start the next
 * item, { clear: true } to end the list (the item was empty), or null.
 */
export function continueList(line) {
  const p = listPrefix(line);
  if (!p) return null;
  if (line.slice(p.length).trim() === "") return { clear: true };
  const marker = p.bullet ? p.bullet : `${p.number + 1}${p.delimiter}`;
  return { prefix: `${p.indent}${marker} ${p.task ? "[ ] " : ""}` };
}

/** Wraps the selection in `mark` (e.g. "**"), or unwraps it if already wrapped. */
export function toggleWrap(text, from, to, mark) {
  const n = mark.length;
  if (text.slice(from - n, from) === mark && text.slice(to, to + n) === mark) {
    return { text: text.slice(0, from - n) + text.slice(from, to) + text.slice(to + n), from: from - n, to: to - n };
  }
  const sel = text.slice(from, to);
  if (sel.length > 2 * n && sel.startsWith(mark) && sel.endsWith(mark)) {
    return { text: text.slice(0, from) + sel.slice(n, -n) + text.slice(to), from, to: to - 2 * n };
  }
  return { text: text.slice(0, from) + mark + sel + mark + text.slice(to), from: from + n, to: to + n };
}

/** Turns the selection into [selection](url) and selects "url" for typing. */
export function insertLink(text, from, to) {
  const label = text.slice(from, to);
  const link = `[${label}](url)`;
  const urlFrom = from + label.length + 3;
  return { text: text.slice(0, from) + link + text.slice(to), from: urlFrom, to: urlFrom + 3 };
}

/** Embeds an image or video (backlog #30): `![label](url)` on a line of its
 *  own, with the url placeholder selected for pasting the address. */
export function insertMedia(text, from, to) {
  const label = text.slice(from, to);
  const before = from === 0 || text[from - 1] === "\n" ? "" : "\n";
  const after = to === text.length || text[to] === "\n" ? "" : "\n";
  const media = `${before}![${label}](url)${after}`;
  const urlFrom = from + before.length + label.length + 4;
  return { text: text.slice(0, from) + media + text.slice(to), from: urlFrom, to: urlFrom + 3 };
}

function stripList(line) {
  const p = listPrefix(line);
  return p ? line.slice(p.length) : line.replace(/^\s+/, "");
}

function stripHeading(text) {
  return text.replace(HEADING, "");
}
