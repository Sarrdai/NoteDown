// Version history of the synced files (docs/requirements.md → "Version history", backlog #7): what
// restoring an older state of a file puts into the file. The server keeps the states
// (docs/server-api.md → "Version history"); sync/files.js reads and restores them.

/**
 * The file after restoring `old` over `current` (both parsed notes files): the notes and their order
 * come back from `old`; everything else of the file stays as it is now — contacts, device names, the
 * members' names, news markers, moved and purged markers — so a restore doesn't lose a contact or a
 * device name added since. A note that moved into another file since stays there (it isn't brought back
 * as a copy), and a purged marker of a note that comes back goes.
 */
export function restoredFile(current, old) {
  const movedAway = new Set((current.moved || []).map(m => m.id));
  const notes = old.notes.filter(n => !movedAway.has(n.id));
  const back = new Set(notes.map(n => n.id));
  return {
    ...current,
    notes,
    order: old.order || null,
    purged: (current.purged || []).filter(m => !back.has(m.id)),
  };
}

/**
 * The file after restoring one note of `old` into `current` (backlog #38): the note replaces its current
 * version in place (same id), or, when it's missing now or in the trash, comes back as an open note at the
 * end; its purged marker goes. `modified` is set to `now` so the restore wins when synced as an edit. The
 * file is unchanged when `old` lacks the note or it moved into another file since.
 */
export function restoredNote(current, old, noteId, now = new Date().toISOString()) {
  const then = old.notes.find(n => n.id === noteId && !n.deleted);
  if (!then || (current.moved || []).some(m => m.id === noteId)) return current;
  const { deleted, kept, ...rest } = then;
  const note = { ...rest, modified: now };
  const has = current.notes.some(n => n.id === noteId);
  return {
    ...current,
    notes: has ? current.notes.map(n => (n.id === noteId ? note : n)) : [...current.notes, note],
    purged: (current.purged || []).filter(m => m.id !== noteId),
  };
}

/**
 * What restoring `old` over `current` changes, by note (trashed notes count as gone): `back` the notes
 * that come back (not there now), `gone` the notes that go (added since), `changed` [{ before, now }]
 * the notes whose text differs, `same` how many stay as they are. Order and trash are left out.
 */
export function compareStates(current, old) {
  const live = file => new Map(file.notes.filter(n => !n.deleted).map(n => [n.id, n]));
  const now = live(current), then = live(old);
  const back = [], changed = [];
  let same = 0;
  for (const [id, before] of then) {
    const n = now.get(id);
    if (!n) back.push(before);
    else if (n.body.trim() !== before.body.trim()) changed.push({ before, now: n });
    else same++;
  }
  const gone = [...now.values()].filter(n => !then.has(n.id));
  return { back, gone, changed, same };
}

/** One line for a state's row: "2 notes back · 1 newer note goes · 3 changed", or "Same notes as now". */
export function changeSummary({ back, gone, changed }) {
  const parts = [];
  if (back.length) parts.push(`${back.length} ${back.length === 1 ? "note" : "notes"} back`);
  if (gone.length) parts.push(`${gone.length} newer ${gone.length === 1 ? "note goes" : "notes go"}`);
  if (changed.length) parts.push(`${changed.length} changed`);
  return parts.length ? parts.join(" · ") : "Same notes as now";
}

/** When a state was replaced, for its row: "Today, 09:12", "Yesterday, 18:40", "Mon 12 Oct, 08:00". */
export function stateTime(iso, now = new Date(), timeZone) {
  const at = new Date(iso);
  const day = d => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(at);
  if (day(at) === day(now)) return `Today, ${time}`;
  if (day(at) === day(new Date(now.getTime() - 86400000))) return `Yesterday, ${time}`;
  const date = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(at).replace(",", "");
  return `${date}, ${time}`;
}
