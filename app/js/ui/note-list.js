// The note list: renders the notes of the current view, edits a note in
// place (editor.js), toggles task checkboxes and the note's own open/closed
// state.
// A finished edit or a task toggle patches only that note, so the list
// never reorders under the user's finger; the order is recomputed on the
// next structural change (view, sort, search, new / closed note).
import { renderMarkdown, noteTitle, toggleTask, sections } from "../core/markdown.js";
import { sectionKey } from "../core/query.js";
import { state, note, setBody, setStatus, removeNote, circleOf } from "../store.js";
import { relativeTime, dueLabel, shortDate } from "./format.js";
import { icon } from "./icons.js";
import { showSnackbar } from "./snackbar.js";
import { createEditor } from "./editor.js";
import { membersLabel, avatarStackHtml, esc } from "./people.js";
import { openShareDialog } from "./share-dialog.js";

const list = () => document.getElementById("list");

export function renderList(notes) {
  list().replaceChildren(...notes.map(noteElement));
}

// A tap on the shared marker opens the share dialog.
// (While selecting, the selection's own click handler runs first and keeps the tap.)
document.addEventListener("click", e => {
  const hit = e.target.closest("#list button.shared-mark");
  if (!hit) return;
  const id = hit.closest(".note").dataset.id;
  if (state.editingId) endEdit();
  if (note(id)) openShareDialog([id]);
});

export function patchNote(id) {
  const el = list().querySelector(`.note[data-id="${id}"]`);
  const n = note(id);
  if (!el || !n) return;
  // The edited note keeps its editor; only its meta line follows.
  if (state.editingId === id) el.querySelector(".note-meta").innerHTML = metaHtml(n);
  else el.replaceWith(noteElement(n));
}

function noteElement(n) {
  const el = document.createElement("article");
  el.className = "note" + (n.status === "closed" ? " closed" : "");
  el.dataset.id = n.id;
  if (noteTitle(n.body).fromHeading && /^\s{0,3}#{1,3}\s/.test(n.body)) el.classList.add("lead-heading");

  const status = document.createElement("button");
  status.className = "status";
  status.setAttribute("aria-label", n.status === "closed" ? "Reopen note" : "Close note");
  status.innerHTML = `<span class="ring">${icon("check")}</span>`;
  status.addEventListener("click", () => toggleStatus(n.id));

  const body = document.createElement("div");
  body.className = "note-body md";
  body.innerHTML = renderMarkdown(n.body);
  wrapSections(body, sections(n.body));
  if (n.status === "closed") body.querySelectorAll("input.task").forEach(cb => (cb.disabled = true));
  body.addEventListener("click", e => onBodyClick(e, n.id));

  const meta = document.createElement("div");
  meta.className = "note-meta";
  meta.innerHTML = metaHtml(n);

  el.append(status, body, meta);
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
// note is open (opens the share dialog), plain info in the archive.
function markerHtml(n) {
  const members = circleOf(n.id);
  if (!members.length) return "";
  const attrs = `class="shared-mark" aria-label="${esc("Shared with " + membersLabel(members))}"`;
  const inner = avatarStackHtml(members);
  return n.status === "open" ? `<button type="button" ${attrs}>${inner}</button>` : `<span role="img" ${attrs}>${inner}</span>`;
}

function metaHtml(n) {
  const parts = [markerHtml(n)].filter(Boolean);
  if (n.due) {
    // A closed note's due date is history, not a warning.
    const d = n.status === "closed" ? { text: "Due " + shortDate(n.due), kind: "future" } : dueLabel(n.due);
    parts.push(`<span class="chip ${d.kind}">${icon("calendar")}${d.text}</span>`);
  }
  const key = state.settings.sort[state.view].key;
  const field = { created: "created", closed: "closed" }[key] || "modified";
  const label = { created: "Created", closed: "Closed", modified: "Edited" }[field];
  if (n[field]) parts.push(`<span>${label} ${relativeTime(n[field])}</span>`);
  return parts.join("");
}

function onBodyClick(e, id) {
  const n = note(id);
  if (!n || state.editingId === id) return;
  const cb = e.target.closest("input.task");
  if (cb) {
    e.preventDefault();
    if (n.status === "closed") return;
    const index = [...e.currentTarget.querySelectorAll("input.task")].indexOf(cb);
    setBody(id, toggleTask(n.body, index));
    return;
  }
  if (e.target.closest("a")) return;
  if (n.status === "closed") return; // closed notes are read-only
  startEdit(id, { x: e.clientX, y: e.clientY });
}

// ---------- editing ----------
// One note at a time is edited in place with the live-preview editor. The
// text is saved on every change; editing ends with Done, Esc, or a tap /
// click anywhere outside the note and its toolbar.

let editing = null; // { id, editor }
const editListeners = new Set();
export function onEditingChange(fn) { editListeners.add(fn); }
export function currentEditor() { return editing && editing.editor; }

/** Starts editing; `at` = { x, y } of the tap puts the caret there. */
export function startEdit(id, at = {}) {
  if (editing) endEdit();
  const el = list().querySelector(`.note[data-id="${id}"]`);
  const n = note(id);
  if (!el || !n) return;
  state.editingId = id;
  el.classList.add("editing");
  const host = document.createElement("div");
  host.className = "note-body md editor-host";
  el.querySelector(".note-body").replaceWith(host);
  const editor = createEditor({ parent: host, doc: n.body, onChange: text => setBody(id, text), onEscape: () => endEdit() });
  editing = { id, editor };
  editor.focusAt(at.x, at.y);
  editListeners.forEach(fn => fn(id));
}

export function endEdit() {
  if (!editing) return;
  const { id, editor } = editing;
  const text = editor.text();
  editor.destroy();
  editing = null;
  state.editingId = null;
  const wasPinned = state.pinnedId === id;
  if (wasPinned) state.pinnedId = null;
  editListeners.forEach(fn => fn(null));
  if (/^\s*(#+\s*)?$/.test(text)) {
    // An empty note is not kept: a fresh one silently, an emptied one with undo.
    const undo = removeNote(id);
    if (!wasPinned) showSnackbar("Empty note deleted", undo);
    return;
  }
  setBody(id, text.trim());
  const el = list().querySelector(`.note[data-id="${id}"]`);
  if (el) el.replaceWith(noteElement(note(id)));
}

// A click outside the edited note ends the edit before the click's own
// handler runs; the clicked note is kept where it was on screen.
document.addEventListener("click", e => {
  if (!editing || e.target.closest(`.note[data-id="${editing.id}"], .keep-editing`)) return;
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
