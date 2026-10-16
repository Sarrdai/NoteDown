// The note list: renders the notes of the current view, edits a note in
// place (editor.js), toggles task checkboxes and the note's own open/closed
// state. A permanent note has a mark instead of the round button; a trashed
// note is read-only; a tap selects it (ui/selection.js).
// A finished edit or a task toggle patches only that note, so the list
// never reorders under the user's finger; the order is recomputed on the
// next structural change (view, sort, search, new / closed note) and when
// a new due date sorts its note in (reorderList). News posts are read-only
// cards: no editing, no due date, a label while they are new or updated.
import { renderMarkdown, toggleTask, sections, noteTitle } from "../core/markdown.js";
import { sectionKey } from "../core/query.js";
import { state, note, setBody, setStatus, purgeNotes, circleOf, markNewsSeen } from "../store.js";
import { trashMarkerHtml } from "./trash.js";
import { relativeTime, dueLabel, shortDate } from "./format.js";
import { icon } from "./icons.js";
import { showSnackbar } from "./snackbar.js";
import { createEditor } from "./editor.js";
import { membersLabel, avatarStackHtml, esc } from "./people.js";
import { openShareDialog } from "./share-dialog.js";
import { openDueMenu } from "./toolbar.js";
import { pushEntry, leaveEntry } from "./dom.js";
import { markHits } from "./search-hits.js";
import { applyExternal } from "./external.js";
import { circleKey } from "../core/sharing.js";
import { externalPolicy } from "../core/external.js";

const list = () => document.getElementById("list");

/** Renders the tiles; `dividerBefore` (a note id) puts the custom order's
 *  "Not sorted yet" divider above that note (backlog #24). */
export function renderList(notes, options) {
  list().replaceChildren(...listItems(notes, options));
}

/** Renders the tiles in a new order but keeps `keepId`'s element (it may
 *  hold the editor): the others are placed around it. */
export function reorderList(notes, { keepId, ...options }) {
  const kept = list().querySelector(`.note[data-id="${keepId}"]`);
  const items = listItems(notes, options);
  const i = items.findIndex(el => el.dataset.id === keepId);
  if (!kept || i < 0) return list().replaceChildren(...items);
  for (const el of [...list().children]) if (el !== kept) el.remove();
  kept.before(...items.slice(0, i));
  kept.after(...items.slice(i + 1));
}

/** The tiles' elements without placing them (also the swipe's preview of the other view). */
export function listItems(notes, { dividerBefore = null, onArrange, view = state.view } = {}) {
  return notes.flatMap(n => n.id === dividerBefore ? [divider(onArrange), noteElement(n, view)] : [noteElement(n, view)]);
}

function divider(onArrange) {
  const el = document.createElement("div");
  el.className = "unsorted-divider";
  el.innerHTML = `<span>Not sorted yet</span><button class="link-btn">Arrange…</button>`;
  el.querySelector("button").addEventListener("click", onArrange);
  return el;
}

// A tap on the shared marker opens the share dialog.
// (While selecting, the selection's own click handler runs first and keeps the tap.)
document.addEventListener("click", e => {
  const hit = e.target.closest("#list button.shared-mark");
  if (!hit) return;
  const id = hit.closest(".note").dataset.id;
  if (state.editingId) endEdit();
  if (!note(id)) return;
  openShareDialog([id]);
});

// A tap on the due chip opens the due-date menu; editing another note ends first.
document.addEventListener("click", e => {
  const hit = e.target.closest("#list button.due-chip");
  if (!hit) return;
  const id = hit.closest(".note").dataset.id;
  if (state.editingId && state.editingId !== id) endEdit();
  if (note(id)) openDueMenu(hit, id);
});

export function patchNote(id) {
  const el = list().querySelector(`.note[data-id="${id}"]`);
  const n = note(id);
  if (!el || !n) return;
  // The edited note keeps its editor; only its meta line follows.
  if (state.editingId === id) el.querySelector(".note-meta").innerHTML = metaHtml(n);
  else el.replaceWith(noteElement(n));
}

function noteElement(n, view = state.view) {
  const el = document.createElement("article");
  el.className = "note" + (n.status === "closed" ? " closed" : "") + (n.status === "permanent" ? " permanent" : "")
    + (n.deleted ? " trashed" : "") + (n.news ? " news" : "") + (n.fresh ? " fresh" : "");
  el.dataset.id = n.id;

  // The round button closes or reopens; a permanent note has its mark there instead, a trashed note neither.
  const status = document.createElement(n.status === "permanent" ? "span" : "button");
  if (n.status === "permanent") {
    status.className = "permanent-mark";
    status.setAttribute("role", "img");
    status.setAttribute("aria-label", "Permanent note");
    status.title = "Permanent · can't be closed";
    status.innerHTML = icon("permanent");
  } else {
    status.className = "status";
    status.setAttribute("aria-label", n.status === "closed" ? (n.news ? "Reopen post" : "Reopen note") : n.news ? "Archive post" : "Close note");
    status.innerHTML = `<span class="ring">${icon("check")}</span>`;
    status.addEventListener("click", () => toggleStatus(n.id));
  }

  const body = document.createElement("div");
  body.className = "note-body md";
  body.innerHTML = renderMarkdown(n.body);
  applyExternal(body, circleKey(circleOf(n.id)));
  wrapSections(body, sections(n.body));
  markHits(body);
  if (n.status === "closed" || n.news || n.deleted) body.querySelectorAll("input.task").forEach(cb => (cb.disabled = true));
  body.addEventListener("click", e => onBodyClick(e, n.id));

  const meta = document.createElement("div");
  meta.className = "note-meta";
  meta.innerHTML = metaHtml(n, view);

  el.append(body, meta, ...(n.deleted ? [] : [status]));
  markSelected(el);
  return el;
}

// Groups the rendered blocks by section (core/markdown.js → sections), so
// the contents can jump to one and the selection can mark it.
function wrapSections(body, ss) {
  const groups = ss.map((_, i) => Object.assign(document.createElement("div"), { className: "md-section" }));
  groups.forEach((g, i) => { g.dataset.section = i; });
  let i = ss[0].depth === null ? 0 : -1;
  for (const child of [...body.children]) {
    if (/^H[1-6]$/.test(child.tagName)) i++;
    groups[Math.max(0, Math.min(i, groups.length - 1))].append(child);
  }
  body.replaceChildren(...groups);
}

/** Marks a card for the selection: the accent border when the whole note is
 *  selected, else a tint on each selected section. */
export function markSelected(el) {
  const groups = [...el.querySelectorAll(".md-section")];
  const on = groups.map(g => state.selected.has(sectionKey(el.dataset.id, g.dataset.section)));
  const whole = on.length > 0 && on.every(Boolean);
  el.classList.toggle("selected", whole);
  groups.forEach((g, i) => g.classList.toggle("selected", on[i] && !whole));
}

// The shared marker: overlapping avatars of the members; a button while the
// note is open (opens the share dialog), plain info in the archive. A note
// deleted from a shared file shows the circle crossed out.
function markerHtml(n) {
  if (n.deleted) return n.kept ? trashMarkerHtml(n) : "";
  const members = circleOf(n.id);
  if (!members.length) return "";
  const attrs = `class="shared-mark" aria-label="${esc("Shared with " + membersLabel(members))}"`;
  const inner = avatarStackHtml(members);
  return n.status === "open" ? `<button type="button" ${attrs}>${inner}</button>` : `<span role="img" ${attrs}>${inner}</span>`;
}

// A news post: its label while new or updated, and when it was published or last edited.
function newsMetaHtml(n) {
  const fresh = n.fresh ? `<span class="chip news-chip">${n.fresh === "new" ? "New" : "Updated"}</span>` : "";
  const edited = n.modified !== n.created;
  return `${fresh}<span>${edited ? "Edited" : "Published"} ${relativeTime(edited ? n.modified : n.created)}</span>`;
}

function metaHtml(n, view = state.view) {
  if (n.news) return newsMetaHtml(n);
  const parts = [markerHtml(n)].filter(Boolean);
  // Archived done tasks name the note they came from (Clear done tasks).
  const source = n.from && note(n.from);
  if (source) parts.push(`<span class="chip from-chip">From ${esc(noteTitle(source.body).text || "Untitled")}</span>`);
  if (n.status === "closed" || n.deleted) {
    // A closed note's due date is history, not a warning, and read-only.
    if (n.due) parts.push(`<span class="chip">${icon("calendar")}Due ${shortDate(n.due)}</span>`);
  } else if (n.due) {
    const d = dueLabel(n.due);
    parts.push(`<button type="button" class="chip due-chip ${d.kind}" aria-label="${esc(d.text + ", change due date")}">${icon("calendar")}${d.text}</button>`);
  } else {
    // An empty slot to set one.
    parts.push(`<button type="button" class="chip due-chip due-add">${icon("calendar")}Due date</button>`);
  }
  const key = state.settings.sort[view].key;
  const field = n.deleted && view === "trash" ? "deleted" : { created: "created", closed: "closed" }[key] || "modified";
  const label = { created: "Created", closed: "Closed", deleted: "Deleted", modified: "Edited" }[field];
  if (n[field]) parts.push(`<span>${label} ${relativeTime(n[field])}</span>`);
  return parts.join("");
}

function onBodyClick(e, id) {
  const n = note(id);
  if (!n || state.editingId === id) return;
  if (e.target.closest(".label-chip")) return;   // filters the list (ui/labels.js)
  if (n.news) {   // read-only; a tap counts as seen
    if (e.target.closest("input.task")) e.preventDefault();
    if (n.fresh) markNewsSeen([id]);
    return;
  }
  const cb = e.target.closest("input.task");
  if (cb) {
    e.preventDefault();
    if (n.status === "closed" || n.deleted) return;
    const index = [...e.currentTarget.querySelectorAll("input.task")].indexOf(cb);
    setBody(id, toggleTask(n.body, index));
    return;
  }
  if (e.target.closest("a, video")) return;
  if (n.deleted) return;   // read-only; the selection takes the tap
  if (n.status === "closed") return; // closed notes are read-only
  startEdit(id, { x: e.clientX, y: e.clientY });
}

// ---------- editing ----------
// One note at a time is edited in place with the live-preview editor. The
// text is saved on every change; editing ends with Done, Esc, the Android
// back key (editing sits on a history entry), or a tap / click anywhere
// outside the note and its toolbar.

let editing = null; // { id, editor }
const editListeners = new Set();
export function onEditingChange(fn) { editListeners.add(fn); }
export function currentEditor() { return editing && editing.editor; }

/** Starts editing; `at` = { x, y } of the tap puts the caret there. */
export function startEdit(id, at = {}) {
  const switching = !!editing;
  if (editing) endEdit({ keepEntry: true });   // the next note takes over the entry
  const el = list().querySelector(`.note[data-id="${id}"]`);
  const n = note(id);
  if (!el || !n) { if (switching) leaveEntry("editing"); return; }
  state.editingId = id;
  el.classList.add("editing");
  const host = document.createElement("div");
  host.className = "note-body md editor-host";
  // The page keeps its scroll position: while the host is still empty the
  // page may be too short for it and the browser would clamp it.
  const scrolled = window.scrollY;
  el.querySelector(".note-body").replaceWith(host);
  const media = externalPolicy(state.settings.external, circleKey(circleOf(id))).media;
  const editor = createEditor({ parent: host, doc: n.body, media, onChange: text => setBody(id, text), onEscape: () => endEdit() });
  if (window.scrollY !== scrolled) window.scrollTo(0, scrolled);
  editing = { id, editor };
  editor.focusAt(at.x, at.y);
  if (!switching) pushEntry({ editing: true });
  editListeners.forEach(fn => fn(id));
}

/** Ends editing; `fromHistory` when the back key already left its entry. */
export function endEdit({ fromHistory = false, keepEntry = false } = {}) {
  if (!editing) return;
  if (!fromHistory && !keepEntry) leaveEntry("editing");
  const { id, editor } = editing;
  const text = editor.text();
  editor.destroy();
  editing = null;
  state.editingId = null;
  const wasNew = state.topId === id;
  if (wasNew) state.topId = null;
  editListeners.forEach(fn => fn(null));
  if (/^\s*(#+\s*)?$/.test(text)) {
    // An empty note is not kept (nor trashed): a fresh one silently, an emptied one with undo.
    const undo = purgeNotes([id]);
    if (!wasNew) showSnackbar("Empty note deleted", undo);
    return;
  }
  setBody(id, text.trim());
  const el = list().querySelector(`.note[data-id="${id}"]`);
  if (el) el.replaceWith(noteElement(note(id)));
}

window.addEventListener("popstate", () => {
  if (editing && !history.state?.editing) endEdit({ fromHistory: true });
});

// A click outside the edited note ends the edit before the click's own
// handler runs; the clicked note is kept where it was on screen. A press
// that started inside the note is no such click: a text selection dragged
// out of the note fires its click on a common ancestor outside it.
let pressedInside = false;
const keepsEditing = target => !!target.closest?.(`.note[data-id="${editing.id}"], .keep-editing`);
document.addEventListener("pointerdown", e => { pressedInside = !!editing && keepsEditing(e.target); }, true);
document.addEventListener("click", e => {
  const fromInside = pressedInside;
  pressedInside = false;
  if (!editing || fromInside || keepsEditing(e.target)) return;
  const other = e.target.closest(".note");
  const top = other && other.getBoundingClientRect().top;
  endEdit();
  if (other && other.isConnected) window.scrollBy(0, other.getBoundingClientRect().top - top);
}, true);

function toggleStatus(id) {
  const n = note(id);
  if (!n) return;
  if (state.editingId === id) endEdit();
  const closing = n.status === "open";
  const el = list().querySelector(`.note[data-id="${id}"]`);
  const apply = () => {
    const undo = setStatus(id, closing ? "closed" : "open");
    showSnackbar(closing ? "Note archived" : "Note reopened", undo);
  };
  if (!el) return apply();
  el.classList.toggle("closed", closing);
  // A short beat so the check is visible before the note leaves the view.
  setTimeout(apply, 280);
}

export function flashNote(id) {
  const el = list().querySelector(`.note[data-id="${id}"]`);
  if (!el) return;
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}
