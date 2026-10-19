// Sync merge: combines the local and the remote state of one notes file
// against the last state both had in common (docs/sync-and-sharing.md →
// "Merging"). Works per note id and, inside a note, per field group, so
// nothing either side wrote is lost.

import { newId } from "./notes-file.js";
import { mergeText } from "./text-merge.js";

/**
 * Three-way merge of parsed notes files ({ preamble, notes, moved, purged, devices, contacts, order }).
 * Returns { file, displaced }: `displaced` lists { base, note, to? } for notes
 * edited on one side while the other moved them to another file; the caller
 * re-applies each with applyDisplaced to the file the moved marker names
 * (`to`, see moveTarget), or to the private file when it names none or the
 * user is no longer a member of that one (backlog #32).
 * The result keeps the remote order and appends what only the local side has,
 * so a merge that adds nothing returns the remote file unchanged and two
 * devices don't re-upload the same notes in each other's order.
 */
export function mergeNotesFiles(base, local, remote) {
  const [b, l, r] = [base, local, remote].map(states);
  const ids = [...new Set([...r.keys(), ...l.keys(), ...b.keys()])];
  const notes = [], moved = [], purged = [], displaced = [];
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
      if (other?.moved) { displaced.push({ base: isNote(sb) ? sb : null, note: edited, ...(other.to && { to: other.to }) }); out = other; } else out = edited;
    } else out = sl?.moved || sl?.purged ? sl : sr;
    if (isNote(out)) notes.push(out);
    else if (out?.moved) moved.push(out);
    else if (out?.purged) purged.push(out);
  }
  const preamble = local.preamble === base.preamble ? remote.preamble : local.preamble;
  return { file: { preamble, notes, moved, purged, devices: mergeDevices(base, local, remote), contacts: mergeMarkers(base, local, remote, "contacts"), members: mergeMarkers(base, local, remote, "members"), news: mergeMarkers(base, local, remote, "news"), sources: mergeMarkers(base, local, remote, "sources"), order: mergeOrder(base, local, remote) }, displaced };
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

// Device names, contacts, news state, folder sources (private file) and member names (shared files): per id, the side that changed a
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

// Device markers merge like the others, except that the later `synced` of both sides is kept: each device
// writes only its own, and a name changed on the other side mustn't take it back.
function mergeDevices(base, local, remote) {
  const synced = new Map();
  for (const d of [...(local.devices || []), ...(remote.devices || [])]) {
    if (d.synced && !(synced.get(d.id) >= d.synced)) synced.set(d.id, d.synced);
  }
  return mergeMarkers(base, local, remote, "devices").map(d => (synced.has(d.id) ? { ...d, synced: synced.get(d.id) } : d));
}

/** Merges a displaced edit into the parsed file the note now lives in. */
export function applyDisplaced(file, { base, note }) {
  const current = file.notes.find(n => n.id === note.id);
  const merged = mergeNotesFiles({ notes: base ? [base] : [] }, { notes: [note] }, { notes: current ? [current] : [] });
  return { ...file, notes: [...file.notes.filter(n => n.id !== note.id), ...merged.file.notes] };
}

/**
 * The notes of a merged shared file that go into this user's trash: present before the merge
 * (`before`), gone after it (`merged`) and not moved on (no moved marker) — another member, or another
 * of the user's devices, deleted them. Each comes back as a trash entry of the private file, `deleted`
 * at `now` and marked `kept` with `circle`, the circleKey of the shared file
 * (docs/sync-and-sharing.md → "Trash").
 */
export function deletedFromShared(before, merged, circle, now) {
  const there = new Set([...merged.notes, ...(merged.moved || [])].map(n => n.id));
  return before.notes.filter(n => !there.has(n.id)).map(n => ({ ...n, deleted: now, kept: circle }));
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

/** The parsed file with `notes` added (a note that came back clears its moved marker); notes whose id the
 *  file already holds are left out (another device of the user put them into the trash first), and so are
 *  notes with a purged marker (another device already removed them from the trash for good). */
export function adoptNotes(file, notes) {
  const have = new Set([...file.notes, ...(file.purged || [])].map(n => n.id));
  const fresh = notes.filter(n => !have.has(n.id));
  const ids = new Set(fresh.map(n => n.id));
  return { ...file, notes: [...file.notes, ...fresh], moved: (file.moved || []).filter(m => !ids.has(m.id)) };
}

/**
 * What a moved marker names as the note's new file (backlog #32): all member ids of the target (`toOthers` plus
 * `me`, sorted), so a concurrent edit follows the note there and into no other file that happens to hold a note
 * with the same id. Only when the move leaves the old file's members nothing new to learn: the old file is the
 * private one, or the target's members are a subset or a superset of the old file's. Otherwise undefined, and
 * a concurrent edit becomes a private copy. Member lists are the other members' ids (without `me`).
 */
export function moveTarget(fromOthers, toOthers, me) {
  const [a, b] = [new Set(fromOthers), new Set(toOthers)];
  const within = (x, y) => [...x].every(id => y.has(id));
  if (a.size && !within(a, b) && !within(b, a)) return undefined;
  return [...b, ...(me ? [me] : [])].sort();
}

/** Moves a note from one parsed file to another, leaving a moved marker (with `to`, see moveTarget, when given). */
export function moveNote(from, to, id, now, target) {
  const note = from.notes.find(n => n.id === id);
  const marker = { id, moved: now, ...(target && { to: target }) };
  return {
    from: { ...from, notes: from.notes.filter(n => n.id !== id), moved: [...(from.moved || []), marker] },
    to: { ...to, notes: [...to.notes, note], moved: (to.moved || []).filter(m => m.id !== id) },
  };
}

/** True when `identity` left the note (the note is hidden on its devices). */
export const hasLeft = (note, identity) => Boolean(identity && note.left && note.left.includes(identity));

/**
 * Where a note someone left goes: the ids of the members who remain (`members`: everyone in the file,
 * `own` included) in the file of the people besides `own`, or null when this device's user left it
 * (a leaver's device doesn't move it) or nobody did. → { others: ids of the target circle ([] = the private file) }.
 */
export function rehomeTarget(note, members, own) {
  if (!note.left || !note.left.length || note.left.includes(own)) return null;
  return { others: members.filter(m => m !== own && !note.left.includes(m)) };
}

/** Moves a note someone left into another parsed file, leaving a moved marker (`target`: see moveTarget); the note drops `left`. */
export function rehomeNote(from, to, id, now, target) {
  const moved = moveNote(from, to, id, now, target);
  return { from: moved.from, to: { ...moved.to, notes: moved.to.notes.map(n => (n.id === id ? withoutLeft(n) : n)) } };
}

function withoutLeft({ left, ...note }) {
  return note;
}

// Field groups merged independently; created and id never change.
const GROUPS = [["status", "closed"], ["due"], ["body"], ["deleted", "kept"], ["color"], ["decor"], ["copied"]];

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
  if (!out.deleted) delete out.deleted;
  if (!out.kept) delete out.kept;
  if (!out.color) delete out.color;
  if (!out.decor) delete out.decor;
  if (!out.copied) delete out.copied;
  // Both sides changed the text differently: their changes combine line by line (core/text-merge.js, backlog #47);
  // where they don't, the newer text stays and the older one is kept as a copy.
  if (l.body !== r.body && (!base || (l.body !== base.body && r.body !== base.body))) {
    const merged = base ? mergeText(base.body, l.body, r.body, newer === l) : null;
    if (merged !== null) out.body = merged;
    else notes.push({ ...older, id: newId() });
  }
  const left = unionLeft(l, r);
  if (left) out.left = left;
  else delete out.left;
  return out;
}

// Who left a note: the union of both sides (undefined when nobody).
function unionLeft(...notes) {
  const ids = [...new Set(notes.flatMap(n => n.left || []))];
  return ids.length ? ids : undefined;
}

function states(file) {
  const map = new Map();
  for (const m of [...(file.moved || []), ...(file.purged || [])]) map.set(m.id, m);
  for (const n of file.notes) map.set(n.id, n);
  return map;
}

const isNote = s => s && "body" in s;

function same(a, b) {
  if (!a || !b) return !a && !b;
  if (isNote(a) !== isNote(b)) return false;
  if (!isNote(a)) return true;
  return ["status", "created", "modified", "due", "closed", "body", "deleted", "kept", "color", "decor", "copied"].every(k => a[k] === b[k]) && (a.left || []).join() === (b.left || []).join();
}
