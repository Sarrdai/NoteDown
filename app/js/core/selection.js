// Multi-select logic without DOM: the order the selected notes are acted on
// in, Shift+click ranges, the clipboard text and the merged note
// (docs/requirements.md → "Multi-select").
import { noteTitle } from "./markdown.js";

/** The selected notes in the order of `notes` (the current view order). */
export function selectedInOrder(notes, ids) {
  const set = new Set(ids);
  return notes.filter(n => set.has(n.id));
}

/** Ids from `fromId` to `toId` (both included) in the order of `orderIds`. */
export function rangeIds(orderIds, fromId, toId) {
  const a = orderIds.indexOf(fromId);
  const b = orderIds.indexOf(toId);
  if (b < 0) return [];
  if (a < 0) return [toId];
  return orderIds.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Clipboard text: the bodies, joined by a blank line, without metadata. */
export function copyText(notes) {
  return notes.map(n => n.body.trim()).join("\n\n");
}

/** The note that replaces `notes` (in that order): bodies joined by a
 *  blank line, the earliest created and the earliest due date. */
export function mergedNote(notes) {
  const earliest = values => values.filter(Boolean).sort()[0] || null;
  return {
    body: copyText(notes),
    created: earliest(notes.map(n => n.created)),
    due: earliest(notes.map(n => n.due)),
  };
}

/** One line per note for the order dialog: first heading, else first sentence. */
export function previewLine(note) {
  return noteTitle(note.body);
}
