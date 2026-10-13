// Sync merge: combines the local and the remote state of one notes file
// against the last state both had in common (docs/sync-and-sharing.md →
// "Merging"). Works per note id and, inside a note, per field group, so
// nothing either side wrote is lost.

import { newId } from "./notes-file.js";

/**
 * Three-way merge of parsed notes files ({ preamble, notes, moved }).
 * Returns { file, displaced }: `displaced` lists { base, note } for notes
 * edited on one side while the other moved them to another file; the caller
 * re-applies each with applyDisplaced to the file the note moved to, or to
 * the private file when the user is no longer a member of that one.
 */
export function mergeNotesFiles(base, local, remote) {
  const [b, l, r] = [base, local, remote].map(states);
  const ids = [...new Set([...l.keys(), ...r.keys(), ...b.keys()])];
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
  return { file: { preamble, notes, moved }, displaced };
}

/** Merges a displaced edit into the parsed file the note now lives in. */
export function applyDisplaced(file, { base, note }) {
  const current = file.notes.find(n => n.id === note.id);
  const merged = mergeNotesFiles({ notes: base ? [base] : [] }, { notes: [note] }, { notes: current ? [current] : [] });
  return { ...file, notes: [...file.notes.filter(n => n.id !== note.id), ...merged.file.notes] };
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
