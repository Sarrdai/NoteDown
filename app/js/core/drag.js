// Drag and drop of list items and sections (docs/requirements.md → "Multi-select" → "Drag and drop"): where a
// dragged part may land, on which levels, and the bodies after the move. A list item lands between items of
// any list or at the end of a section's own text; a section lands before a heading or at the end of a note.
// The level is picked among the ones the place allows: from the next element's level up to one below the
// previous one (as in an outliner).
import { listItems } from "./list-items.js";
import { sections } from "./markdown.js";
import { LABEL_AT } from "./labels.js";

const ATX = /^( {0,3})(#{1,6})(?=\s|$)/;
const MARKER = /^\s*((?:[-*+]|\d+[.)])[ \t]+)/;
const isItemLine = l => /^\s*(?:[-*+]|\d+[.)])(?:[ \t]+|$)/.test(l);

// A line of labels only ("#shopping #home"): it closes its section and stays last.
const labelsOnly = line => {
  const words = line.trim().split(/\s+/);
  return words[0] !== "" && words.every(w => LABEL_AT.test(w) && LABEL_AT.exec(w)[0] === w);
};

const inside = (line, skip) => skip && line >= skip[0] && line < skip[1];

// Where a child of `it` starts: past its marker ("- " 2, "1. " 3).
const childIndent = (lines, it) => it.indent + (MARKER.exec(lines[it.line])?.[1].length ?? 2);

/**
 * Where a list item may land in `body`, without the lines `skip` ([a, b): the
 * dragged item itself, in its own note): [{ line, levels: [{ indent, level }],
 * anchor }] — inserted before `line` with one of the indents (`level`: how deep
 * that nests, 0 = top). `anchor` places the slot on the screen:
 * { before: itemLine } | { after: itemLine } (the list's last top-level item) |
 * { sectionEnd: index }; `gap`: a new list there needs blank lines around it.
 */
export function itemSlots(body, skip = null) {
  const lines = body.split("\n");
  const items = listItems(body).filter(it => !inside(it.line, skip));
  const indentOf = l => /^\s*/.exec(l)[0].replace(/\t/g, "    ").length;
  // Whether `it` continues the list of the item before it: only that item's own lines, blank or skipped ones between.
  const follows = (p, it) => {
    for (let j = p.line + 1; j < it.line; j++) if (!inside(j, skip) && lines[j].trim() && indentOf(lines[j]) <= p.indent) return false;
    return true;
  };
  const slots = [];
  // The chain of items open at `prev` (prev and its ancestors), deepest first.
  const chainOf = i => {
    const chain = [];
    for (let k = i; k >= 0; k--) {
      if (!chain.length || items[k].indent < chain[chain.length - 1].indent) chain.push(items[k]);
      if (items[k].indent === 0) break;
    }
    return chain;
  };
  const levelsAfter = (i, minIndent) => {
    const chain = chainOf(i);
    const out = chain.slice().reverse().map((it, level) => ({ indent: it.indent, level }));
    out.push({ indent: childIndent(lines, items[i]), level: chain.length });
    return out.filter(l => l.indent >= minIndent);
  };
  const end = it => { let e = it.end; while (inside(e - 1, skip) || (e > it.line + 1 && !lines[e - 1].trim())) e--; return Math.max(e, it.line + 1); };
  items.forEach((it, i) => {
    const prev = i > 0 && follows(items[i - 1], it) ? i - 1 : -1;
    // A first item that isn't contiguous ends the list before it.
    if (prev < 0 && i > 0) closeList(i - 1);
    const levels = prev < 0 ? [{ indent: it.indent, level: 0 }] : levelsAfter(prev, it.indent);
    slots.push({ line: it.line, levels, anchor: { before: it.line } });
  });
  if (items.length) closeList(items.length - 1);
  function closeList(i) {
    const root = chainOf(i).at(-1);
    const at = Math.max(end(items[i]), end(root));
    slots.push({ line: at, levels: levelsAfter(i, 0), anchor: { after: root.line } });
  }
  // The end of each section's own text, where it doesn't end with a list already.
  const ss = sections(body);
  ss.forEach((s, index) => {
    let at = s.end;
    while (at > s.start + (s.depth ? 1 : 0) && (inside(at - 1, skip) || !lines[at - 1].trim() || labelsOnly(lines[at - 1]))) at--;
    if (slots.some(x => x.line === at && x.anchor.after !== undefined)) return;
    slots.push({ line: at, levels: [{ indent: 0, level: 0 }], anchor: { sectionEnd: index }, gap: true });
  });
  return slots.sort((a, b) => a.line - b.line);
}

/**
 * Where a section may land in `body`, without the lines `skip`: before each
 * heading and at the end of the note (before a closing line of labels):
 * [{ line, depths: [d, …], anchor }] — `anchor` { section: index } (the
 * section that heading starts) or { end: true }.
 */
export function sectionSlots(body, skip = null) {
  const lines = body.split("\n");
  const all = sections(body);
  const ss = all.filter(s => s.depth && !inside(s.start, skip) && ATX.test(lines[s.start]));
  const slots = [];
  const range = (lo, hi) => Array.from({ length: Math.max(0, hi - lo + 1) }, (_, k) => lo + k);
  ss.forEach((s, i) => {
    const prev = ss[i - 1];
    slots.push({ line: s.start, depths: prev ? range(s.depth, Math.min(6, prev.depth + 1)) : [s.depth], anchor: { section: all.indexOf(s) } });
  });
  const last = ss.at(-1);
  const top = ss.length ? Math.min(...ss.map(s => s.depth)) : 2;
  let end = lines.length;
  while (end > 0 && (inside(end - 1, skip) || !lines[end - 1].trim() || labelsOnly(lines[end - 1]))) end--;
  if (end < lines.length && !lines.slice(end).some(l => labelsOnly(l))) end = lines.length;
  slots.push({ line: end, depths: last ? range(top, Math.min(6, last.depth + 1)) : [top], anchor: { end: true } });
  return slots;
}

/** The lines [a, b) a section starting at line `start` covers: up to the next heading of its level or higher. */
export function sectionRange(body, start) {
  const ss = sections(body);
  const i = ss.findIndex(s => s.start === start);
  if (i < 0 || !ss[i].depth) return null;
  let j = i + 1;
  while (j < ss.length && (ss[j].depth === null || ss[j].depth > ss[i].depth)) j++;
  return { lines: [ss[i].start, ss[j - 1].end], depth: ss[i].depth };
}

// Inserts `moved` before `at` in `lines`, with blank lines where Markdown needs them: before a heading or a
// new list after text, and after it when text follows (it would join the last item or the heading's section).
function insert(lines, at, moved, { heading = false, gap = false } = {}) {
  const before = lines.slice(0, at), after = lines.slice(at);
  while (before.length && !before.at(-1).trim() && (heading || gap)) before.pop();
  while (moved.length && !moved.at(-1).trim()) moved.pop();
  const head = before.length && (heading || gap) ? [""] : [];
  const next = after[0] ?? "";
  const tail = !next.trim() ? [] : heading || gap ? [""] : isItemLine(next) || ATX.test(next) ? [] : [""];
  return [...before, ...head, ...moved, ...tail, ...after];
}

// The lines without [a, b) and without a blank line left doubled by it (the one at b): { rest, dropped }.
function remove(lines, [a, b]) {
  const rest = [...lines.slice(0, a), ...lines.slice(b)];
  const dropped = a > 0 && a < rest.length && !rest[a - 1].trim() && !rest[a].trim();
  if (dropped) rest.splice(a, 1);
  return { rest, dropped };
}

const tidy = lines => lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "");

// Moves lines [a, b) of `src` to before `line` of `dst` (null: the same note, `line` counted in `src`), turned
// by `turn` (line → line); returns { src, dst } — the same body twice for one note; null src = nothing left.
function moveLines(src, [a, b], dst, line, turn, opts) {
  const lines = src.split("\n");
  const moved = lines.slice(a, b).map(turn);
  const { rest, dropped } = remove(lines, [a, b]);
  if (dst === null) {
    const at = line <= a ? line : line - (b - a) - (dropped && line > b ? 1 : 0);
    const body = tidy(insert(rest, Math.max(0, Math.min(at, rest.length)), moved, opts));
    return { src: body, dst: body };
  }
  const left = tidy(rest);
  return { src: left.trim() ? left : null, dst: tidy(insert(dst.split("\n"), line, moved, opts)) };
}

/**
 * Moves the list item at lines [a, b) of `src`, indented `from`, to before
 * `line` of `dst` (null: in its own note, `line` as itemSlots gave it) with
 * indent `to`. Its sub-items move along. Returns { src, dst }.
 */
export function moveItem(src, range, from, dst, line, to, { gap = false } = {}) {
  const turn = l => (l.trim() ? " ".repeat(to) + l.replace(new RegExp(`^ {0,${from}}`), "") : l);
  return moveLines(src, range, dst, line, turn, { gap });
}

/**
 * Moves the section at lines [a, b) of `src` (its heading on level `from`) to
 * before `line` of `dst` (null: its own note) on level `to`; the headings
 * below it shift along (between 1 and 6). Returns { src, dst }.
 */
export function moveSection(src, range, from, dst, line, to) {
  const delta = to - from;
  let fence = null;
  const turn = l => {
    const f = /^\s*(```|~~~)/.exec(l);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    if (fence !== null || f) return l;
    return l.replace(ATX, (_, sp, h) => sp + "#".repeat(Math.min(6, Math.max(1, h.length + delta))));
  };
  return moveLines(src, range, dst, line, turn, { heading: true });
}
