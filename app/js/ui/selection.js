// Multi-select over the note list and the table of contents: one selection
// of sections (core/selection.js). A long-press on a note (or Ctrl+click)
// selects it whole, a long-press on a contents entry selects that section
// with everything below it; then taps add or remove in either place, and
// Shift+click selects a range. The selection bar acts on the selection;
// Copy and Merge first confirm the order in a dialog where it can be
// changed by drag and drop. Ends with ✕, Esc, the back button, an empty
// selection or an action that removes the notes from view. Delete asks
// first (ui/confirm.js) and leaves protected notes alone.
import { tableOfContents, deleteGroups } from "../core/query.js";
import {
  rangeIds, toggleEntry, selectEntryRange, toggleNote, selectNotes, selectedParts, partText, partPreview,
  copyText, mergeParts, hasHeadings, canShiftHeadings, shiftHeadings,
} from "../core/selection.js";
import { state, note, removeNotes, setStatuses, setBody, applyMerge, isProtected, setProtected, circleOf } from "../store.js";
import { mergeCircle } from "../core/sharing.js";
import { membersLabel, avatarStackHtml, esc } from "./people.js";
import { endEdit, markSelected } from "./note-list.js";
import { showSnackbar } from "./snackbar.js";
import { openShareDialog } from "./share-dialog.js";
import { openMenu } from "./menu.js";
import { openConfirm, isConfirmOpen } from "./confirm.js";
import { icon } from "./icons.js";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;

const $ = id => document.getElementById(id);
const list = () => $("list");
let opts = null;      // { viewNotes, onMerged, onChange }
let anchorNote = null; // last note toggled, start of a Shift range in the list
let anchorKey = null;  // same for the contents
let press = null;     // { id, x, y, timer } while a finger / button is down
let swallowClick = false;
let dialog = null;    // { onConfirm } while the order dialog is open
let active = false;

export const isSelecting = () => active;
const entries = () => tableOfContents(opts.viewNotes()).entries;

export function initSelection(options) {
  opts = options;
  $("selCancel").innerHTML = icon("close");
  $("selCancel").addEventListener("click", () => endSelection());
  $("selMore").innerHTML = icon("more");
  $("orderCancel").addEventListener("click", closeDialog);
  $("orderOk").addEventListener("click", () => {
    const fn = dialog.onConfirm, ordered = orderedFromDialog();
    const mode = $("orderChoice").querySelector("input:checked")?.value || "copy";
    closeDialog();
    fn(ordered, mode);
  });
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
    if (e.key !== "Escape" || isConfirmOpen()) return;
    if (dialog) closeDialog();
    else if (isSelecting()) endSelection();
  });
  // Android back: the selection (and the dialog) sit on a history entry;
  // back from the delete confirmation (its own entry) lands on it again.
  window.addEventListener("popstate", () => {
    if (!isSelecting() || (history.state && history.state.selecting)) return;
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

// A card toggles its whole note (a partly selected one becomes whole).
function toggle(id) {
  if (!isSelecting()) begin();
  state.selected = toggleNote(entries(), state.selected, id);
  anchorNote = id;
  changed();
}

function selectRange(id) {
  if (!isSelecting()) begin();
  const order = [...list().querySelectorAll(".note")].map(el => el.dataset.id);
  state.selected = selectNotes(entries(), state.selected, rangeIds(order, anchorNote, id));
  anchorNote = id;
  changed();
}

/** Contents entry: toggles the section with what is below it (ui/toc.js). */
export function toggleSection(key) {
  const all = entries();
  const i = all.findIndex(e => e.key === key);
  if (i < 0) return;
  if (!isSelecting()) begin();
  state.selected = toggleEntry(all, state.selected, i);
  anchorKey = key;
  changed();
}

/** Contents entry with Shift: from the last toggled entry to this one. */
export function selectSectionRange(key) {
  const all = entries();
  const i = all.findIndex(e => e.key === key);
  const a = all.findIndex(e => e.key === anchorKey);
  if (i < 0) return;
  if (!isSelecting()) begin();
  state.selected = selectEntryRange(all, state.selected, a < 0 ? i : a, i);
  anchorKey = key;
  changed();
}

function changed() {
  if (state.selected.size === 0) endSelection();
  else update();
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
  anchorNote = anchorKey = null;
  update();
  if (!fromHistory && history.state && history.state.selecting) history.back();
}

/** After a render: forget selected sections that are no longer in view. */
export function syncSelection(visible) {
  if (!isSelecting()) return;
  const keys = new Set(tableOfContents(visible).entries.map(e => e.key));
  for (const k of state.selected) if (!keys.has(k)) state.selected.delete(k);
  if (state.selected.size === 0) endSelection();
  else update();
}

// The selection as parts with their notes.
function current() {
  const parts = selectedParts(entries(), state.selected);
  const notes = Object.fromEntries(parts.map(p => [p.noteId, note(p.noteId)]));
  const byNote = Object.keys(notes).map(id => [notes[id], parts.filter(p => p.noteId === id)]);
  return { parts, notes, byNote, whole: parts.every(p => p.whole) };
}

// Marks the selection and fills the bar with the view's actions.
function update() {
  const on = state.selected.size > 0;
  $("app").classList.toggle("selecting", on);
  $("selectBar").hidden = !on;
  for (const el of list().querySelectorAll(".note")) markSelected(el);
  opts.onChange();
  if (!on) return;
  const { parts, byNote, whole } = current();
  $("selCount").innerHTML = `${parts.length}<span class="sel-word"> selected</span>`;
  const archive = state.view === "closed";
  const canShift = delta => byNote.some(([n, ps]) => canShiftHeadings(n.body, ps, delta))
    && byNote.every(([n, ps]) => canShiftHeadings(n.body, ps, delta) || !hasHeadings(n.body, ps));
  // Close, Share, Protect and Delete act on whole notes; `menu` = under ⋮ on the phone.
  const ids = byNote.map(([n]) => n.id);
  const protect = ids.some(id => !isProtected(id));
  const actions = [
    archive ? { id: "reopen", label: "Reopen", run: reopen } : { id: "done", label: "Close", run: close, disabled: !whole },
    { id: "copy", label: "Copy", run: copy },
    !archive && state.sync.simulated && { id: "share", label: "Share", run: share, disabled: !whole, menu: true },   // real sharing: milestone 2
    !archive && { id: "merge", label: "Merge", run: merge, disabled: whole && parts.length < 2 },
    { id: protect ? "protect" : "unprotect", label: protect ? "Protect" : "Unprotect", run: () => protectNotes(protect), disabled: !whole, menu: !archive },
    { id: "trash", label: "Delete", run: remove, disabled: !whole || ids.every(isProtected) },
    !archive && { id: "outdent", label: "Promote headings", run: () => shift(-1), disabled: !canShift(-1), menu: true },
    !archive && { id: "indent", label: "Demote headings", run: () => shift(1), disabled: !canShift(1), menu: true },
  ].filter(Boolean);
  $("selActions").replaceChildren(...actions.map(a => {
    const b = document.createElement("button");
    b.className = "sel-action" + (a.menu ? " in-menu" : "");
    b.dataset.action = a.id;
    b.disabled = !!a.disabled;
    b.setAttribute("aria-label", a.label);
    b.title = a.label;
    b.innerHTML = icon(a.id) + `<span class="sel-label">${a.label}</span>`;
    b.addEventListener("click", a.run);
    return b;
  }));
  const more = actions.filter(a => a.menu);
  $("selMore").hidden = more.length === 0;
  $("selMore").onclick = () => openMenu($("selMore"), more.map(a => ({ label: a.label, disabled: a.disabled, onSelect: a.run })));
}

const noteIds = () => current().parts.map(p => p.noteId);
const count = (n, word) => n === 1 ? `Note ${word}` : `${n} notes ${word}`;

function close() {
  const ids = noteIds();
  endSelection();
  showSnackbar(count(ids.length, "archived"), setStatuses(ids, "closed"));
}

function reopen() {
  const ids = noteIds();
  endSelection();
  showSnackbar(count(ids.length, "reopened"), setStatuses(ids, "open"));
}

// The selection ends first; its history entry is
// gone before the dialog takes its own (the back key would close the dialog otherwise).
function share() {
  const ids = noteIds();
  const onEntry = history.state && history.state.selecting;
  endSelection();
  if (!onEntry) return openShareDialog(ids);
  let opened = false;
  const open = () => { if (!opened) { opened = true; openShareDialog(ids); } };
  window.addEventListener("popstate", open, { once: true });
  setTimeout(open, 300);
}

function protectNotes(on) {
  const ids = noteIds();
  endSelection();
  showSnackbar(count(ids.length, on ? "protected" : "unprotected"), setProtected(ids, on));
}

// Asks first; protected notes stay, shared ones go for everyone in their circle.
// Cancel keeps the selection.
function remove() {
  const g = deleteGroups(noteIds().map(note), { isProtected, isShared: id => circleOf(id).length > 0 });
  const ids = [...g.private, ...g.shared].map(n => n.id);
  const text = [
    ids.length === 1 ? "It is removed from all your devices." : "They are removed from all your devices.",
    g.shared.length && (g.shared.length === ids.length ? (ids.length === 1 ? "It is shared and is deleted for everyone." : "They are shared and are deleted for everyone.")
      : `${g.shared.length} of them ${g.shared.length === 1 ? "is" : "are"} shared and deleted for everyone.`),
    g.kept.length && (g.kept.length === 1 ? "1 protected note stays." : `${g.kept.length} protected notes stay.`),
  ].filter(Boolean).join(" ");
  openConfirm({
    title: ids.length === 1 ? "Delete note?" : `Delete ${ids.length} notes?`,
    text,
    okLabel: () => "Delete",
    onConfirm: () => {
      endSelection();
      showSnackbar(count(ids.length, "deleted"), removeNotes(ids));
    },
  });
}

// Headings of the selected parts one level up (-1) or down (+1); the selection stays.
function shift(delta) {
  for (const [n, ps] of current().byNote) setBody(n.id, shiftHeadings(n.body, ps, delta));
}

const what = (parts, whole) => `${parts.length} ${whole ? "notes" : "parts"}`;

function copy() {
  const { parts, notes, whole } = current();
  const done = async ordered => {
    const ok = await writeClipboard(copyText(ordered.map(p => partText(notes[p.noteId].body, p))));
    const label = ordered.length === 1 ? (whole ? "Note copied" : "Copied") : `${what(ordered, whole)} copied`;
    showSnackbar(ok ? label : "Copying isn't allowed here");
  };
  if (parts.length === 1) done(parts);
  else openDialog(`Copy ${what(parts, whole)}`, "Copy", parts, notes, done);
}

// Merge and "move to a new note" are one mechanism: the parts, in the
// confirmed order, become a new note and leave their notes. Across circles
// the dialog asks where it goes (core/sharing.js → mergeCircle): a private
// copy that leaves the shared notes as they are, or shared with everyone involved.
function merge() {
  const { parts, notes, whole } = current();
  const single = parts.length === 1;
  const circles = Object.keys(notes).map(circleOf);
  const across = mergeCircle(circles, "copy").keepShared;
  const choice = across ? mergeCircle(circles, "share").members : null;
  openDialog(single ? "Move to a new note" : `Merge ${what(parts, whole)}`, single ? "Move" : "Merge", parts, notes, (ordered, mode) => {
    endSelection();
    const m = mergeParts(notes, ordered);
    const { note: created, undo } = applyMerge(m.changes, m, mode);
    const message = across && mode === "copy" ? "Merged into a private note" : whole ? "Notes merged" : "Moved to a new note";
    opts.onMerged(created, undo, message);
  }, choice);
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

// `shareWith` (member ids) adds the choice between a private copy and
// sharing with these people; onConfirm gets the order and "copy" | "share".
function openDialog(title, okLabel, parts, notes, onConfirm, shareWith = null) {
  dialog = { onConfirm, parts };
  $("orderTitle").textContent = title;
  $("orderOk").textContent = okLabel;
  $("orderChoice").hidden = !shareWith;
  $("orderChoice").innerHTML = shareWith ? choiceHtml("copy", "Private copy", "Shared notes stay as they are.", true)
    + choiceHtml("share", `Share with ${esc(membersLabel(shareWith))}`, "Everything merged becomes visible to them.", false, avatarStackHtml(shareWith)) : "";
  $("orderHint").hidden = parts.length < 2;
  $("orderList").replaceChildren(...parts.map((p, i) => orderItem(partPreview(notes[p.noteId].body, p), i)));
  $("orderDialog").hidden = false;
  $("orderOk").focus({ preventScroll: true, focusVisible: false });
}

function choiceHtml(value, title, hint, checked, extra = "") {
  return `<label class="choice"><input type="radio" name="mergeMode" value="${value}"${checked ? " checked" : ""}>`
    + `<span class="choice-text"><span class="choice-title">${title}</span><span class="choice-hint">${hint}</span></span>${extra}</label>`;
}

function closeDialog() {
  if (!dialog) return;
  dialog = null;
  $("orderDialog").hidden = true;
}

function orderedFromDialog() {
  return [...$("orderList").children].map(li => dialog.parts[Number(li.dataset.part)]);
}

function orderItem({ text, fromHeading }, i) {
  const li = document.createElement("li");
  li.className = "order-item";
  li.dataset.part = i;
  const label = document.createElement("span");
  label.className = "order-text" + (fromHeading ? "" : " plain");
  label.textContent = text || "Untitled";
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
