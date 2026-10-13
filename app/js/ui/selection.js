// Multi-select: a long-press on a note (or Ctrl+click) starts it, taps add
// or remove notes, Shift+click selects a range. The selection bar acts on the
// selected notes; Copy and Merge first confirm the order in a dialog where it
// can be changed by drag and drop. Ends with ✕, Esc, the back button, an
// empty selection or an action that removes the notes from view.
import { selectedInOrder, rangeIds, copyText, mergedNote, previewLine } from "../core/selection.js";
import { state, note, removeNotes, setStatuses, mergeNotes } from "../store.js";
import { endEdit } from "./note-list.js";
import { showSnackbar } from "./snackbar.js";
import { openShareDialog } from "./share-dialog.js";
import { icon } from "./icons.js";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;

const $ = id => document.getElementById(id);
const list = () => $("list");
let opts = null;      // { viewNotes, onMerged }
let anchor = null;    // last note toggled, start of a Shift range
let press = null;     // { id, x, y, timer } while a finger / button is down
let swallowClick = false;
let dialog = null;    // { onConfirm } while the order dialog is open
let active = false;

export const isSelecting = () => active;

export function initSelection(options) {
  opts = options;
  $("selCancel").innerHTML = icon("close");
  $("selCancel").addEventListener("click", () => endSelection());
  $("orderCancel").addEventListener("click", closeDialog);
  $("orderOk").addEventListener("click", () => { const fn = dialog.onConfirm; closeDialog(); fn(orderedFromDialog()); });
  $("orderDialog").addEventListener("click", e => { if (e.target === $("orderDialog")) closeDialog(); });

  const l = list();
  l.addEventListener("pointerdown", onPointerDown);
  l.addEventListener("pointermove", e => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) l.addEventListener(type, cancelPress);
  // No native callout / context menu on a held note (Android, iOS).
  l.addEventListener("contextmenu", e => { if (press || isSelecting() || swallowClick) e.preventDefault(); });
  // Shift+click must not extend the text selection.
  l.addEventListener("mousedown", e => { if (e.shiftKey && e.target.closest(".note:not(.editing)")) e.preventDefault(); });
  // Capture phase on window: runs before the note's own handlers (edit,
  // task toggle, close button) and before note-list's end-edit listener.
  window.addEventListener("click", onClick, true);

  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (dialog) closeDialog();
    else if (isSelecting()) endSelection();
  });
  // Android back: the selection (and the dialog) sit on a history entry.
  window.addEventListener("popstate", () => {
    if (!isSelecting()) return;
    if (dialog) { closeDialog(); history.pushState({ selecting: true }, ""); return; }
    endSelection({ fromHistory: true });
  });
}

function onPointerDown(e) {
  swallowClick = false;
  if (e.button !== 0 || isSelecting() || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const el = e.target.closest(".note");
  if (!el || el.dataset.id === state.editingId) return; // long-press in the editor selects text
  press = { id: el.dataset.id, x: e.clientX, y: e.clientY, timer: setTimeout(onHold, HOLD_MS) };
}

function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
}

function onHold() {
  const { id } = press;
  press = null;
  swallowClick = true; // the click that follows the release
  try { navigator.vibrate?.(15); } catch { /* not allowed */ }
  window.getSelection()?.removeAllRanges();
  toggle(id);
}

function onClick(e) {
  const el = e.target.closest("#list .note");
  if (swallowClick) {
    swallowClick = false;
    if (el) { e.preventDefault(); e.stopPropagation(); }
    return;
  }
  if (!el || el.dataset.id === state.editingId) return;
  const id = el.dataset.id;
  if (e.shiftKey) selectRange(id);
  else if (e.ctrlKey || e.metaKey || isSelecting()) toggle(id);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function toggle(id) {
  if (!isSelecting()) begin();
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  anchor = id;
  if (state.selected.size === 0) endSelection();
  else update();
}

function selectRange(id) {
  if (!isSelecting()) begin();
  const order = [...list().querySelectorAll(".note")].map(el => el.dataset.id);
  for (const x of rangeIds(order, anchor, id)) state.selected.add(x);
  anchor = id;
  update();
}

function begin() {
  if (state.editingId) endEdit();
  active = true;
  history.pushState({ selecting: true }, "");
}

/** Ends multi-select; `fromHistory` when the back button already left the entry. */
export function endSelection({ fromHistory = false } = {}) {
  if (!active) return;
  active = false;
  closeDialog();
  state.selected.clear();
  anchor = null;
  update();
  if (!fromHistory && history.state && history.state.selecting) history.back();
}

/** After a render: forget selected notes that are no longer in view. */
export function syncSelection(visible) {
  if (!isSelecting()) return;
  const ids = new Set(visible.map(n => n.id));
  for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
  if (state.selected.size === 0) endSelection();
  else update();
}

// Marks the selected notes and fills the bar with the view's actions.
function update() {
  const n = state.selected.size;
  $("app").classList.toggle("selecting", n > 0);
  $("selectBar").hidden = n === 0;
  for (const el of list().querySelectorAll(".note")) el.classList.toggle("selected", state.selected.has(el.dataset.id));
  if (n === 0) return;
  $("selCount").textContent = `${n} selected`;
  const archive = state.view === "closed";
  const actions = [
    archive ? { id: "reopen", label: "Reopen", run: reopen } : { id: "done", label: "Close", run: close },
    { id: "copy", label: "Copy", run: copy },
    !archive && state.sync.simulated && { id: "share", label: "Share", run: share },   // real sharing: milestone 2
    !archive && { id: "merge", label: "Merge", run: merge, disabled: n < 2 },
    { id: "trash", label: "Delete", run: remove },
  ].filter(Boolean);
  $("selActions").replaceChildren(...actions.map(a => {
    const b = document.createElement("button");
    b.className = "sel-action";
    b.dataset.action = a.id;
    b.disabled = !!a.disabled;
    b.setAttribute("aria-label", a.label);
    b.innerHTML = icon(a.id) + `<span class="sel-label">${a.label}</span>`;
    b.addEventListener("click", a.run);
    return b;
  }));
}

const selectedNotes = () => selectedInOrder(opts.viewNotes(), [...state.selected]);
const count = (n, word) => n === 1 ? `Note ${word}` : `${n} notes ${word}`;

function close() {
  const ids = [...state.selected];
  endSelection();
  showSnackbar(count(ids.length, "archived"), setStatuses(ids, "closed"));
}

function reopen() {
  const ids = [...state.selected];
  endSelection();
  showSnackbar(count(ids.length, "reopened"), setStatuses(ids, "open"));
}

// The selection ends first; its history entry is
// gone before the dialog takes its own (the back key would close the dialog otherwise).
function share() {
  const ids = [...state.selected];
  const onEntry = history.state && history.state.selecting;
  endSelection();
  if (!onEntry) return openShareDialog(ids);
  let opened = false;
  const open = () => { if (!opened) { opened = true; openShareDialog(ids); } };
  window.addEventListener("popstate", open, { once: true });
  setTimeout(open, 300);
}

function remove() {
  const ids = [...state.selected];
  endSelection();
  showSnackbar(count(ids.length, "deleted"), removeNotes(ids));
}

function copy() {
  const notes = selectedNotes();
  const done = async ordered => {
    const ok = await writeClipboard(copyText(ordered));
    showSnackbar(ok ? (ordered.length === 1 ? "Note copied" : `${ordered.length} notes copied`) : "Copying isn't allowed here");
  };
  if (notes.length === 1) done(notes);
  else openDialog(`Copy ${notes.length} notes`, "Copy", notes, done);
}

function merge() {
  openDialog(`Merge ${state.selected.size} notes`, "Merge", selectedNotes(), ordered => {
    endSelection();
    const { note: merged, undo } = mergeNotes(ordered.map(n => n.id), mergedNote(ordered));
    opts.onMerged(merged, undo);
  });
}

async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* insecure context: fall back */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.className = "visually-hidden";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* unsupported */ }
  ta.remove();
  return ok;
}

// ---------- order dialog ----------

function openDialog(title, okLabel, notes, onConfirm) {
  dialog = { onConfirm };
  $("orderTitle").textContent = title;
  $("orderOk").textContent = okLabel;
  $("orderList").replaceChildren(...notes.map(orderItem));
  $("orderDialog").hidden = false;
  $("orderOk").focus({ preventScroll: true });
}

function closeDialog() {
  if (!dialog) return;
  dialog = null;
  $("orderDialog").hidden = true;
}

function orderedFromDialog() {
  return [...$("orderList").children].map(li => note(li.dataset.id)).filter(Boolean);
}

function orderItem(n) {
  const li = document.createElement("li");
  li.className = "order-item";
  li.dataset.id = n.id;
  const { text, fromHeading } = previewLine(n);
  const label = document.createElement("span");
  label.className = "order-text" + (fromHeading ? "" : " plain");
  label.textContent = text;
  const grip = document.createElement("button");
  grip.className = "order-grip";
  grip.setAttribute("aria-label", "Move (drag, or arrow keys)");
  grip.innerHTML = icon("grip");
  grip.addEventListener("pointerdown", e => startDrag(e, li));
  grip.addEventListener("keydown", e => {
    if (e.key === "ArrowUp" && li.previousElementSibling) li.previousElementSibling.before(li);
    else if (e.key === "ArrowDown" && li.nextElementSibling) li.nextElementSibling.after(li);
    else return;
    e.preventDefault();
    grip.focus();
  });
  li.append(label, grip);
  return li;
}

// Drag by the grip: the row follows the pointer and the others make room.
function startDrag(e, li) {
  e.preventDefault();
  const grip = e.currentTarget;
  grip.setPointerCapture(e.pointerId);
  li.classList.add("dragging");
  let lastY = e.clientY;
  let offset = 0;
  const move = ev => {
    offset += ev.clientY - lastY;
    lastY = ev.clientY;
    const prev = li.previousElementSibling;
    const next = li.nextElementSibling;
    if (prev && offset < -prev.offsetHeight / 2) { offset += prev.offsetHeight; prev.before(li); }
    else if (next && offset > next.offsetHeight / 2) { offset -= next.offsetHeight; next.after(li); }
    li.style.transform = `translateY(${offset}px)`;
  };
  const up = () => {
    li.classList.remove("dragging");
    li.style.transform = "";
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", up);
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
}
