// The trash (docs/requirements.md → "Main view, archive and trash"): deleted
// notes wait in the private file for 30 days, read-only. Its actions act on
// the selection (ui/selection.js): Restore — notes from a shared file go back
// to their circle after asking, as it reaches others — Restore as my own, and
// Delete permanently (the red bin, asks first).
import { note, keptCircle, restoreNotes, purgeNotes } from "../store.js";
import { membersLabel, avatarStackHtml, esc } from "./people.js";
import { openConfirm } from "./confirm.js";
import { showSnackbar } from "./snackbar.js";

/** The marker in the meta line of a note deleted from a shared file: the circle's avatars, crossed out. */
export function trashMarkerHtml(n) {
  const label = membersLabel(n.kept.split("+"));
  return `<span role="img" class="shared-mark kept-mark" aria-label="${esc(`Deleted for ${label}`)}">`
    + `${avatarStackHtml(n.kept.split("+"))}</span>`;
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

/** Deletes trashed notes for good, after asking; `onDone` runs once they are deleted. */
export function purge(ids, { onDone = () => {} } = {}) {
  if (!ids.filter(note).length) return;
  openConfirm({
    title: ids.length === 1 ? "Delete permanently?" : `Delete ${ids.length} notes permanently?`,
    text: ids.length === 1 ? "The note is deleted for good, on all your devices. This can't be undone later." : "The notes are deleted for good, on all your devices. This can't be undone later.",
    okLabel: () => "Delete permanently",
    onConfirm: () => { onDone(); showSnackbar(count(ids.length, "deleted permanently"), purgeNotes(ids)); },
  });
}
