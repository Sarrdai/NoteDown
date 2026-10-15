// The trash (docs/requirements.md → "Trash"): deleted notes wait in the
// private file for 30 days, read-only. A tap on a trashed note (or on the
// crossed-out avatars of one that came from a shared file) offers its
// actions: Restore — for a shared note "Restore for …", which asks first as
// it reaches others, or "Restore as my own note" — and Delete permanently.
import { note, keptCircle, restoreNotes, purgeNotes } from "../store.js";
import { membersLabel, avatarStackHtml, esc } from "./people.js";
import { openMenu } from "./menu.js";
import { openConfirm } from "./confirm.js";
import { showSnackbar } from "./snackbar.js";

/** The marker in the meta line of a note deleted from a shared file: the circle's avatars, crossed out. */
export function trashMarkerHtml(n) {
  const label = membersLabel(n.kept.split("+"));
  return `<button type="button" class="shared-mark kept-mark" aria-label="${esc(`Deleted for ${label}. Options`)}">`
    + `${avatarStackHtml(n.kept.split("+"))}</button>`;
}

/** The actions of one trashed note, as a menu at `anchor`. */
export function openTrashMenu(anchor, id) {
  const label = membersLabel(keptCircle(id));
  openMenu(anchor, label ? [
    { section: `Deleted for ${label}` },
    { label: `Restore for ${label}…`, icon: "share", onSelect: () => restore([id]) },
    { label: "Restore as my own note", icon: "lock", onSelect: () => restoreOwn([id]) },
    { label: "Delete permanently…", icon: "trash", onSelect: () => purge([id]) },
  ] : [
    { label: "Restore", icon: "restore", onSelect: () => restore([id]) },
    { label: "Delete permanently…", icon: "trash", onSelect: () => purge([id]) },
  ]);
}

const count = (n, word) => n === 1 ? `Note ${word}` : `${n} notes ${word}`;

/** Restores notes where they came from; notes from shared files go back to their circles after asking. */
export function restore(ids) {
  const circles = [...new Set(ids.map(keptCircle).filter(m => m.length).map(m => membersLabel(m)))];
  if (!circles.length) return showSnackbar(count(ids.length, "restored"), restoreNotes(ids));
  const label = circles.join(", ");
  openConfirm({
    title: `Restore for ${label}?`,
    text: `${ids.length === 1 ? "It was" : "Some were"} deleted for ${label}. Restoring shares ${ids.length === 1 ? "it" : "them"} with them again.`,
    okLabel: () => "Restore",
    danger: false,
    onConfirm: () => showSnackbar(ids.length === 1 ? `Restored for ${label}` : count(ids.length, "restored"), restoreNotes(ids)),
  });
}

/** Restores notes as the user's own private notes. */
export function restoreOwn(ids) {
  showSnackbar(ids.length === 1 ? "Restored as your own note" : count(ids.length, "restored"), restoreNotes(ids, { own: true }));
}

/** Deletes trashed notes for good, after asking. */
export function purge(ids, { title = null } = {}) {
  if (!ids.filter(note).length) return;
  openConfirm({
    title: title || (ids.length === 1 ? "Delete permanently?" : `Delete ${ids.length} notes permanently?`),
    text: ids.length === 1 ? "The note is gone from all your devices and can't be restored." : "The notes are gone from all your devices and can't be restored.",
    okLabel: () => "Delete",
    onConfirm: () => showSnackbar(count(ids.length, "deleted"), purgeNotes(ids)),
  });
}
