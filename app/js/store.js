// App state: the notes files and the viewer's settings. In the prototype the
// files live in localStorage (the app phase swaps this for real .md files);
// every change is written through serializeNotesFile, so the stored text is
// always a valid NoteDown file. `state.file` is the private file, each entry
// of `state.shared` the file of one set of people (docs/sync-and-sharing.md).
import { parseNotesFile, serializeNotesFile, createNote, timestamp } from "./core/notes-file.js";
import { moveNote } from "./core/merge.js";
import { circleKey, mergeCircle } from "./core/sharing.js";
import { DEFAULT_SORT } from "./core/query.js";

const FILE_KEY = "notedown.file";
const SHARED_KEY = "notedown.shared";
const SYNC_KEY = "notedown.sync";
const SETTINGS_KEY = "notedown.settings";
const PROTECTED_KEY = "notedown.protected";

export const DEFAULT_SETTINGS = {
  flavor: "system",          // system | latte | frappe | macchiato | mocha
  tocDepth: 2,
  sort: structuredClone(DEFAULT_SORT),
  protectedFirst: { open: false, closed: false }, // "Protected first", per view
  reminders: { on: false, time: "09:00" },          // due-date reminders (#1): this device only, not synced
};

// Sync and identity. Real sync (sync/client.js) keeps `identity`,
// `identityKey` (b64u), `device` (this device's ID) and `file` ({ id, version,
// base text }) of the private file and `files` ({ [circleKey]: { id, version, base } }) of the
// shared files, matched to `state.shared` by the circle; `renew` lists the files (circleKey, ""
// = private) whose key still has to be renewed after a device was removed. The device keys and
// file keys live in IndexedDB.
// `simulated` (the sample, ?sample) runs sync-sim.js instead, with fake
// `recoveryKey`, `devices` (the other devices' names) and `contacts`; real
// contacts are in the private file (`contacts()`). `requests` are the incoming
// contact requests, { id, name, via } (real: also `identity`), from the
// server in each round (sync/contacts.js) or simulated.
// `usage` ({ used, quota } in bytes) is the server storage, from each round's file list;
// `storageFull`: the last upload was refused for the quota.
// status is "synced" | "syncing" | "offline" | "error" (with `error`), lastSync in ms.
export const DEFAULT_SYNC = {
  enabled: false, name: "", simulated: false, identity: "", identityKey: "", device: "", file: null, files: {}, renew: [],
  recoveryKey: "", devices: [], contacts: [], requests: [], usage: null, storageFull: false, offline: false, status: "synced", lastSync: null, error: "",
};

const emptyFile = () => ({ preamble: "", notes: [], moved: [] });

export const state = {
  file: emptyFile(),
  shared: [],                // [{ members: [contact ids], file }]
  sync: structuredClone(DEFAULT_SYNC),
  settings: structuredClone(DEFAULT_SETTINGS),
  view: "open",              // open | closed
  search: "",
  panelTab: "toc",           // sidebar / sheet tab: toc | people
  circle: null,              // people filter (#23): null = all, else a circleKey ("" = private); not remembered
  editingId: null,
  topId: null,               // a new note stays on top until its first edit ends
  protectedIds: new Set(),   // ids protected from deletion: a setting of this device, not synced
  selected: new Set(),       // multi-select (ui/selection.js); empty = not selecting
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); }
function emit(kind) { listeners.forEach(fn => fn(kind)); }

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
let erased = false;
function write(key, value) {
  if (erased) return;
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: keep in memory */ }
}

/** Removes everything NoteDown stored in localStorage (every `notedown.` key)
 *  and stops writing for the rest of this page's life, so a late change can't
 *  bring a key back before the page reloads (signing out). */
export function eraseStoredState() {
  erased = true;
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith("notedown.")) localStorage.removeItem(key);
  } catch { /* storage unavailable: nothing stored */ }
}

/** Loads stored state; returns false when there is no stored file yet. */
export function load() {
  try {
    const s = JSON.parse(read(SETTINGS_KEY) || "{}");
    state.settings = {
      ...structuredClone(DEFAULT_SETTINGS), ...s,
      sort: { ...structuredClone(DEFAULT_SORT), ...(s.sort || {}) },
      protectedFirst: { ...DEFAULT_SETTINGS.protectedFirst, ...(s.protectedFirst || {}) },
    };
  } catch { /* keep defaults */ }
  try { state.protectedIds = new Set(JSON.parse(read(PROTECTED_KEY) || "[]")); } catch { state.protectedIds = new Set(); }
  try {
    const sync = { ...structuredClone(DEFAULT_SYNC), ...JSON.parse(read(SYNC_KEY) || "{}") };
    // Stored before real sync existed: the sample's simulated identity.
    if (sync.enabled && !sync.identity) sync.simulated = true;
    sync.status = sync.enabled && sync.offline ? "offline" : "synced";
    sync.storageFull = false;
    state.sync = sync;
  } catch { /* keep defaults */ }
  try {
    state.shared = JSON.parse(read(SHARED_KEY) || "[]").map(s => ({ members: s.members, file: withMoved(parseNotesFile(s.text)) }));
  } catch { state.shared = []; }
  const text = read(FILE_KEY);
  if (text === null) return false;
  state.file = withMoved(parseNotesFile(text));
  return true;
}

const withMoved = file => ({ ...file, moved: file.moved || [] });

/** Replaces everything (sample reset, linking a device): parsed private
 *  `file`, `shared` ([{ members, file }]) and the `sync` state. */
export function replaceFiles({ file, shared = [], sync = null }) {
  state.file = withMoved(file);
  state.shared = shared.map(s => ({ members: [...s.members], file: withMoved(s.file) }));
  state.sync = { ...structuredClone(DEFAULT_SYNC), ...sync };
  saveFiles({ notify: false });
  saveSync();
  emit("structure");
}

/** Replaces the private file with a synced version; no "files changed" event. */
export function setPrivateFile(file) {
  state.file = withMoved(file);
  saveFiles({ notify: false });
  emit("structure");
}

/** The private file as text (what sync uploads; ⋮ → "Download notes.md"). */
export function fileText() {
  return serializeNotesFile(state.file);
}

/** The shared files, as { key (circleKey), members, file }. */
export const sharedFiles = () => state.shared.map(s => ({ key: circleKey(s.members), members: s.members, file: s.file }));

/** Replaces the file of a set of people with a synced version, created on first use; no "files changed" event. */
export function setSharedFile(memberIds, file) {
  fileFor(memberIds);
  state.shared.find(s => circleKey(s.members) === circleKey(memberIds)).file = withMoved(file);
  saveFiles({ notify: false });
  emit("structure");
}

const allFiles = () => [state.file, ...state.shared.map(s => s.file)];

/** Every note of every file. */
export function allNotes() {
  return allFiles().flatMap(f => f.notes);
}

// The file that holds a note, with its member ids ([] = the private file).
function holderOf(id) {
  if (state.file.notes.some(n => n.id === id)) return { members: [], file: state.file };
  return state.shared.find(s => s.file.notes.some(n => n.id === id)) || null;
}

/** The member ids of every shared file. */
export function sharedCircles() {
  return state.shared.map(s => [...s.members]);
}

/** The user's contacts, [{ id, name, color, pending? }]: the markers of the private file (synced; the
 *  id is the contact's identity ID), in the sample the simulated list in the sync state. */
export function contacts() {
  return state.sync.simulated ? state.sync.contacts : state.file.contacts || [];
}

/** Replaces the contacts of the private file (real sync); saved, synced and shown like any change. */
export function setContacts(list) {
  state.file.contacts = list;
  saveFiles();
  emit("structure");
}

/** Whether the people overview (#23) shows: sync on and at least one contact. */
export function hasPeople() {
  return state.sync.enabled && contacts().length > 0;
}

/** The people filter in effect: null (all) when the overview isn't shown. */
export function activeCircle() {
  return hasPeople() ? state.circle : null;
}

/** The notes of one circle (circleKey, "" = private); every note for null. */
export function circleNotes(key) {
  if (key === null) return allNotes();
  if (key === "") return state.file.notes;
  return state.shared.find(s => circleKey(s.members) === key)?.file.notes || [];
}

/** The member ids of the circle a note lives in ([] = private). */
export function circleOf(id) {
  const holder = holderOf(id);
  return holder ? [...holder.members] : [];
}

// The file of a set of people; created on first use. The empty set is the private file.
function fileFor(memberIds) {
  if (!memberIds.length) return state.file;
  const key = circleKey(memberIds);
  let entry = state.shared.find(s => circleKey(s.members) === key);
  if (!entry) {
    entry = { members: [...memberIds], file: emptyFile() };
    state.shared.push(entry);
  }
  return entry.file;
}

// Listeners for "a file changed" (not the settings or view): the simulated sync.
const fileListeners = new Set();
export function onFilesChanged(fn) { fileListeners.add(fn); }

function saveFiles({ notify = true } = {}) {
  write(FILE_KEY, serializeNotesFile(state.file));
  write(SHARED_KEY, JSON.stringify(state.shared.map(s => ({ members: s.members, text: serializeNotesFile(s.file) }))));
  if (notify) fileListeners.forEach(fn => fn());
}

function saveSync() { write(SYNC_KEY, JSON.stringify(state.sync)); }

/** Changes the sync state; the "sync" event does not re-render the note list. */
export function setSync(patch) {
  state.sync = { ...state.sync, ...patch };
  saveSync();
  emit("sync");
}

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  write(SETTINGS_KEY, JSON.stringify(state.settings));
  emit("structure");
}

export function setUi(patch, kind = "structure") {
  Object.assign(state, patch);
  emit(kind);
}

export function note(id) {
  return allNotes().find(n => n.id === id);
}

/** The user's custom order (backlog #24): note ids, kept in the private
 *  file (synced, but only the user's devices see it). */
export function customOrder() {
  return state.file.order?.ids || [];
}

/** Sets the custom order, without ids of notes that are gone; returns a
 *  function that undoes it. */
export function setCustomOrder(ids) {
  const before = state.file.order || null;
  const known = new Set(allNotes().map(n => n.id));
  state.file.order = { ids: ids.filter(id => known.has(id)), modified: timestamp() };
  saveFiles();
  emit("structure");
  return () => { state.file.order = before; saveFiles(); emit("structure"); };
}

/** The shared order of a circle (backlog #25): note ids, kept in that
 *  circle's file, so every member sees and edits the same order. */
export function circleOrder(key) {
  return state.shared.find(s => circleKey(s.members) === key)?.file.order?.ids || [];
}

/** Sets a circle's shared order; returns a function that undoes it. */
export function setCircleOrder(key, ids) {
  const file = fileFor(key.split("+"));
  const before = file.order || null;
  const known = new Set(file.notes.map(n => n.id));
  file.order = { ids: ids.filter(id => known.has(id)), modified: timestamp() };
  saveFiles();
  emit("structure");
  return () => { file.order = before; saveFiles(); emit("structure"); };
}

export const isProtected = id => state.protectedIds.has(id);

/** Protects notes from deletion on this device, or removes that (`on` false);
 *  returns a function that undoes it.
 *  Each note is patched in place, so the list doesn't reorder. */
export function setProtected(ids, on) {
  const changed = ids.filter(id => state.protectedIds.has(id) !== on);
  const apply = value => {
    for (const id of changed) value ? state.protectedIds.add(id) : state.protectedIds.delete(id);
    write(PROTECTED_KEY, JSON.stringify([...state.protectedIds]));
    changed.forEach(id => emit("note:" + id));
  };
  apply(on);
  return () => apply(!on);
}

/** Changes a note's body; "note" events re-render that note in place. */
export function setBody(id, body) {
  const n = note(id);
  if (!n || n.body === body) return;
  n.body = body;
  n.modified = timestamp();
  saveFiles();
  emit("note:" + id);
}

/** Sets or clears (null) a note's due date. */
export function setDue(id, due) {
  const n = note(id);
  if (!n || n.due === due) return;
  n.due = due;
  saveFiles();
  emit("note:" + id);
}

/** A new note starts in the private file, or in the file of `memberIds`
 *  (the circle the list is filtered to, #23), created on first use. */
export function addNote(body, memberIds = []) {
  const n = createNote(body, timestamp());
  fileFor(memberIds).notes.unshift(n);
  saveFiles();
  return n;
}

/** Removes a note; returns a function that restores it. */
export function removeNote(id) {
  return removeNotes([id]);
}

/** Removes several notes; returns a function that puts them back in place. */
export function removeNotes(ids) {
  const putBack = takeOut(ids);
  saveFiles();
  emit("structure");
  return () => { putBack(); saveFiles(); emit("structure"); };
}

// Takes notes out of their files; the returned function reinserts them at
// their old positions.
function takeOut(ids) {
  const removed = [];
  for (const file of allFiles()) {
    file.notes.forEach((n, i) => { if (ids.includes(n.id)) removed.push([file, i, n]); });
    file.notes = file.notes.filter(n => !ids.includes(n.id));
  }
  return () => { for (const [file, i, n] of removed) file.notes.splice(i, 0, n); };
}

/** Closes or reopens a note; returns a function that undoes it. */
export function setStatus(id, status) {
  return setStatuses([id], status);
}

/** Closes or reopens several notes at once; returns a function that undoes it. */
export function setStatuses(ids, status) {
  const changed = ids.map(note).filter(n => n && n.status !== status);
  if (!changed.length) return () => {};
  const before = changed.map(n => [n, { status: n.status, closed: n.closed }]);
  const now = timestamp();
  for (const n of changed) { n.status = status; n.closed = status === "closed" ? now : null; }
  saveFiles();
  emit("structure");
  return () => { for (const [n, b] of before) Object.assign(n, b); saveFiles(); emit("structure"); };
}

/**
 * Merge and "move to a new note" (core/selection.js → mergeParts): sets each
 * source note's remaining body from `changes` ([{ id, body }], body null =
 * the note goes) and adds the new note ({ body, created, due }) at the top
 * of a file; returns { note, undo }. The file follows core/sharing.js →
 * mergeCircle: across circles, `mode` "copy" makes a private note and leaves
 * the shared sources untouched, "share" puts it into the circle of everyone
 * involved. The new note is protected when one of the sources was.
 */
export function applyMerge(changes, merged, mode = "copy") {
  const ids = changes.map(c => c.id);
  const { members, keepShared } = mergeCircle(ids.map(circleOf), mode);
  const target = fileFor(members);
  if (keepShared) changes = changes.filter(c => !circleOf(c.id).length);
  const now = timestamp();
  const edited = changes.filter(c => c.body !== null).map(c => {
    const n = note(c.id);
    const before = { body: n.body, modified: n.modified };
    Object.assign(n, { body: c.body, modified: now });
    return [n, before];
  });
  const putBack = takeOut(changes.filter(c => c.body === null).map(c => c.id));
  const n = createNote(merged.body, now);
  n.created = merged.created || n.created;
  n.due = merged.due;
  target.notes.unshift(n);
  const unprotect = ids.some(isProtected) ? setProtected([n.id], true) : () => {};
  saveFiles();
  emit("structure");
  return {
    note: n,
    undo: () => {
      unprotect();
      target.notes = target.notes.filter(x => x.id !== n.id);
      putBack();
      for (const [x, before] of edited) Object.assign(x, before);
      saveFiles();
      emit("structure");
    },
  };
}

// Moves a note between two files in place (the file objects keep their
// identity), leaving a moved marker in the old one.
function applyMove(from, to, id, now) {
  const moved = moveNote(from, to, id, now);
  Object.assign(from, moved.from);
  Object.assign(to, moved.to);
}

/** Moves notes into the file of exactly these people ([] = private), created
 *  on first use; returns a function that moves them back. */
export function shareNotes(ids, memberIds) {
  const target = fileFor(memberIds);
  const now = timestamp();
  const moves = [];
  for (const id of ids) {
    const holder = holderOf(id);
    if (!holder || holder.file === target) continue;
    applyMove(holder.file, target, id, now);
    moves.push({ id, from: holder.file });
  }
  if (!moves.length) return () => {};
  saveFiles();
  emit("structure");
  return () => {
    for (const { id, from } of moves) {
      const holder = holderOf(id);
      if (!holder) continue;
      applyMove(holder.file, from, id, timestamp());
      holder.file.moved = holder.file.moved.filter(m => m.id !== id);
    }
    saveFiles();
    emit("structure");
  };
}
