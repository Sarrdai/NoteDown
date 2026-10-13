// The note list: renders the notes of the current view, edits a note in
// place, toggles task checkboxes and the note's own open/closed state.
// A finished edit or a task toggle patches only that note, so the list
// never reorders under the user's finger; the order is recomputed on the
// next structural change (view, sort, search, new / closed note).
import { renderMarkdown, noteTitle, toggleTask } from "../core/markdown.js";
import { state, note, setBody, setStatus, removeNote } from "../store.js";
import { relativeTime, dueLabel, shortDate } from "./format.js";
import { icon } from "./icons.js";
import { showSnackbar } from "./snackbar.js";

const list = () => document.getElementById("list");

export function renderList(notes) {
  list().replaceChildren(...notes.map(noteElement));
}

export function patchNote(id) {
  const el = list().querySelector(`.note[data-id="${id}"]`);
  const n = note(id);
  if (!el || !n || state.editingId === id) return;
  el.replaceWith(noteElement(n));
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
  if (n.status === "closed") body.querySelectorAll("input.task").forEach(cb => (cb.disabled = true));
  body.addEventListener("click", e => onBodyClick(e, n.id));

  const meta = document.createElement("div");
  meta.className = "note-meta";
  meta.innerHTML = metaHtml(n);

  el.append(status, body, meta);
  return el;
}

function metaHtml(n) {
  const parts = [];
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
  startEdit(id);
}

/** Replaces the note's rendered body with a raw editor (round 1). */
export function startEdit(id, { caretAtEnd = true } = {}) {
  const el = list().querySelector(`.note[data-id="${id}"]`);
  const n = note(id);
  if (!el || !n) return;
  state.editingId = id;
  el.classList.add("editing");
  const ta = document.createElement("textarea");
  ta.className = "editor";
  ta.value = n.body;
  ta.spellcheck = true;
  ta.setAttribute("aria-label", "Note text");
  const autosize = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  ta.addEventListener("input", autosize);
  ta.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); ta.blur(); } });
  ta.addEventListener("blur", () => endEdit(id, ta.value));

  const actions = document.createElement("div");
  actions.className = "edit-actions";
  actions.innerHTML = "<button type=button>Done</button>";
  // mousedown keeps focus in the editor until the click ends the edit.
  actions.firstChild.addEventListener("mousedown", e => e.preventDefault());
  actions.firstChild.addEventListener("click", () => ta.blur());

  el.querySelector(".note-body").replaceWith(ta);
  el.querySelector(".note-meta").after(actions);
  ta.focus({ preventScroll: true });
  if (caretAtEnd) ta.setSelectionRange(ta.value.length, ta.value.length);
  autosize();
}

function endEdit(id, text) {
  if (state.editingId !== id) return;
  state.editingId = null;
  const wasPinned = state.pinnedId === id;
  if (wasPinned) state.pinnedId = null;
  if (/^\s*(#+\s*)?$/.test(text)) {
    // An empty note is not kept: a fresh one silently, an emptied one with undo.
    const undo = removeNote(id);
    if (!wasPinned) showSnackbar("Empty note deleted", undo);
    return;
  }
  setBody(id, text.trim());
  patchNote(id);
}

function toggleStatus(id) {
  const n = note(id);
  if (!n) return;
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
