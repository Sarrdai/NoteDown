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
  sort: structuredClone(DEFAULT_SORT),
};

export const state = {
  file: { preamble: "", notes: [] },
  settings: structuredClone(DEFAULT_SETTINGS),
  view: "open",              // open | closed
  search: "",
  editingId: null,
  pinnedId: null,            // a new note stays on top until its first edit ends
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

export function addNote(body) {
  const n = createNote(body, timestamp());
  state.file.notes.unshift(n);
  saveFile();
  return n;
}

/** Removes a note; returns a function that restores it. */
export function removeNote(id) {
  const i = state.file.notes.findIndex(n => n.id === id);
  if (i < 0) return () => {};
  const [n] = state.file.notes.splice(i, 1);
  saveFile();
  emit("structure");
  return () => { state.file.notes.splice(i, 0, n); saveFile(); emit("structure"); };
}

/** Closes or reopens a note; returns a function that undoes it. */
export function setStatus(id, status) {
  const n = note(id);
  if (!n || n.status === status) return () => {};
  const before = { status: n.status, closed: n.closed };
  n.status = status;
  n.closed = status === "closed" ? timestamp() : null;
  saveFile();
  emit("structure");
  return () => { Object.assign(n, before); saveFile(); emit("structure"); };
}
