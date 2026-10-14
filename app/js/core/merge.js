// Sync merge: combines the local and the remote state of one notes file
// against the last state both had in common (docs/sync-and-sharing.md →
// "Merging"). Works per note id and, inside a note, per field group, so
// nothing either side wrote is lost.

import { newId } from "./notes-file.js";

/**
 * Three-way merge of parsed notes files ({ preamble, notes, moved, devices, contacts, order }).
 * Returns { file, displaced }: `displaced` lists { base, note } for notes
 * edited on one side while the other moved them to another file; the caller
 * re-applies each with applyDisplaced to the file the note moved to, or to
 * the private file when the user is no longer a member of that one.
 * The result keeps the remote order and appends what only the local side has,
 * so a merge that adds nothing returns the remote file unchanged and two
 * devices don't re-upload the same notes in each other's order.
 */
export function mergeNotesFiles(base, local, remote) {
  const [b, l, r] = [base, local, remote].map(states);
  const ids = [...new Set([...r.keys(), ...l.keys(), ...b.keys()])];
  const notes = [], moved = [], displaced = [];
  for (const id of ids) {
    const [sb, sl, sr] = [b.get(id), l.get(id), r.get(id)];
    let out;
    if (same(sl, sr) || same(sl, sb)) out = sr;
    else if (same(sr, sb)) out = sl;
    else if (isNote(sl) && isNote(sr)) out = mergeNote(isNote(sb) ? sb : null, sl, sr, notes);
    else if (isNote(sl) || isNote(sr)) {
      // Edited on one side, deleted or moved on the other: the edit wins
      // over a delete, and follows a move.
      const edited = isNote(sl) ? sl : sr;
      const other = isNote(sl) ? sr : sl;
      if (other?.moved) { displaced.push({ base: isNote(sb) ? sb : null, note: edited }); out = other; } else out = edited;
    } else out = sl?.moved ? sl : sr;
    if (isNote(out)) notes.push(out);
    else if (out?.moved) moved.push(out);
  }
  const preamble = local.preamble === base.preamble ? remote.preamble : local.preamble;
  return { file: { preamble, notes, moved, devices: mergeMarkers(base, local, remote, "devices"), contacts: mergeMarkers(base, local, remote, "contacts"), order: mergeOrder(base, local, remote) }, displaced };
}

// A custom order (backlog #24, #25) is one list: the side that changed it
// wins; when both did, the newer list (remote on a tie).
function mergeOrder(base, local, remote) {
  const [b, l, r] = [base, local, remote].map(f => f.order || null);
  const key = o => JSON.stringify(o);
  if (key(l) === key(b)) return r;
  if (key(r) === key(b)) return l;
  if (!l || !r) return l || r;
  return l.modified > r.modified ? l : r;
}

// Device names and contacts (private file): per id, the side that changed a
// marker wins, the remote one when both did; a marker removed on one side
// stays removed.
function mergeMarkers(base, local, remote, list) {
  const [b, l, r] = [base, local, remote].map(f => new Map((f[list] || []).map(m => [m.id, JSON.stringify(m)])));
  const out = [];
  for (const id of new Set([...r.keys(), ...l.keys()])) {
    const marker = l.get(id) === b.get(id) ? r.get(id) : r.get(id) === b.get(id) ? l.get(id) : r.get(id) ?? l.get(id);
    if (marker !== undefined) out.push(JSON.parse(marker));
  }
  return out;
}

/** Merges a displaced edit into the parsed file the note now lives in. */
export function applyDisplaced(file, { base, note }) {
  const current = file.notes.find(n => n.id === note.id);
  const merged = mergeNotesFiles({ notes: base ? [base] : [] }, { notes: [note] }, { notes: current ? [current] : [] });
  return { ...file, notes: [...file.notes.filter(n => n.id !== note.id), ...merged.file.notes] };
}

/**
 * The notes of a merged shared file that a protected note has to be saved from: present before the
 * merge (`before`), gone after it (`merged`) and not moved on (no moved marker) — another member
 * deleted them. `isProtected(id)` is this device's setting, which never leaves the device
 * (docs/sync-and-sharing.md → "Files").
 */
export function protectedDeleted(before, merged, isProtected) {
  const there = new Set([...merged.notes, ...(merged.moved || [])].map(n => n.id));
  return before.notes.filter(n => isProtected(n.id) && !there.has(n.id));
}

/** True when `file` has moved notes away since `base` (a moved marker `base` doesn't have): its upload has to wait
 *  until the files the notes moved to are on the server. */
export function movedAway(base, file) {
  const had = new Set((base.moved || []).map(m => m.id));
  return (file.moved || []).some(m => !had.has(m.id));
}

/**
 * A private copy of a note that came back into a shared file (the person was removed and added again)
 * gets a new ID, so no two notes share one. `ids`: the IDs of the notes in the shared files.
 * → { file, renamed: [{ from, to }] }
 */
export function renameDuplicates(file, ids) {
  const renamed = [];
  const notes = file.notes.map(n => {
    if (!ids.has(n.id)) return n;
    const copy = { ...n, id: newId() };
    renamed.push({ from: n.id, to: copy.id });
    return copy;
  });
  return { file: { ...file, notes }, renamed };
}

/** The parsed file with `notes` added (a note that came back clears its moved marker). */
export function adoptNotes(file, notes) {
  const ids = new Set(notes.map(n => n.id));
  return { ...file, notes: [...file.notes, ...notes], moved: (file.moved || []).filter(m => !ids.has(m.id)) };
}

/** Moves a note from one parsed file to another, leaving a moved marker. */
export function moveNote(from, to, id, now) {
  const note = from.notes.find(n => n.id === id);
  return {
    from: { ...from, notes: from.notes.filter(n => n.id !== id), moved: [...(from.moved || []), { id, moved: now }] },
    to: { ...to, notes: [...to.notes, note], moved: (to.moved || []).filter(m => m.id !== id) },
  };
}

// Field groups merged independently; created and id never change.
const GROUPS = [["status", "closed"], ["due"], ["body"]];

function mergeNote(base, l, r, notes) {
  const newer = l.modified >= r.modified ? l : r;
  const older = newer === l ? r : l;
  const out = { ...newer };
  for (const keys of GROUPS) {
    const pick = keys.every(k => base && l[k] === base[k]) ? r
      : keys.every(k => base && r[k] === base[k]) ? l
      : newer;
    for (const k of keys) out[k] = pick[k];
  }
  // Both sides changed the text differently: keep the older text as a copy.
  if (l.body !== r.body && (!base || (l.body !== base.body && r.body !== base.body))) {
    notes.push({ ...older, id: newId() });
  }
  return out;
}

function states(file) {
  const map = new Map();
  for (const m of file.moved || []) map.set(m.id, m);
  for (const n of file.notes) map.set(n.id, n);
  return map;
}

const isNote = s => s && "body" in s;

function same(a, b) {
  if (!a || !b) return !a && !b;
  if (isNote(a) !== isNote(b)) return false;
  if (!isNote(a)) return true;
  return ["status", "created", "modified", "due", "closed", "body"].every(k => a[k] === b[k]);
}
