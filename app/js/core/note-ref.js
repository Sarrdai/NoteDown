// A note's address in the app (backlog #63): its ID, plus its file when another file holds a note with the same ID
// (a member can write any ID into a shared file). The app's views, selections and orders name notes by this
// address; the ID in the file never changes (docs/sync-and-sharing.md → "Same note ID in two files").

/** The address of a note: its ID, or `id@circleKey` for the later holders of an ID that more than one file has. */
export const refOf = n => n.ref ?? n.id;

/**
 * Sets the address of every note of `files` ([{ key, notes }], key = circleKey, "" for the private file). The
 * files are taken in this order (the caller sorts them the same way on every device); the first holder of an ID
 * keeps the plain ID, the others get `id@key`. The address is not enumerable: it is never written to a file or
 * copied along with the note.
 */
export function assignRefs(files) {
  const seen = new Set();
  for (const { key, notes } of files) {
    for (const n of notes) {
      const dup = seen.has(n.id);
      seen.add(n.id);
      if (dup) Object.defineProperty(n, "ref", { value: `${n.id}@${key}`, enumerable: false, configurable: true, writable: true });
      else delete n.ref;
    }
  }
}
