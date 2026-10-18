// The note list: renders the notes of the current view, edits a note in
// place (editor.js), toggles task checkboxes and the note's own open/closed
// state. A permanent note has a mark instead of the round button; a trashed
// note is read-only; a tap selects it (ui/selection.js).
// A finished edit or a task toggle patches only that note, so the list
// never reorders under the user's finger; the order is recomputed on the
// next structural change (view, sort, search, new / closed note) and when
// a new due date sorts its note in (reorderList). News posts are read-only
// cards: no editing, no due date, a label while they are new or updated.
import { renderMarkdown, toggleTask, setTaskState, sections, noteTitle } from "../core/markdown.js";
import { setRating } from "../core/rating.js";
import { changeCounter } from "../core/counter.js";
import { counterClick, fillWatches } from "./counter.js";
import { holdForStates, boxState } from "./task-menu.js";
import { openTaskDueMenu, fillTaskDue } from "./due-menu.js";
import { taskDue, setTaskDue } from "../core/task-due.js";
import { progressBadge } from "./toc.js";
import { sectionProgress } from "../core/tasks.js";
import { sectionKey } from "../core/query.js";
import { state, setUi, note, setBody, setStatus, purgeNotes, circleOf, markNewsSeen, copyOriginal } from "../store.js";
import { trashMarkerHtml } from "./trash.js";
import { relativeTime, dueLabel, shortDate } from "./format.js";
import { localTime } from "../core/notes-file.js";
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
import { copyState } from "../core/note-links.js";
import { applyNoteLinks, followNoteLink, linkPicker } from "./note-links.js";
import { openCompare } from "./compare.js";
import { refOf } from "../core/note-ref.js";

const list = () => document.getElementById("list");
const localDay = ts => localTime(ts).slice(0, 10);

/** Renders the tiles; `pile` heads My order's pile (backlog #24), see listItems. */
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

/** The tiles' elements without placing them (also the swipe's preview of the other view).
 *  `pile` ({ has(id), top, count, level, oldest, collapsed } or null) puts My order's pile
 *  header above its notes, which come first — after `top`, a new note kept on top — and
 *  folds them; with an empty pile the header stands alone so Tidy up… stays at hand.
 *  `sectionOf(note)` gives a section ({ id, title, count, collapsed }) or null: a header
 *  heads each section's notes, a folded one hides them (backlog #24). */
export function listItems(notes, { pile = null, onArrange, onTogglePile, sectionOf = () => null, onToggleSection, view = state.view } = {}) {
  let current = null, piled = !pile;
  const items = [];
  const putPile = () => { if (!piled) items.push(pileHeader(pile, onTogglePile, onArrange)); piled = true; };
  for (const n of notes) {
    const id = refOf(n);
    if (pile?.has(id)) {
      putPile();
      if (!pile.collapsed) items.push(noteElement(n, view));
      continue;
    }
    if (id !== pile?.top) putPile();
    const s = sectionOf(n);
    if (s && s.id !== current) items.push(sectionHeader(s, onToggleSection));
    current = s?.id ?? null;
    if (!s?.collapsed) items.push(noteElement(n, view));
  }
  if (notes.length) putPile();
  return items;
}

/** A section's header in My order (also in the contents): a tap folds or unfolds it. */
export function sectionHeader({ id, title, count, collapsed }, onToggle) {
  const b = document.createElement("button");
  b.className = "section-header" + (collapsed ? " collapsed" : "");
  b.dataset.section = id;
  b.setAttribute("aria-expanded", String(!collapsed));
  b.innerHTML = `${icon("down")}<span class="section-title"></span><span class="section-count"></span>`;
  b.querySelector(".section-title").textContent = title;
  b.querySelector(".section-count").textContent = collapsed ? notesCount(count) : String(count);
  if (onToggle) b.addEventListener("click", () => onToggle(id));
  return b;
}

const notesCount = count => count === 1 ? "1 note" : `${count} notes`;
const LEVEL_TEXT = { calm: "calm", growing: "growing", tidy: "time to tidy up" };

/** My order's pile header (also in the contents): a tap on it folds or unfolds the pile,
 *  its gauge shows the tidy-up reminder's level (core/tidy.js; none when it is off),
 *  Tidy up… opens the arrange dialog. */
export function pileHeader({ count, level, oldest, collapsed }, onToggle, onArrange) {
  const el = document.createElement("div");
  el.className = "pile-header" + (level ? " level-" + level : "") + (count ? "" : " empty") + (collapsed ? " collapsed" : "");
  if (count) {
    const b = document.createElement("button");
    b.className = "pile-toggle";
    b.setAttribute("aria-expanded", String(!collapsed));
    const gauge = level ? `<span class="pile-gauge" role="img" aria-label="Tidy-up reminder: ${LEVEL_TEXT[level]}"><i></i><i></i><i></i></span>` : "";
    const status = level === "tidy" ? "Time to tidy up" : level === "growing" && oldest ? `oldest ${shortDate(localDay(oldest))}` : "";
    b.innerHTML = `${icon("down")}<span class="pile-title">Pile</span><span class="pile-count">${collapsed ? notesCount(count) : count}</span>${gauge}`
      + (status ? `<span class="pile-status">${status}</span>` : "");
    if (onToggle) b.addEventListener("click", onToggle);
    el.append(b);
  } else {
    el.insertAdjacentHTML("beforeend", `<span class="pile-done">${icon("check")}Pile empty</span>`);
  }
  const link = Object.assign(document.createElement("button"), { className: "link-btn", textContent: "Tidy up…" });
  if (onArrange) link.addEventListener("click", onArrange);
  el.append(link);
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

// A tap on a permanent note's mark filters the list to the permanent notes.
document.addEventListener("click", e => {
  const hit = e.target.closest("#list button.permanent-mark");
  if (!hit || state.selected.size) return;
  if (state.editingId) endEdit();
  setUi({ permanent: true, topId: null });
  window.scrollTo(0, 0);
});

// A tap on a private copy's chip compares it with its original (ui/compare.js).
document.addEventListener("click", e => {
  const hit = e.target.closest("#list button.copy-chip");
  if (!hit) return;
  const id = hit.closest(".note").dataset.id;
  if (state.editingId && state.editingId !== id) endEdit();
  openCompare(id);
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
  if (state.editingId === id) { el.querySelector(".note-meta").innerHTML = metaHtml(n); applyLook(el, n); }
  else el.replaceWith(noteElement(n));
}

// A note's color and motif (core/look.js) as attributes the styles pick up (app.css → "Note colors and motifs").
function applyLook(el, n) {
  if (n.color) el.dataset.color = n.color; else delete el.dataset.color;
  if (n.decor) el.dataset.decor = n.decor; else delete el.dataset.decor;
}

function noteElement(n, view = state.view) {
  const el = document.createElement("article");
  el.className = "note" + (n.status === "closed" ? " closed" : "") + (n.status === "permanent" ? " permanent" : "")
    + (n.deleted ? " trashed" : "") + (n.news ? " news" : "") + (n.fresh ? " fresh" : "");
  el.dataset.id = refOf(n);
  applyLook(el, n);

  // The round button closes or reopens; a permanent note has its mark there instead (a tap
  // shows the permanent notes only), a trashed note neither.
  const status = document.createElement("button");
  if (n.status === "permanent") {
    status.className = "permanent-mark";
    status.setAttribute("aria-label", "Permanent note · show permanent notes only");
    status.title = "Permanent · can't be closed. Tap to show permanent notes only";
    status.innerHTML = icon("permanent");
  } else {
    status.className = "status";
    status.setAttribute("aria-label", n.status === "closed" ? (n.news ? "Reopen post" : "Reopen note") : n.news ? "Archive post" : "Close note");
    status.innerHTML = `<span class="ring">${icon("check")}</span>`;
    status.addEventListener("click", () => toggleStatus(refOf(n)));
  }

  const body = document.createElement("div");
  body.className = "note-body md";
  body.innerHTML = renderMarkdown(n.body);
  applyExternal(body, circleKey(circleOf(refOf(n))));
  applyNoteLinks(body);
  fillWatches(body);
  wrapSections(body, sections(n.body));
  markHits(body);
  if (state.settings.tocProgress) addProgress(body, n.body);
  const readOnly = n.status === "closed" || n.news || n.deleted;
  fillTaskDues(body, readOnly);
  if (readOnly) body.querySelectorAll("input.task, .counter, .rating .star").forEach(cb => (cb.disabled = true));
  else body.querySelectorAll("input.task").forEach((cb, index) => holdForStates(cb, s => setBody(refOf(n), setTaskState(note(refOf(n)).body, index, s))));
  body.addEventListener("click", e => onBodyClick(e, refOf(n)));

  const meta = document.createElement("div");
  meta.className = "note-meta";
  meta.innerHTML = metaHtml(n, view);

  el.append(body, meta, ...(n.deleted ? [] : [status]));
  markSelected(el);
  return el;
}

// The task progress at each heading whose section has tasks (the switch in the
// contents, ui/toc.js); text before the first heading shows it in the meta line.
function addProgress(body, md) {
  sectionProgress(md).forEach((p, i) => {
    const h = p && body.querySelector(`.md-section[data-section="${i}"] > :is(h1, h2, h3, h4, h5, h6):first-child`);
    if (h) h.append(" ", progressBadge(p));
  });
}

function leadProgress(n) {
  if (!state.settings.tocProgress) return "";
  const p = sections(n.body)[0].depth === null && sectionProgress(n.body)[0];
  if (!p) return "";
  const badge = progressBadge(p);
  badge.classList.add("chip");
  return badge.outerHTML;
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
  const members = circleOf(refOf(n));
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

// A private copy of a shared note (backlog #45): "Copy of …", marked while its original changed since; a tap
// compares the two. Once the user no longer sees the original, it only says so.
function copyChipHtml(n) {
  const o = copyOriginal(refOf(n));
  if (!o) return `<span class="chip copy-chip gone">${icon("privatecopy")}Copy · original not available</span>`;
  const changed = copyState(n, o) === "changed";
  const title = esc(noteTitle(o.body).text || "Untitled");
  return `<button type="button" class="chip copy-chip${changed ? " changed" : ""}" aria-label="${esc("Private copy of " + (noteTitle(o.body).text || "Untitled") + (changed ? ", the original changed" : "") + ", compare")}">`
    + `${icon("privatecopy")}<span class="copy-of">Copy of ${title}</span>${changed ? '<span class="copy-changed">Original changed</span>' : ""}</button>`;
}

function metaHtml(n, view = state.view) {
  if (n.news) return newsMetaHtml(n);
  const parts = [markerHtml(n)].filter(Boolean);
  // Archived done tasks name the note they came from (Clear done tasks).
  const source = n.from && note(n.from);
  if (source) parts.push(`<span class="chip from-chip">From ${esc(noteTitle(source.body).text || "Untitled")}</span>`);
  if (n.copyof) parts.push(copyChipHtml(n));
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
  parts.push(leadProgress(n));
  const key = state.settings.sort[view].key;
  const field = n.deleted && view === "trash" ? "deleted" : { created: "created", closed: "closed" }[key] || "modified";
  const label = { created: "Created", closed: "Closed", deleted: "Deleted", modified: "Edited" }[field];
  if (n[field]) parts.push(`<span>${label} ${relativeTime(n[field])}</span>`);
  return parts.join("");
}

// Task due dates (backlog #41): each chip belongs to the task whose box opens its list item.
const ownBox = chip => chip.closest("li")?.querySelector("input.task");
const taskIndexOf = (chip, body) => [...body.querySelectorAll("input.task")].indexOf(ownBox(chip));
function fillTaskDues(body, readOnly) {
  for (const chip of body.querySelectorAll("button.task-due")) {
    const box = ownBox(chip);
    const state = box ? boxState(box) : "open";
    fillTaskDue(chip, { plain: readOnly || state === "done" || state === "cancelled", readOnly });
  }
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
  const link = e.target.closest("a.note-link");
  if (link) { e.preventDefault(); return followNoteLink(link); }
  const counter = e.target.closest(".counter");
  const index = counter && [...e.currentTarget.querySelectorAll(".counter")].indexOf(counter);
  if (counterClick(e, change => setBody(id, changeCounter(note(id).body, index, change)))) return;
  const star = e.target.closest(".rating .star");
  if (star) {
    if (n.status === "closed" || n.deleted || star.closest(".app.selecting")) return;
    const index = [...e.currentTarget.querySelectorAll(".rating")].indexOf(star.closest(".rating"));
    setBody(id, setRating(n.body, index, Number(star.dataset.star)));
    return;
  }
  const chip = e.target.closest("button.task-due");
  if (chip) {
    if (n.status === "closed" || n.deleted || chip.closest(".app.selecting")) return;
    const index = taskIndexOf(chip, e.currentTarget);
    if (index >= 0) openTaskDueMenu(chip, taskDue(n.body, index), due => setBody(id, setTaskDue(note(id).body, index, due)));
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
  const editor = createEditor({ parent: host, doc: n.body, media, extensions: [linkPicker(id)], onChange: text => setBody(id, text), onEscape: () => endEdit() });
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

export function toggleStatus(id) {
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
