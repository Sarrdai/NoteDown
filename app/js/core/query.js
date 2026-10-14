// What a view shows: which notes, in which order, and the table of contents
// over them. Pure functions on the note objects from notes-file.js.
import { sections, noteTitle } from "./markdown.js";
import { localTime } from "./notes-file.js";

export const SORT_KEYS = {
  modified: { label: "Last edited", field: "modified" },
  created: { label: "Created", field: "created" },
  due: { label: "Due date", field: "due" },
  title: { label: "Alphabetical", field: null },
  closed: { label: "Closed", field: "closed", archiveOnly: true },
  custom: { label: "Custom", field: null, custom: true },
  shared: { label: "Shared order", field: null, custom: true, circleOnly: true },
};

export const DEFAULT_SORT = {
  open: { key: "modified", dir: "desc" },
  closed: { key: "closed", dir: "desc" },
};

/** Notes of one view ("open" | "closed"), filtered by a search text and
 *  sorted; a custom sort key orders by the note ids in `order`. */
export function viewNotes(notes, { status, search = "", sort, order = [] }) {
  const q = search.trim().toLowerCase();
  const list = notes.filter(n => n.status === status && (!q || n.body.toLowerCase().includes(q)));
  if (SORT_KEYS[sort.key]?.custom) {
    const { sorted, unsorted } = customSplit(list, order);
    return [...sorted, ...unsorted];
  }
  return sortNotes(list, sort);
}

/** A custom order (backlog #24): the notes listed in `ids`, in that order,
 *  and the rest — "not sorted yet", new notes among them — by last edited. */
export function customSplit(notes, ids) {
  const pos = new Map(ids.map((id, i) => [id, i]));
  return {
    sorted: notes.filter(n => pos.has(n.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id)),
    unsorted: sortNotes(notes.filter(n => !pos.has(n.id)), { key: "modified", dir: "desc" }),
  };
}

/**
 * The custom order after arranging: `shown` are the ids the arrange dialog
 * listed (the current view, filter and search), `arranged` its sorted part
 * in the new order. The shown notes' old places are refilled with the new
 * order, further ones go to the end; ids not shown keep their places.
 */
export function rearrange(order, shown, arranged) {
  const visible = new Set(shown);
  const queue = arranged.filter(id => visible.has(id));
  const out = [];
  for (const id of order) {
    if (!visible.has(id)) out.push(id);
    else if (queue.length) out.push(queue.shift());
  }
  return [...new Set([...out, ...queue])];
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

/** The id of a note's section (core/markdown.js → sections) in the contents and the selection. */
export const sectionKey = (noteId, index) => `${noteId}#${index}`;

/**
 * Table of contents over the notes in view order: one entry per section.
 * Levels count from the highest heading level that occurs (level 1 =
 * shallowest). An untitled section (a note, or the start of one, without a
 * heading) shows its first sentence one level below the last heading above
 * it, in whichever note that is — or on level 1 when there is none.
 * Returns { entries: [{ key, noteId, index, level, text, fromHeading }], maxLevel }.
 */
export function tableOfContents(notes) {
  const perNote = notes.map(n => ({ n, ss: sections(n.body) }));
  const depths = perNote.flatMap(p => p.ss.filter(s => s.depth).map(s => s.depth));
  const top = depths.length ? Math.min(...depths) : 1;
  const entries = [];
  let last = 0; // level of the last heading above
  for (const { n, ss } of perNote) {
    ss.forEach((s, index) => {
      const level = s.depth ? (last = s.depth - top + 1) : last + 1;
      entries.push({ key: sectionKey(n.id, index), noteId: n.id, index, level, text: s.text, fromHeading: !!s.depth });
    });
  }
  const maxLevel = entries.reduce((m, e) => Math.max(m, e.level), 1);
  return { entries, maxLevel };
}

/** How many notes were closed on the given local day ("YYYY-MM-DD"). */
export function closedOn(notes, day) {
  return notes.filter(n => n.status === "closed" && n.closed && localTime(n.closed).startsWith(day)).length;
}

/** The tile order with "Protected first": protected notes first, each group in
 *  its given order. The contents keep the plain sort order. */
export function protectedFirst(notes, isProtected) {
  return [...notes.filter(n => isProtected(n.id)), ...notes.filter(n => !isProtected(n.id))];
}

/** What deleting `notes` does: protected notes stay (`kept`); the rest splits
 *  into private and shared ones, which go for everyone in their circle. */
export function deleteGroups(notes, { isProtected, isShared }) {
  const out = { kept: [], private: [], shared: [] };
  for (const n of notes) out[isProtected(n.id) ? "kept" : isShared(n.id) ? "shared" : "private"].push(n);
  return out;
}
