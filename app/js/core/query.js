// What a view shows: which notes, in which order, and the table of contents
// over them. Pure functions on the note objects from notes-file.js.
import { headings, noteTitle } from "./markdown.js";
import { localTime } from "./notes-file.js";

export const SORT_KEYS = {
  modified: { label: "Last edited", field: "modified" },
  created: { label: "Created", field: "created" },
  due: { label: "Due date", field: "due" },
  title: { label: "Alphabetical", field: null },
  closed: { label: "Closed", field: "closed", archiveOnly: true },
};

export const DEFAULT_SORT = {
  open: { key: "modified", dir: "desc" },
  closed: { key: "closed", dir: "desc" },
};

/** Notes of one view ("open" | "closed"), filtered by a search text and sorted. */
export function viewNotes(notes, { status, search = "", sort }) {
  const q = search.trim().toLowerCase();
  const list = notes.filter(n => n.status === status && (!q || n.body.toLowerCase().includes(q)));
  return sortNotes(list, sort);
}

export function sortNotes(notes, { key, dir }) {
  const sign = dir === "asc" ? 1 : -1;
  const field = SORT_KEYS[key] && SORT_KEYS[key].field;
  const keyed = notes.map(n => ({ n, k: field ? n[field] || null : noteTitle(n.body).text.toLowerCase() }));
  keyed.sort((a, b) => {
    // Notes without the value (e.g. no due date) go last in either direction.
    if (a.k === null || b.k === null) return a.k === b.k ? 0 : a.k === null ? 1 : -1;
    const c = field ? (a.k < b.k ? -1 : a.k > b.k ? 1 : 0) : a.k.localeCompare(b.k);
    return c * sign || b.n.created.localeCompare(a.n.created);
  });
  return keyed.map(x => x.n);
}

/**
 * Table of contents over the notes in view order. Levels count from the
 * highest heading level that occurs (level 1 = shallowest); a note without
 * a heading gets one level-1 entry with its first sentence.
 * Returns { entries: [{ noteId, index, level, text, fromHeading }], maxLevel }.
 */
export function tableOfContents(notes) {
  const perNote = notes.map(n => ({ n, hs: headings(n.body) }));
  const depths = perNote.flatMap(p => p.hs.map(h => h.depth));
  const top = depths.length ? Math.min(...depths) : 1;
  const entries = [];
  for (const { n, hs } of perNote) {
    if (!hs.length) {
      entries.push({ noteId: n.id, index: -1, level: 1, text: noteTitle(n.body).text, fromHeading: false });
      continue;
    }
    hs.forEach((h, index) => entries.push({ noteId: n.id, index, level: h.depth - top + 1, text: h.text, fromHeading: true }));
  }
  const maxLevel = entries.reduce((m, e) => Math.max(m, e.level), 1);
  return { entries, maxLevel };
}

/** How many notes were closed on the given local day ("YYYY-MM-DD"). */
export function closedOn(notes, day) {
  return notes.filter(n => n.status === "closed" && n.closed && localTime(n.closed).startsWith(day)).length;
}
