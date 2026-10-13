// App state: the notes file and the viewer's settings. In the prototype the
// file lives in localStorage (the app phase swaps this for a real .md file);
// every change is written through serializeNotesFile, so the stored text is
// always a valid NoteDown file.
import { parseNotesFile, serializeNotesFile, createNote, timestamp } from "./core/notes-file.js";
import { DEFAULT_SORT } from "./core/query.js";

const FILE_KEY = "notedown.file";
const SETTINGS_KEY = "notedown.settings";

export const DEFAULT_SETTINGS = {
  flavor: "system",          // system | latte | frappe | macchiato | mocha
  tocDepth: 2,
  selectBar: "top",          // prototype variant: top | bottom
  selectLook: "check",       // prototype variant: check | tint
  sort: structuredClone(DEFAULT_SORT),
};

export const state = {
  file: { preamble: "", notes: [] },
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
  const text = read(FILE_KEY);
  if (text === null) return false;
  state.file = parseNotesFile(text);
  return true;
}

export function replaceFile(text) {
  state.file = parseNotesFile(text);
  saveFile();
  emit("structure");
}

export function fileText() {
  return serializeNotesFile(state.file);
}

function saveFile() { write(FILE_KEY, fileText()); }

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
  return state.file.notes.find(n => n.id === id);
}

/** Changes a note's body; "note" events re-render that note in place. */
export function setBody(id, body) {
  const n = note(id);
  if (!n || n.body === body) return;
  n.body = body;
  n.modified = timestamp();
  saveFile();
  emit("note:" + id);
}

/** Sets or clears (null) a note's due date. */
export function setDue(id, due) {
  const n = note(id);
  if (!n || n.due === due) return;
  n.due = due;
  saveFile();
  emit("note:" + id);
}

export function addNote(body) {
  const n = createNote(body, timestamp());
  state.file.notes.unshift(n);
  saveFile();
  return n;
}

/** Removes a note; returns a function that restores it. */
export function removeNote(id) {
  return removeNotes([id]);
}

/** Removes several notes; returns a function that puts them back in place. */
export function removeNotes(ids) {
  const putBack = takeOut(ids);
  saveFile();
  emit("structure");
  return () => { putBack(); saveFile(); emit("structure"); };
}

// Takes notes out of the file; the returned function reinserts them at
// their old positions.
function takeOut(ids) {
  const removed = [];
  state.file.notes.forEach((n, i) => { if (ids.includes(n.id)) removed.push([i, n]); });
  state.file.notes = state.file.notes.filter(n => !ids.includes(n.id));
  return () => { for (const [i, n] of removed) state.file.notes.splice(i, 0, n); };
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
  saveFile();
  emit("structure");
  return () => { for (const [n, b] of before) Object.assign(n, b); saveFile(); emit("structure"); };
}

/** Replaces notes by one new note built from `merged` ({ body, created, due },
 *  core/selection.js) at the top of the file; returns { note, undo }. */
export function mergeNotes(ids, merged) {
  const putBack = takeOut(ids);
  const n = createNote(merged.body, timestamp());
  n.created = merged.created || n.created;
  n.due = merged.due;
  state.file.notes.unshift(n);
  saveFile();
  emit("structure");
  return {
    note: n,
    undo: () => {
      state.file.notes = state.file.notes.filter(x => x.id !== n.id);
      putBack();
      saveFile();
      emit("structure");
    },
  };
}
