// Multi-select logic without DOM (docs/requirements.md → "Multi-select").
// One selection serves the note list and the table of contents: it is a set
// of section keys (core/query.js → tableOfContents); a whole note is
// selected when all its sections are. Here: toggling and ranges, the
// selection as parts, their text, heading shifts and the merged note.
import { sections, noteTitle } from "./markdown.js";

/** Ids from `fromId` to `toId` (both included) in the order of `orderIds`. */
export function rangeIds(orderIds, fromId, toId) {
  const a = orderIds.indexOf(fromId);
  const b = orderIds.indexOf(toId);
  if (b < 0) return [];
  if (a < 0) return [toId];
  return orderIds.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Entries below entries[i] in the overall structure: the following deeper ones, in any note. */
export function subtree(entries, i) {
  const out = [];
  for (let j = i + 1; j < entries.length && entries[j].level > entries[i].level; j++) out.push(entries[j]);
  return out;
}

/** Selects entries[i] with everything below it, or deselects the same when it is selected; `ownNote`: only what
 *  is below it in its own note (a heading in a card), not the untitled notes hanging under it in the contents. */
export function toggleEntry(entries, selected, i, { ownNote = false } = {}) {
  const on = !selected.has(entries[i].key);
  const next = new Set(selected);
  const below = subtree(entries, i).filter(e => !ownNote || e.noteId === entries[i].noteId);
  for (const e of [entries[i], ...below]) on ? next.add(e.key) : next.delete(e.key);
  return next;
}

/** Shift+click in the contents: entries a to b (indices, either order) and what is below b. */
export function selectEntryRange(entries, selected, a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const next = new Set(selected);
  for (const e of [...entries.slice(lo, hi + 1), ...subtree(entries, hi)]) next.add(e.key);
  return next;
}

/** "all", "some" or "none" of a note's sections are selected. */
export function noteState(entries, selected, noteId) {
  const own = entries.filter(e => e.noteId === noteId);
  const n = own.filter(e => selected.has(e.key)).length;
  return n === 0 ? "none" : n === own.length ? "all" : "some";
}

/** A tap on a card: selects the whole note, or deselects it when it is fully selected. */
export function toggleNote(entries, selected, noteId) {
  const on = noteState(entries, selected, noteId) !== "all";
  const next = new Set(selected);
  for (const e of entries) if (e.noteId === noteId) on ? next.add(e.key) : next.delete(e.key);
  return next;
}

/** Selects the given notes completely. */
export function selectNotes(entries, selected, ids) {
  const next = new Set(selected);
  for (const e of entries) if (ids.includes(e.noteId)) next.add(e.key);
  return next;
}

/**
 * The selection as parts in contents order: runs of adjacent selected
 * sections of one note, sections `from` to `to` (exclusive); `whole` when
 * the run is the entire note. [{ noteId, from, to, whole }]
 */
export function selectedParts(entries, selected) {
  const count = {};
  for (const e of entries) count[e.noteId] = (count[e.noteId] || 0) + 1;
  const parts = [];
  for (const e of entries) {
    if (!selected.has(e.key)) continue;
    const last = parts[parts.length - 1];
    if (last && last.noteId === e.noteId && last.to === e.index) last.to++;
    else parts.push({ noteId: e.noteId, from: e.index, to: e.index + 1 });
  }
  for (const p of parts) p.whole = p.from === 0 && p.to === count[p.noteId];
  return parts;
}

// The body lines a part covers: [start, end).
function lineRange(body, part) {
  if (part.whole) return [0, body.split("\n").length];
  const ss = sections(body);
  return [ss[part.from].start, ss[part.to - 1].end];
}

/** A part's Markdown. */
export function partText(body, part) {
  const [a, b] = lineRange(body, part);
  return body.split("\n").slice(a, b).join("\n").trim();
}

/** One line for the order dialog: the part's first heading, else its first sentence. */
export function partPreview(body, part) {
  if (part.whole) return noteTitle(body);
  const s = sections(body)[part.from];
  return { text: s.text, fromHeading: s.depth !== null };
}

/** The body without the given parts; null when nothing is left. */
export function withoutParts(body, parts) {
  const lines = body.split("\n");
  const drop = new Set();
  for (const p of parts) {
    const [a, b] = lineRange(body, p);
    for (let i = a; i < b; i++) drop.add(i);
  }
  const rest = lines.filter((_, i) => !drop.has(i)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return rest || null;
}

/** Copy: the texts joined by a blank line, without metadata. */
export function copyText(texts) {
  return texts.join("\n\n");
}

// ---------- heading levels ----------
// Only "#" headings move; a code line that looks like one is not a heading
// (sections() reads the Markdown structure).

const ATX = /^( {0,3})(#{1,6})(?=\s|$)/;

// Line numbers of the top-level "#" headings within [a, b).
function headingLines(body, a = 0, b = Infinity) {
  const lines = body.split("\n");
  return sections(body).filter(s => s.depth && s.start >= a && s.start < b && ATX.test(lines[s.start])).map(s => s.start);
}

function shiftLines(body, at, delta) {
  const lines = body.split("\n");
  for (const i of at) lines[i] = lines[i].replace(ATX, (_, sp, h) => sp + "#".repeat(h.length + delta));
  return lines.join("\n");
}

const depthAt = (body, i) => ATX.exec(body.split("\n")[i])[2].length;

/** Lines whose headings a shift of the parts would move ([] when the shift isn't possible). */
function shiftable(body, parts, delta) {
  const at = parts.flatMap(p => headingLines(body, ...lineRange(body, p)));
  const ok = at.every(i => { const d = depthAt(body, i) + delta; return d >= 1 && d <= 6; });
  return ok ? at : [];
}

/** Whether the parts contain a "#" heading. */
export function hasHeadings(body, parts) {
  return parts.some(p => headingLines(body, ...lineRange(body, p)).length > 0);
}

/** Whether the parts contain a heading and all of them can move by `delta` levels (1–6). */
export function canShiftHeadings(body, parts, delta) {
  return shiftable(body, parts, delta).length > 0;
}

/** Moves every heading in the parts by `delta` levels (−1 = up, ## → #); unchanged if not possible. */
export function shiftHeadings(body, parts, delta) {
  return shiftLines(body, shiftable(body, parts, delta), delta);
}

/**
 * Aligns parts for a new note: each part moves so its highest heading is
 * on level 2 (or 1 when a part already uses "#"); parts without a heading
 * stay as they are.
 */
export function alignParts(texts) {
  const tops = texts.map(t => {
    const at = headingLines(t);
    return at.length ? Math.min(...at.map(i => depthAt(t, i))) : null;
  });
  const target = Math.min(2, ...tops.filter(d => d !== null));
  return texts.map((t, i) => tops[i] === null ? t : shiftLines(t, headingLines(t), target - tops[i]));
}

/**
 * Merge / move to a new note: the parts in the given order, aligned and
 * joined by a blank line; created = the earliest created and due = the
 * earliest due date of the notes involved. `changes` gives each source
 * note's remaining body (null = the note goes).
 * `notes`: the involved notes by id.
 */
export function mergeParts(notes, parts) {
  const earliest = values => values.filter(Boolean).sort()[0] || null;
  const ids = [...new Set(parts.map(p => p.noteId))];
  const involved = ids.map(id => notes[id]);
  return {
    body: copyText(alignParts(parts.map(p => partText(notes[p.noteId].body, p)))),
    created: earliest(involved.map(n => n.created)),
    due: earliest(involved.map(n => n.due)),
    changes: involved.map(n => ({ id: n.id, body: withoutParts(n.body, parts.filter(p => p.noteId === n.id)) })),
  };
}
