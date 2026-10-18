// App state: the notes files and the viewer's settings. The files, the sync
// state and the settings are kept in the encrypted vault (vault.js, backlog #19):
// read once at start into memory, every change written back; each file is
// written through serializeNotesFile, so the stored text is always a valid
// NoteDown file. `state.file` is the private file, each entry
// of `state.shared` the file of one set of people (docs/sync-and-sharing.md).
import { parseNotesFile, serializeNotesFile, createNote, timestamp } from "./core/notes-file.js";
import { moveNote, moveTarget, hasLeft } from "./core/merge.js";
import { refOf, assignRefs } from "./core/note-ref.js";
import { circleKey, mergeCircle, keepsPart } from "./core/sharing.js";
import { DEFAULT_SORT, expiredTrash, isSectionId } from "./core/query.js";
import { returnDone } from "./core/tasks.js";
import { privateCopy } from "./core/note-links.js";
import { DEFAULT_EXTERNAL } from "./core/external.js";
import { DEFAULT_LOCK } from "./core/app-lock.js";
import { NEWS, newsNotes as feedNotes, markNews, pruneNews } from "./core/news.js";
import { openVault, onVaultChange } from "./vault.js";

const FILE_KEY = "notedown.file";
const SHARED_KEY = "notedown.shared";
const SYNC_KEY = "notedown.sync";
const SETTINGS_KEY = "notedown.settings";

export const DEFAULT_SETTINGS = {
  flavor: "system",          // system | latte | frappe | macchiato | mocha
  tocDepth: 2,
  tocProgress: false,        // task progress in the contents and at the notes' headings (ui/toc.js)
  sort: structuredClone(DEFAULT_SORT),
  permanentFirst: false,     // "Permanent first" in the main view
  collapsedSections: [],     // custom order sections (#24) folded in the list and contents: their section ids, this device only
  reminders: { on: false, time: "09:00", show: "count" },   // due-date reminders (#1, #57): this device only, not synced
  lock: structuredClone(DEFAULT_LOCK),          // screen lock (#6): this device only, never synced
  privacy: { screenSecurity: true, incognitoKeyboard: true },   // Android: hide in recent apps / no keyboard learning (#59), this device only
  lastBackup: null,          // ISO time of the last backup made on this device (#56)
  exportOptions: { archive: false, toc: false, metadata: true }, // the export dialog's last choices, this device only
  external: structuredClone(DEFAULT_EXTERNAL),   // links and embedded media (#30): { media, links, circles }, this device only, never synced
  storageHintHidden: null,   // "YYYY-MM-DD" the "only in this browser" hint was hidden (ui/storage-hint.js), this device only
};

// Sync and identity. Real sync (sync/client.js) keeps `identity`,
// `identityKey` (b64u), `device` (this device's ID) and `file` ({ id, version,
// base text, server }) of the private file and `files` ({ [circleKey]: { server, id, version, base } }) of the
// shared files (`server`: the server the file lives on), matched to `state.shared` by the circle; `renew` lists the files (circleKey, ""
// = private) whose key still has to be renewed after a device was removed, `history` the files whose server
// file keeps a version history (a member has it switched on), `restore` the files whose next upload restores
// an older state (the server pins the state it replaces). The device keys and
// file keys live in IndexedDB. `server` is the identity's home server ("" = the default server, the
// configured API address).
// `simulated` (the sample, ?sample) runs sync-sim.js instead, with fake
// `recoveryKey`, `devices` (the other devices' names) and `contacts`; real
// contacts are in the private file (`contacts()`). `requests` are the incoming
// contact requests, { id, name, via, inPerson } (`inPerson`: made on a code this device showed; real: also `identity`), from the
// server in each round (sync/contacts.js) or simulated.
// `epochs` ({ [server]: epoch }): the restore epoch each server reported last (sync/files.js; a changed one means
// the server was restored from a backup).
// `news` ({ version, posts: [{ id, created, modified, body }] } or null): the server owner's news feed, fetched
// when the file list reports a new version (sync/files.js) or, in the sample, from app/sample/news.md.
// `usage` ({ used, quota } in bytes) is the server storage, from each round's file list, and `maxMembers` the
// most members a new group of this identity may have (null until known);
// `storageFull`: the last upload was refused for the quota.
// `deleted`: the deleted identities among the members of the shared files (shown as deleted, backlog #34);
// `ended`: "removed" once this device was taken off the device list, "deleted" once its identity was deleted
// from the server (sync is off, the notes stayed; ui/sync-notice.js); `blocked` ({ until } or null): the
// server's owner blocks the identity (backlog #34); `outdated`: the server no longer serves this app version
// (426, backlog #51) until it is updated.
// status is "synced" | "syncing" | "offline" | "error" (with `error`), lastSync in ms.
export const DEFAULT_SYNC = {
  enabled: false, name: "", simulated: false, identity: "", server: "", identityKey: "", device: "", file: null, files: {}, epochs: {}, renew: [], history: [], restore: [], news: null,
  recoveryKey: "", devices: [], contacts: [], requests: [], usage: null, maxMembers: null, storageFull: false, offline: false, status: "synced", lastSync: null, error: "",
  deleted: [], ended: "", blocked: null, outdated: false,
};

const emptyFile = () => ({ preamble: "", notes: [], moved: [] });

export const state = {
  file: emptyFile(),
  shared: [],                // [{ members: [contact ids], file }]
  sync: structuredClone(DEFAULT_SYNC),
  settings: structuredClone(DEFAULT_SETTINGS),
  view: "open",              // open | closed | trash
  search: "",
  panelTab: "toc",           // sidebar / sheet tab: toc | people | labels
  labels: [],                // label filter: the picked label names, none = all (core/filters.js); not remembered
  circles: [],               // people filter (#23): the picked circleKeys ("" = private), none = all; not remembered
  picking: null,             // the tab picking several entries (ui/filter-pick.js): null | "people" | "labels"
  editingId: null,
  topId: null,               // a new note stays on top until its first edit ends or view, sort, search or circle change
  selected: new Set(),       // multi-select (ui/selection.js); empty = not selecting
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); }
function emit(kind) { listeners.forEach(fn => fn(kind)); }

// The stored records, as read at start (and when another tab changed them); `vault` once open.
const records = new Map();
let vault = null;
function read(key) {
  return records.has(key) ? records.get(key) : null;
}
let erased = false;
function write(key, value) {
  if (erased) return;
  records.set(key, value);
  vault?.put(key, value).catch(() => { /* storage unavailable: keep in memory */ });
}

/** Erases everything NoteDown stored (the vault with its key, and any `notedown.` key in localStorage)
 *  and stops writing for the rest of this page's life, so a late change can't bring a record back before the
 *  page reloads (signing out). */
export async function eraseStoredState() {
  erased = true;
  records.clear();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith("notedown.")) localStorage.removeItem(key);
  } catch { /* storage unavailable: nothing stored */ }
  await (vault || await openVault().catch(() => null))?.clear();
  vault = null;
}

const RECORDS = [FILE_KEY, SHARED_KEY, SYNC_KEY, SETTINGS_KEY];

async function readRecords(names = RECORDS) {
  for (const name of names) {
    const value = await vault.get(name);
    if (value === undefined) records.delete(name); else records.set(name, value);
  }
}

/** Waits until every change is stored (before a reload or leaving the page on purpose). */
export const flushStored = () => vault?.flush() ?? Promise.resolve();

/** Opens the vault and loads the stored state; resolves to false when there is no stored file yet. */
export async function load() {
  vault = await openVault();
  await readRecords();
  try {
    const s = JSON.parse(read(SETTINGS_KEY) || "{}");
    state.settings = {
      ...structuredClone(DEFAULT_SETTINGS), ...s,
      sort: { ...structuredClone(DEFAULT_SORT), ...(s.sort || {}) },
      external: { ...structuredClone(DEFAULT_EXTERNAL), ...(s.external || {}) },
      lock: { ...DEFAULT_LOCK, ...(s.lock || {}) },
      privacy: { ...DEFAULT_SETTINGS.privacy, ...(s.privacy || {}) },
    };
  } catch { /* keep defaults */ }
  try {
    const sync = { ...structuredClone(DEFAULT_SYNC), ...JSON.parse(read(SYNC_KEY) || "{}") };
    // Stored before real sync existed: the sample's simulated identity.
    if (sync.enabled && !sync.identity) sync.simulated = true;
    sync.status = sync.enabled && sync.offline ? "offline" : "synced";
    sync.storageFull = false;
    state.sync = sync;
  } catch { /* keep defaults */ }
  return readFiles();
}

// The private and shared files from storage; false when there is no private file yet.
function readFiles() {
  try {
    state.shared = JSON.parse(read(SHARED_KEY) || "[]").map(s => ({ members: s.members, file: withMoved(parseNotesFile(s.text)) }));
  } catch { state.shared = []; }
  const text = read(FILE_KEY);
  if (text === null) return false;
  state.file = withMoved(parseNotesFile(text));
  buildRefs();
  return true;
}

/** Follows the files another tab of this browser changed (the import page,
 *  a second app tab): reads them again, re-renders and lets sync upload. */
export function followOtherTabs() {
  onVaultChange(async name => {
    if (name !== FILE_KEY && name !== SHARED_KEY) return;
    await readRecords([name]);
    readFiles();
    emit("structure");
    fileListeners.forEach(fn => fn());
  });
}

/** Adds notes restored from a backup to the private file, on top. */
export function addRestoredNotes(notes) {
  state.file.notes.unshift(...notes);
  saveFiles();
  emit("structure");
}

/** The ids of every note on this device: private (trash included) and shared. */
export const noteIds = () => allFiles().flatMap(f => f.notes.map(n => n.id));

/** Adds imported notes (the Google Keep import) to the private file, on top. */
export function importNotes(notes) {
  state.file.notes.unshift(...notes);
  saveFiles();
  emit("structure");
}

const withMoved = file => ({ ...file, moved: file.moved || [], purged: file.purged || [] });

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

// A note this user left stays in the shared file until a remaining member moves it; no view shows it.
const visible = n => !hasLeft(n, state.sync.identity);

/** Every note of every file (the ones this user left and the trash excluded). */
export function allNotes() {
  return allFiles().flatMap(f => f.notes).filter(n => visible(n) && !n.deleted);
}

/** The trash: deleted notes, waiting in the private file for TRASH_DAYS (docs/sync-and-sharing.md → "Trash"). */
export function trashNotes() {
  return state.file.notes.filter(n => n.deleted);
}

/** Empties the trash of notes whose time is up; any of the user's devices does it. */
export function purgeExpiredTrash(now = Date.now()) {
  const gone = expiredTrash(state.file.notes, now);
  if (!gone.length) return;
  takeOut(gone.map(refOf));
  markPurged(gone, timestamp(new Date(now)));
  saveFiles();
  emit("structure");
}

// A note from a shared file removed from the trash for good leaves a purged marker, so a device of this user that
// still has it in its copy of the shared file doesn't put it into the trash again (docs/sync-and-sharing.md →
// "Trash"); returns a function that takes the markers back out.
function markPurged(notes, now) {
  const marks = notes.filter(n => n.kept).map(n => ({ id: n.id, purged: now }));
  state.file.purged = [...state.file.purged.filter(m => !marks.some(k => k.id === m.id)), ...marks];
  return () => { state.file.purged = state.file.purged.filter(m => !marks.includes(m)); };
}

// The file that holds a note (by address, core/note-ref.js), with its member ids ([] = the private file) and the note.
function holderOf(ref) {
  const find = f => f.notes.find(n => refOf(n) === ref);
  const own = find(state.file);
  if (own) return { members: [], file: state.file, note: own };
  for (const s of state.shared) {
    const n = find(s.file);
    if (n) return { members: s.members, file: s.file, note: n };
  }
  return null;
}

/** The display name a shared file's markers give a member (someone who isn't a contact), or undefined. */
export function memberName(id) {
  for (const s of state.shared) {
    const m = (s.file.members || []).find(x => x.id === id);
    if (m) return m.name;
  }
  return undefined;
}

/** The member ids of every shared file, and of the circles trashed shared notes came from (`keptCircle`). */
export function sharedCircles() {
  const keys = new Set(state.shared.map(s => circleKey(s.members)));
  const kept = [...new Set(state.file.notes.filter(n => n.kept && !keys.has(n.kept)).map(n => n.kept))];
  return [...state.shared.map(s => [...s.members]), ...kept.map(k => k.split("+"))];
}

/** The user's contacts, [{ id, name, color, server?, pending?, verified? }]: the markers of the private file (synced; the
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

/** Changes one contact (both modes): the private file's marker, in the sample the simulated list. */
export function updateContact(id, patch) {
  const list = contacts().map(c => (c.id === id ? { ...c, ...patch } : c));
  if (state.sync.simulated) setSync({ contacts: list });
  else setContacts(list);
}

// ---------- news (core/news.js) ----------

const newsPosts = () => (state.sync.enabled && state.sync.news?.posts) || [];

/** The news posts as read-only notes (deleted ones left out); none while sync is off. */
export function newsNotes() {
  return feedNotes(newsPosts(), state.file.news || []);
}

export const isNews = id => newsPosts().some(p => p.id === id);

/** Takes over a fetched feed ({ version, posts }) and drops the markers of posts no longer in it. */
export function setNewsFeed(news) {
  setSync({ news });
  const kept = pruneNews(state.file.news || [], news.posts);
  if (kept.length !== (state.file.news || []).length) setNewsMarks(kept);
  else emit("structure");
}

function setNewsMarks(marks) {
  state.file.news = marks;
  saveFiles();
  emit("structure");
}

/** The user saw these posts (they lose their "new" / "updated" label on all the user's devices). */
export function markNewsSeen(ids) {
  const fresh = newsNotes().filter(n => n.fresh && ids.includes(n.id)).map(n => n.id);
  if (fresh.length) setNewsMarks(markNews(state.file.news || [], newsPosts(), fresh));
}

// Archives, reopens ("open") or deletes posts; returns a function that undoes it.
function setNewsStatus(ids, status) {
  const before = state.file.news || [];
  setNewsMarks(markNews(before, newsPosts(), ids, status));
  return () => setNewsMarks(before);
}

/** The one circle the list is filtered to: null for all notes or several circles. */
export function activeCircle() {
  return state.circles.length === 1 ? state.circles[0] : null;
}

/** The notes of one circle (circleKey, "" = private), its trash included (the views filter); every note for null. */
export function circleNotes(key) {
  if (key === null) return [...allNotes(), ...trashNotes()];
  if (key === NEWS) return newsNotes();
  if (key === "") return state.file.notes.filter(n => !n.kept);
  const shared = (state.shared.find(s => circleKey(s.members) === key)?.file.notes || []).filter(visible);
  return [...shared, ...state.file.notes.filter(n => n.kept === key)];
}

/** The member ids of the circle a note lives in ([] = private). */
export function circleOf(id) {
  const holder = holderOf(id);
  return holder ? [...holder.members] : [];
}

/** The member ids of the circle a trashed shared note came from ([] for every other note). */
export function keptCircle(id) {
  const n = state.file.notes.find(x => refOf(x) === id);
  return n?.kept ? n.kept.split("+") : [];
}

/** Takes notes out of the trash; returns a function that undoes it. A note from a shared file goes back to its
 *  circle (its file, created on first use), or with `own` stays a private note of this user. */
export function restoreNotes(ids, { own = false } = {}) {
  const notes = trashNotes().filter(n => ids.includes(refOf(n)));
  const before = notes.map(n => [n, { deleted: n.deleted, kept: n.kept }]);
  const circles = new Map();   // circleKey → ids going back to that circle
  for (const n of notes) {
    if (n.kept && !own) circles.set(n.kept, [...(circles.get(n.kept) || []), refOf(n)]);
    delete n.deleted;
    delete n.kept;
  }
  const unshare = [...circles].map(([key, back]) => shareNotes(back, key.split("+")));
  saveFiles();
  emit("structure");
  return () => {
    unshare.reverse().forEach(undo => undo());
    for (const [n, b] of before) Object.assign(n, b);
    saveFiles();
    emit("structure");
  };
}

/** Deletes trashed notes for good; returns a function that brings them back. */
export function purgeNotes(ids) {
  const putBack = takeOut(ids);
  const unmark = markPurged(putBack.notes, timestamp());
  saveFiles();
  emit("structure");
  return () => { putBack(); unmark(); saveFiles(); emit("structure"); };
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

// Addresses the notes by file and ID (core/note-ref.js): private file first, the shared ones by circle.
function buildRefs() {
  assignRefs([{ key: "", notes: state.file.notes },
    ...state.shared.map(s => ({ key: circleKey(s.members), notes: s.file.notes })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))]);
}

function saveFiles({ notify = true } = {}) {
  buildRefs();
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
  return allNotes().find(n => refOf(n) === id) || trashNotes().find(n => refOf(n) === id) || newsNotes().find(n => n.id === id);
}

/** The user's custom order (backlog #24): note ids, kept in the private
 *  file (synced, but only the user's devices see it). */
export function customOrder() {
  return state.file.order?.ids || [];
}

/** Sets the custom order, without ids of notes that are gone (section
 *  entries stay); returns a function that undoes it. */
export function setCustomOrder(ids) {
  const before = state.file.order || null;
  const known = new Set(allNotes().map(refOf));
  state.file.order = { ids: ids.filter(id => known.has(id) || isSectionId(id)), modified: timestamp() };
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
  const known = new Set(file.notes.map(refOf));
  file.order = { ids: ids.filter(id => known.has(id) || isSectionId(id)), modified: timestamp() };
  saveFiles();
  emit("structure");
  return () => { file.order = before; saveFiles(); emit("structure"); };
}

/** Changes a note's body; "note" events re-render that note in place. */
export function setBody(id, body) {
  const n = note(id);
  if (!n || n.news || n.body === body) return;
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

/** Sets the color and / or motif (`look`: { color?, decor? }, null clears) of notes (core/look.js); like the due
 *  date it is no content change, so `modified` stays. Returns a function that undoes it. */
export function setLook(ids, look) {
  const changed = ids.map(note).filter(n => n && !n.news && Object.keys(look).some(k => (n[k] || null) !== look[k]));
  if (!changed.length) return () => {};
  const apply = (n, l) => { for (const [k, v] of Object.entries(l)) { if (v) n[k] = v; else delete n[k]; } };
  const before = changed.map(n => [n, Object.fromEntries(Object.keys(look).map(k => [k, n[k] || null]))]);
  for (const n of changed) apply(n, look);
  saveFiles();
  for (const n of changed) emit("note:" + refOf(n));
  return () => { for (const [n, b] of before) apply(n, b); saveFiles(); for (const [n] of before) emit("note:" + refOf(n)); };
}

/** A new note starts in the private file, or in the file of `memberIds`
 *  (the circle the list is filtered to, #23), created on first use. */
export function addNote(body, memberIds = []) {
  const n = createNote(body, timestamp());
  fileFor(memberIds).notes.unshift(n);
  saveFiles();
  return n;
}

/** Private copies of shared notes (backlog #45): each a new private note on top with the same text, linked back
 *  to its original (core/note-links.js). Returns { notes, undo }. */
export function makePrivateCopies(ids) {
  const now = timestamp();
  const copies = ids.map(note).filter(n => n && !n.news && !n.deleted && circleOf(refOf(n)).length).map(n => privateCopy(n, now));
  state.file.notes.unshift(...copies);
  saveFiles();
  emit("structure");
  return {
    notes: copies,
    undo: () => { state.file.notes = state.file.notes.filter(n => !copies.includes(n)); saveFiles(); emit("structure"); },
  };
}

/** The note a private copy was made from, while the user still sees it (not trashed); else null. */
export function copyOriginal(id) {
  const c = note(id);
  const o = c?.copyof && allNotes().find(n => n.id === c.copyof);   // by ID: the first holder when two files share it
  return o || null;
}

/** Overwrites a private copy with its original's current text; returns a function that undoes it. */
export function updateCopy(id) {
  const c = note(id), o = copyOriginal(id);
  if (!c || !o) return () => {};
  const before = { body: c.body, copied: c.copied, modified: c.modified };
  Object.assign(c, { body: o.body, copied: o.modified, modified: timestamp() });
  saveFiles();
  emit("note:" + id);
  return () => { Object.assign(c, before); saveFiles(); emit("note:" + id); };
}

/** Deletes notes into the trash (news are only hidden for this user); returns a function that undoes it. A
 *  private note is marked `deleted` in place; a shared note leaves its file (deleted for everyone in its circle)
 *  and waits in this user's private file, marked `kept` with its circle. */
export function removeNotes(ids) {
  const news = ids.filter(isNews);
  if (news.length) {
    const undoNews = setNewsStatus(news, "deleted");
    const undoNotes = news.length < ids.length ? removeNotes(ids.filter(id => !isNews(id))) : () => {};
    return () => { undoNotes(); undoNews(); };
  }
  const now = timestamp();
  const own = state.file.notes.filter(n => ids.includes(refOf(n)) && !n.deleted);
  for (const n of own) n.deleted = now;
  const shared = ids.map(id => ({ id, members: circleOf(id) })).filter(x => x.members.length);
  const kept = new Map(shared.map(x => [note(x.id), circleKey(x.members)]));
  const putBack = takeOut(shared.map(x => x.id));
  const copies = putBack.notes.map(n => ({ ...n, deleted: now, kept: kept.get(n) }));
  state.file.notes.push(...copies);
  saveFiles();
  emit("structure");
  return () => {
    for (const n of own) delete n.deleted;
    state.file.notes = state.file.notes.filter(n => !copies.includes(n));
    putBack();
    saveFiles();
    emit("structure");
  };
}

// Takes notes out of their files; the returned function reinserts them at
// their old positions, its `notes` are the notes taken out.
function takeOut(ids) {
  const removed = [];
  for (const file of allFiles()) {
    file.notes.forEach((n, i) => { if (ids.includes(refOf(n))) removed.push([file, i, n]); });
    file.notes = file.notes.filter(n => !ids.includes(refOf(n)));
  }
  const putBack = () => { for (const [file, i, n] of removed) file.notes.splice(i, 0, n); };
  putBack.notes = removed.map(([, , n]) => n);
  return putBack;
}

/** Closes, reopens or makes permanent a note; returns a function that undoes it. */
export function setStatus(id, status) {
  return setStatuses([id], status);
}

/** Closes or reopens several notes at once; returns a function that undoes it. */
export function setStatuses(ids, status) {
  const news = ids.filter(isNews);
  if (news.length) {
    const undoNews = setNewsStatus(news, status === "closed" ? "archived" : "open");
    const undoNotes = news.length < ids.length ? setStatuses(ids.filter(id => !isNews(id)), status) : () => {};
    return () => { undoNotes(); undoNews(); };
  }
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
 * involved. The new note is permanent when one of the sources was.
 */
export function applyMerge(changes, merged, mode = "copy") {
  const ids = changes.map(c => c.id);
  const permanent = ids.some(id => note(id)?.status === "permanent");
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
  if (permanent) n.status = "permanent";
  // It takes the look of the first source that has one.
  const look = ids.map(note).find(x => x && (x.color || x.decor));
  if (look?.color) n.color = look.color;
  if (look?.decor) n.decor = look.decor;
  saveFiles();
  emit("structure");
  return {
    note: n,
    undo: () => {
      target.notes = target.notes.filter(x => x !== n);
      putBack();
      for (const [x, before] of edited) Object.assign(x, before);
      saveFiles();
      emit("structure");
    },
  };
}

/**
 * Merge into an existing note (core/selection.js → mergeInto): the target
 * gets `body`, the other sources their remaining body from `changes` (null =
 * the note goes) — except sources shared in another circle, which keep
 * their part (core/sharing.js → keepsPart). Returns a function that undoes it.
 */
export function applyMergeInto(targetId, body, changes) {
  const target = circleOf(targetId);
  changes = [{ id: targetId, body }, ...changes.filter(c => !keepsPart(circleOf(c.id), target))];
  const now = timestamp();
  const edited = changes.filter(c => c.body !== null).map(c => {
    const n = note(c.id);
    const before = { body: n.body, modified: n.modified };
    Object.assign(n, { body: c.body, modified: now });
    return [n, before];
  });
  const putBack = takeOut(changes.filter(c => c.body === null).map(c => c.id));
  saveFiles();
  emit("structure");
  return () => {
    putBack();
    for (const [x, before] of edited) Object.assign(x, before);
    saveFiles();
    emit("structure");
  };
}

/**
 * Clear done tasks (core/tasks.js → clearDone): sets each note's remaining
 * body from `changes` ([{ id, body, done }], body null = the note goes) and
 * puts its done tasks into a closed note of their own, marked `from` the note,
 * in the same file (circle). Returns a function that undoes it.
 */
export function archiveDone(changes) {
  const now = timestamp();
  const edited = changes.filter(c => c.body !== null).map(c => {
    const n = note(c.id);
    const before = { body: n.body, modified: n.modified };
    Object.assign(n, { body: c.body, modified: now });
    return [n, before];
  });
  const added = changes.map(c => {
    const file = fileFor(circleOf(c.id));
    const n = { ...createNote(c.done, now), status: "closed", closed: now, from: note(c.id).id };
    file.notes.unshift(n);
    return [file, n];
  });
  const putBack = takeOut(changes.filter(c => c.body === null).map(c => c.id));
  saveFiles();
  emit("structure");
  return () => {
    for (const [file, n] of added) file.notes = file.notes.filter(x => x !== n);
    putBack();
    for (const [n, before] of edited) Object.assign(n, before);
    saveFiles();
    emit("structure");
  };
}

/** The open note an archived note of done tasks came from, or null when it is gone, closed, in the trash or in
 *  another circle (Back to note isn't possible then). */
export function doneSource(id) {
  const n = note(id);
  const home = n?.from && holderOf(id);   // the note it came from is in the same file
  const src = home && home.file.notes.find(x => x.id === n.from && visible(x) && !x.deleted);
  return src && src.status !== "closed" ? src : null;
}

/** Back to note (core/tasks.js → returnDone): puts the tasks of the archived notes `ids` back into the notes they
 *  came from and removes the archived notes; returns a function that undoes it. */
export function returnDoneTasks(ids) {
  const now = timestamp();
  const before = new Map();
  for (const id of ids) {
    const src = doneSource(id);
    if (!before.has(src)) before.set(src, { body: src.body, modified: src.modified });
    Object.assign(src, { body: returnDone(src.body, note(id).body), modified: now });
  }
  const putBack = takeOut(ids);
  saveFiles();
  emit("structure");
  return () => {
    putBack();
    for (const [n, b] of before) Object.assign(n, b);
    saveFiles();
    emit("structure");
  };
}

// Moves a note between two files in place (the file objects keep their
// identity), leaving a moved marker in the old one.
// `fromOthers`/`toOthers`: the other members of both files, for the marker's target (core/merge.js → moveTarget).
function applyMove(from, to, id, now, fromOthers, toOthers) {
  const moved = moveNote(from, to, id, now, moveTarget(fromOthers, toOthers, state.sync.identity));
  Object.assign(from, moved.from);
  Object.assign(to, moved.to);
}

/** Leaves shared notes (real sync): marks them `left` with this user's identity ID; they disappear here and a
 *  remaining member moves them on (docs/file-format.md → "Leaving a shared note"). Returns a function that undoes it. */
export function leaveNotes(ids) {
  const me = state.sync.identity;
  const marked = [];
  for (const id of ids) {
    const holder = holderOf(id);
    const n = holder?.members.length && holder.note;
    if (n && !hasLeft(n, me)) { n.left = [...(n.left || []), me]; marked.push(n); }
  }
  saveFiles();
  emit("structure");
  return () => {
    for (const marker of marked) {   // looked up again: a sync may have replaced the file, or a remaining member moved the note on
      const n = holderOf(refOf(marker))?.note;
      if (!n || !hasLeft(n, me)) continue;
      n.left = n.left.filter(x => x !== me);
      if (!n.left.length) delete n.left;
    }
    saveFiles();
    emit("structure");
  };
}

/** Moves notes into the file of exactly these people ([] = private), created
 *  on first use; returns a function that moves them back. */
export function shareNotes(ids, memberIds) {
  const target = fileFor(memberIds);
  const now = timestamp();
  const moves = [];
  for (const ref of ids) {
    const holder = holderOf(ref);
    if (!holder || holder.file === target) continue;
    applyMove(holder.file, target, holder.note.id, now, holder.members, memberIds);
    moves.push({ note: holder.note, from: holder.file, members: holder.members });
  }
  if (!moves.length) return () => {};
  saveFiles();
  emit("structure");
  return () => {
    for (const { note: n, from, members } of moves) {
      const holder = holderOf(refOf(n));
      if (!holder) continue;
      applyMove(holder.file, from, n.id, timestamp(), holder.members, members);
      holder.file.moved = holder.file.moved.filter(m => m.id !== n.id);
    }
    saveFiles();
    emit("structure");
  };
}
