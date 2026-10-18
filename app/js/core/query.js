// What a view shows: which notes, in which order, and the table of contents
// over them. Pure functions on the note objects from notes-file.js.
import { sections, noteTitle } from "./markdown.js";
import { localTime } from "./notes-file.js";

// `views`: the views a key is offered in (absent = all).
export const SORT_KEYS = {
  modified: { label: "Last edited", field: "modified" },
  created: { label: "Created", field: "created" },
  due: { label: "Due date", field: "due" },
  title: { label: "Alphabetical", field: null },
  closed: { label: "Closed", field: "closed", views: ["closed"] },
  deleted: { label: "Deleted", field: "deleted", views: ["trash"] },
  custom: { label: "Custom", field: null, custom: true, views: ["open", "closed"] },
  shared: { label: "Shared order", field: null, custom: true, circleOnly: true, views: ["open", "closed"] },
};

/** The two directions of a sort key, ascending first. */
export const DIR_LABELS = {
  title: ["A–Z", "Z–A"],
  due: ["Soonest first", "Latest first"],
  default: ["Oldest first", "Newest first"],
};

export const DEFAULT_SORT = {
  open: { key: "modified", dir: "desc" },
  closed: { key: "closed", dir: "desc" },
  trash: { key: "deleted", dir: "desc" },
};

/** How long a deleted note waits in the trash. */
export const TRASH_DAYS = 30;

/** Whether a note belongs to a view: the main view ("open") shows open and permanent notes, the archive
 *  ("closed") closed ones, the trash the deleted ones (whatever their status). */
export function inViewOf(n, view) {
  if (view === "trash") return !!n.deleted;
  return !n.deleted && (view === "open" ? n.status !== "closed" : n.status === "closed");
}

/** The trashed notes whose time is up at `now` (ms): deleted more than TRASH_DAYS ago. */
export function expiredTrash(notes, now = Date.now()) {
  return notes.filter(n => n.deleted && now - Date.parse(n.deleted) > TRASH_DAYS * 86400000);
}

/** Notes of one view ("open" | "closed" | "trash", see inViewOf), filtered by a search text and
 *  sorted; a custom sort key orders by the note ids in `order`. */
export function viewNotes(notes, { status, search = "", sort, order = [] }) {
  const q = search.trim().toLowerCase();
  const list = notes.filter(n => inViewOf(n, status) && (!q || n.body.toLowerCase().includes(q)));
  if (SORT_KEYS[sort.key]?.custom) {
    const { sorted, unsorted } = customSplit(list, order);
    return [...sorted, ...unsorted];
  }
  return sortNotes(list, sort);
}

/** Where a search text occurs in `text`, case-insensitive as the filter:
 *  [start, end) pairs, left to right, not overlapping. */
export function matchRanges(text, search) {
  const q = search.trim();
  if (!q) return [];
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  return [...text.matchAll(re)].map(m => [m.index, m.index + m[0].length]);
}

/** A custom order (backlog #24): the notes listed in `ids`, in that order,
 *  and the rest — "not sorted yet", new notes among them — by last edited.
 *  Section entries in `ids` (isSectionId) match no note and are skipped. */
export function customSplit(notes, ids) {
  const pos = new Map(ids.map((id, i) => [id, i]));
  return {
    sorted: notes.filter(n => pos.has(n.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id)),
    unsorted: sortNotes(notes.filter(n => !pos.has(n.id)), { key: "modified", dir: "desc" }),
  };
}

// A section divider in a custom order (backlog #24): an entry "~" + the
// URI-encoded title among the note ids, so the order stays one id list.
export const isSectionId = id => id.startsWith("~");
export const sectionId = title => "~" + encodeURIComponent(title.trim());
export function sectionTitle(id) {
  try { return decodeURIComponent(id.slice(1)); } catch { return id.slice(1); }
}

/** Which section each note of a custom order is in: note id → the section
 *  entry above it. Notes above the first section have none. */
export function orderSections(ids) {
  const of = new Map();
  let current = null;
  for (const id of ids) {
    if (isSectionId(id)) current = id;
    else if (current) of.set(id, current);
  }
  return of;
}

/** The arrange dialog's rows above the line: every section entry of `ids`
 *  ({ section: id }) and the `notes` listed in `ids`, in the order's order. */
export function arrangeRows(notes, ids) {
  const byId = new Map(notes.map(n => [n.id, n]));
  return ids.flatMap(id => isSectionId(id) ? [{ section: id }] : byId.has(id) ? [byId.get(id)] : []);
}

/**
 * The custom order after arranging: `shown` are the note ids the arrange
 * dialog listed (the current view, filter and search), `arranged` its sorted
 * part in the new order, section entries included (the dialog shows them
 * all). The shown entries' old places are refilled with the new order,
 * further ones go to the end; ids not shown keep their places.
 */
export function rearrange(order, shown, arranged) {
  const visible = new Set(shown);
  const isShown = id => visible.has(id) || isSectionId(id);
  const queue = arranged.filter(isShown);
  const out = [];
  for (const id of order) {
    if (!isShown(id)) out.push(id);
    else if (queue.length) out.push(queue.shift());
  }
  const seen = new Set();
  return [...out, ...queue].filter(id => isSectionId(id) || (!seen.has(id) && seen.add(id)));
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
  return notes.filter(n => n.status === "closed" && !n.deleted && n.closed && localTime(n.closed).startsWith(day)).length;
}

/** The tile order with "Permanent first": permanent notes first, each group in
 *  its given order. The contents keep the plain sort order. */
export function permanentFirst(notes) {
  return [...notes.filter(n => n.status === "permanent"), ...notes.filter(n => n.status !== "permanent")];
}
