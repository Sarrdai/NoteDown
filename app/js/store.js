// App state: the notes files and the viewer's settings. In the prototype the
// files live in localStorage (the app phase swaps this for real .md files);
// every change is written through serializeNotesFile, so the stored text is
// always a valid NoteDown file. `state.file` is the private file, each entry
// of `state.shared` the file of one set of people (docs/sync-and-sharing.md).
import { parseNotesFile, serializeNotesFile, createNote, timestamp } from "./core/notes-file.js";
import { moveNote } from "./core/merge.js";
import { circleKey } from "./core/sharing.js";
import { DEFAULT_SORT } from "./core/query.js";

const FILE_KEY = "notedown.file";
const SHARED_KEY = "notedown.shared";
const SYNC_KEY = "notedown.sync";
const SETTINGS_KEY = "notedown.settings";

export const DEFAULT_SETTINGS = {
  flavor: "system",          // system | latte | frappe | macchiato | mocha
  tocDepth: 2,
  sort: structuredClone(DEFAULT_SORT),
};

// Sync and identity. Real sync (sync/client.js) keeps `identity`,
// `identityKey` (b64u), `device` (this device's ID) and `file` ({ id, version,
// base text }) of the private file; the device keys live in IndexedDB.
// `simulated` (the sample, ?sample) runs sync-sim.js instead, with fake
// `recoveryKey`, `devices` (the other devices' names) and `contacts`.
// status is "synced" | "syncing" | "offline" | "error" (with `error`), lastSync in ms.
export const DEFAULT_SYNC = {
  enabled: false, name: "", simulated: false, identity: "", identityKey: "", device: "", file: null,
  recoveryKey: "", devices: [], contacts: [], offline: false, status: "synced", lastSync: null, error: "",
};

const emptyFile = () => ({ preamble: "", notes: [], moved: [] });

export const state = {
  file: emptyFile(),
  shared: [],                // [{ members: [contact ids], file }]
  sync: structuredClone(DEFAULT_SYNC),
  settings: structuredClone(DEFAULT_SETTINGS),
  view: "open",              // open | closed
  search: "",
  editingId: null,
  pinnedId: null,            // a new note stays on top until its first edit ends
  selected: new Set(),       // multi-select (ui/selection.js); empty = not selecting
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); }
function emit(kind) { listeners.forEach(fn => fn(kind)); }

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: keep in memory */ }
}

/** Loads stored state; returns false when there is no stored file yet. */
export function load() {
  try {
    const s = JSON.parse(read(SETTINGS_KEY) || "{}");
    state.settings = { ...structuredClone(DEFAULT_SETTINGS), ...s, sort: { ...structuredClone(DEFAULT_SORT), ...(s.sort || {}) } };
  } catch { /* keep defaults */ }
  try {
    const sync = { ...structuredClone(DEFAULT_SYNC), ...JSON.parse(read(SYNC_KEY) || "{}") };
    // Stored before real sync existed: the sample's simulated identity.
    if (sync.enabled && !sync.identity) sync.simulated = true;
    sync.status = sync.enabled && sync.offline ? "offline" : "synced";
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

/** A new note always starts in the private file. */
export function addNote(body) {
  const n = createNote(body, timestamp());
  state.file.notes.unshift(n);
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

/** Replaces notes by one new note built from `merged` ({ body, created, due },
 *  core/selection.js) at the top of a file; returns { note, undo }. The note
 *  stays in the circle of the originals when they all share one, else it is
 *  private. */
export function mergeNotes(ids, merged) {
  const keys = new Set(ids.map(id => circleKey(circleOf(id))));
  const target = fileFor(keys.size === 1 ? circleOf(ids[0]) : []);
  const putBack = takeOut(ids);
  const n = createNote(merged.body, timestamp());
  n.created = merged.created || n.created;
  n.due = merged.due;
  target.notes.unshift(n);
  saveFiles();
  emit("structure");
  return {
    note: n,
    undo: () => {
      target.notes = target.notes.filter(x => x.id !== n.id);
      putBack();
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
