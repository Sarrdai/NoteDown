// Multi-select over the note list and the table of contents: one selection
// of sections (core/selection.js). A long-press on a note (or Ctrl+click, or
// a mouse click on the card's frame, or a right-click) selects it whole, with
// the mouse held on longer — or a long-press on a further note while
// selecting — its sections one by one; on touch the long-press lifts what is
// under the finger, letting go selects it, moving drags it; a long-press on a contents entry selects that section
// with everything below it, one on a heading or a list item in a card that
// section or item; then taps add or remove in either place (any tap on a
// fully selected note deselects it), and Shift+click selects a range.
// Selected list items move up and down among their siblings (Alt+↑ / ↓);
// dragging is ui/drag-drop.js. The
// selection bar acts on the selection; Copy and Merge first confirm the
// order in a dialog where it can be changed by drag and drop. Ends with ✕,
// Esc, the back button, an empty selection or an action that removes the
// notes from view. Delete moves notes into the trash with Undo. In the trash a
// tap selects; the bar restores, the red bin at the bottom left deletes the
// selection permanently after asking (ui/trash.js) — kept apart on purpose.
import { tableOfContents, sectionKey } from "../core/query.js";
import {
  rangeIds, toggleEntry, selectEntryRange, noteState, toggleNote, selectNotes, selectSections, selectedParts, partText, partPreview,
  copyText, mergeParts, hasHeadings, canShiftHeadings, shiftHeadings, toggleItem, selectedItemLines, shiftItemKeys,
} from "../core/selection.js";
import { listItems, parseItemKey, moveItems, itemBlocks } from "../core/list-items.js";
import { gripAt } from "./reorder-mode.js";
import { state, note, removeNotes, setStatuses, setBody, applyMerge, circleOf, keptCircle, archiveDone, doneSource, returnDoneTasks, makePrivateCopies } from "../store.js";
import { countDone, clearDone } from "../core/tasks.js";
import { noteTitle, sections } from "../core/markdown.js";
import { restore, restoreOwn, purge } from "./trash.js";
import { mergeCircle } from "../core/sharing.js";
import { moveTo } from "./move-to.js";
import { endEdit, markSelected } from "./note-list.js";
import { showSnackbar } from "./snackbar.js";
import { openShareDialog } from "./share-dialog.js";
import { openMenu, pickButton } from "./menu.js";
import { openConfirm, isConfirmOpen } from "./confirm.js";
import { openExport } from "./export.js";
import { icon } from "./icons.js";
import { pushEntry, leaveEntry, afterLeave } from "./dom.js";
import { refOf } from "../core/note-ref.js";

const HOLD_MS = 450;
const SPLIT_MS = 900;   // held this long, a note's sections are selected one by one instead of the whole note
const MOVE_TOLERANCE = 10;

const $ = id => document.getElementById(id);
const list = () => $("list");
let opts = null;      // { viewNotes, onMerged, onMoved, onChange }
let anchorNote = null; // last note toggled, start of a Shift range in the list
let anchorKey = null;  // same for the contents
let press = null;     // { id, key, line, split, x, y, timer } while a finger / button is down
let down = null;      // { id, key, line }: the card, heading and list item under the last pointerdown (the click may be moved by the browser's touch adjustment)
let downType = "";    // pointer type of the last pointerdown: a right-click selects with the mouse only
let swallowClick = false;
let frameDown = false; // the mouse went down on a card's frame (desktop)
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
    closeDialog();
    fn(ordered);
  });
  $("orderDialog").addEventListener("click", e => { if (e.target === $("orderDialog")) closeDialog(); });

  const l = list();
  l.addEventListener("pointerdown", onPointerDown);
  l.addEventListener("pointermove", e => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) l.addEventListener(type, cancelPress);
  l.addEventListener("contextmenu", onContextMenu);
  // A lifted finger keeps the list still; the browser only honours this from a listener that was
  // there when the touch began.
  l.addEventListener("touchmove", e => { if (lift) e.preventDefault(); }, { passive: false });
  // Shift+click must not extend the text selection.
  l.addEventListener("mousedown", e => { if (e.shiftKey && e.target.closest(".note:not(.editing)")) e.preventDefault(); });
  // Capture phase on window: runs before the note's own handlers (edit,
  // task toggle, close button) and before note-list's end-edit listener.
  window.addEventListener("click", onClick, true);

  document.addEventListener("keydown", e => {
    // Alt+↑ / ↓ move the selected list items.
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && isSelecting() && !dialog && !isConfirmOpen()) {
      e.preventDefault();
      return moveSelected(e.key === "ArrowUp" ? -1 : 1);
    }
    if (e.key !== "Escape" || isConfirmOpen()) return;
    if (dialog) closeDialog();
    else if (isSelecting()) endSelection();
  });
  // Android back: the selection (and the dialog) sit on a history entry;
  // back from the delete confirmation (its own entry) lands on it again.
  window.addEventListener("popstate", () => {
    if (!isSelecting() || (history.state && history.state.selecting)) return;
    if (dialog) { closeDialog(); pushEntry({ selecting: true }); return; }
    endSelection({ fromHistory: true });
  });
}

// The section a heading in a card starts (main view only: the archive selects whole notes), else null.
function headingKey(target, id) {
  const h = state.view === "open" && target.closest(".note-body h1, .note-body h2, .note-body h3, .note-body h4, .note-body h5, .note-body h6");
  return h ? sectionKey(id, h.closest(".md-section").dataset.section) : null;
}

// The first line of the list item in a card (the innermost one), else null; main view and open notes only.
function itemLine(target, id) {
  const li = state.view === "open" && note(id)?.status !== "closed" && !note(id)?.news && target.closest(".note-body li[data-line]");
  return li ? Number(li.dataset.line) : null;
}

// The section key of the card section holding `target`.
const sectionOf = (target, id) => sectionKey(id, target.closest(".md-section")?.dataset.section ?? 0);

// A card's frame: its margin and the free part of the meta line, outside the
// text and the controls.
const onFrame = target => !target.closest(".note-body, button, a, input");

function onPointerDown(e) {
  swallowClick = false;
  if (gripAt(e.target, e.clientX)) { down = null; return; }   // the reorder mode's grip (ui/reorder-mode.js)
  // Only with the mouse: on touch the frame is a small target and the long-press stays.
  frameDown = e.pointerType === "mouse" && onFrame(e.target);
  downType = e.pointerType;
  const el = e.target.closest(".note");
  down = el && { id: el.dataset.id, key: headingKey(e.target, el.dataset.id), line: itemLine(e.target, el.dataset.id), target: e.target };
  if (!el || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (el.dataset.id === state.editingId) return; // long-press in the editor selects text
  if (!isSelecting() && e.target.closest("input.task:not(:disabled)")) return; // a held task box opens its states (ui/task-menu.js)
  // While selecting, a long-press on another note selects its sections one by one (main view only).
  if (isSelecting() && state.view !== "open") return;
  press = { ...down, split: isSelecting(), x: e.clientX, y: e.clientY, timer: setTimeout(onHold, HOLD_MS) };
}

function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
}

const buzz = () => { try { navigator.vibrate?.(15); } catch { /* not allowed */ } };

function onHold() {
  const { id, key, line, split, x, y, target } = press;
  press = null;
  swallowClick = true; // the click that follows the release
  buzz();
  window.getSelection()?.removeAllRanges();
  if (downType !== "mouse") return startLift(target);
  if (split) return splitNote(id);
  if (key) return toggleSection(key, { ownNote: true });
  if (line !== null) return toggleListItem(id, line);
  toggle(id);
  // Held on: the note's sections one by one instead (main view, a note with sections below its title).
  if (state.view !== "open" || entries().filter(e => e.noteId === id).length < 2) return;
  press = { id, x, y, timer: setTimeout(() => { press = null; buzz(); splitNote(id); }, SPLIT_MS - HOLD_MS) };
}

// A right-click (desktop) acts like a long-press: a note, a heading or a list item starts the selection; while
// selecting it toggles like a click. Links keep the browser's menu, the edited note too; a task box has its
// own menu (ui/task-menu.js). On touch, the long-press's own context menu is only kept from showing.
function onContextMenu(e) {
  const el = e.target.closest(".note");
  const mouse = downType === "mouse" && !press && el && el.dataset.id !== state.editingId && !e.target.closest("a[href]");
  if (!mouse) {
    if (press || isSelecting() || swallowClick || lift) e.preventDefault();
    return;
  }
  e.preventDefault();
  pickAt(e.target);
}

/** The element a pick at `target` (a right-click, a long-press, the grip) would select: the list item,
 *  the heading's section, else the note; null outside a note and in the edited one. */
export function pickTarget(target) {
  const el = target?.closest?.("#list .note");
  if (!el || el.dataset.id === state.editingId) return null;
  if (headingKey(target, el.dataset.id)) return target.closest(".md-section");
  if (itemLine(target, el.dataset.id) !== null) return target.closest(".note-body li[data-line]");
  return el;
}

/** Selects what a pick at `target` hits, as a right-click does: starts the selection with the item, the
 *  heading's section or the note; while selecting (and in the trash) it toggles like a tap. */
export function pickAt(target) {
  const el = target?.closest?.("#list .note");
  if (!el || el.dataset.id === state.editingId) return;
  window.getSelection()?.removeAllRanges();
  const id = el.dataset.id;
  down = null;
  if (isSelecting() || state.view === "trash") return clickNote({ target, shiftKey: false, ctrlKey: false, metaKey: false }, id);
  const key = headingKey(target, id);
  const line = itemLine(target, id);
  if (key) toggleSection(key, { ownNote: true });
  else if (line !== null) toggleListItem(id, line);
  else toggle(id);
}

/** Marks the element a pick would select (null: none) with the preview outline. */
export function showPick(el) {
  for (const old of document.querySelectorAll("#list .pick-preview")) if (old !== el) old.classList.remove("pick-preview");
  el?.classList.add("pick-preview");
}

// ---------- long-press and lift (touch) ----------
// The long-press lifts what is under the finger: an accent outline shows it; letting go selects it (while
// selecting it toggles, like a tap). Moving parts is the reorder mode's grip (ui/reorder-mode.js; decided
// 2026-10-24, user request, over dragging after the long-press).
let lift = null;   // { target } while a lifted finger is down

function startLift(target) {
  lift = { target };
  showPick(pickTarget(target));
  window.addEventListener("touchend", endLift);
  window.addEventListener("touchcancel", endLift);
}

function endLift(e) {
  if (!lift) return;
  const { target } = lift;
  lift = null;
  window.removeEventListener("touchend", endLift);
  window.removeEventListener("touchcancel", endLift);
  showPick(null);
  if (e.type === "touchend") pickAt(target);
}

function onClick(e) {
  const el = e.target.closest("#list .note");
  // The grips (ui/drag-drop.js, ui/reorder-mode.js) drag and select on their own.
  if (e.target.closest("#list .drag-grip") || gripAt(e.target, e.clientX)) { e.preventDefault(); e.stopPropagation(); return; }
  if (swallowClick) {
    swallowClick = false;
    if (el) { e.preventDefault(); e.stopPropagation(); }
    return;
  }
  if (!el || el.dataset.id === state.editingId) return;
  if (!clickNote(e, el.dataset.id)) return;
  e.preventDefault();
  e.stopPropagation();
}

// What a click (or, while selecting, a right-click) on a card does to the selection; false when it doesn't act.
function clickNote(e, id) {
  const ours = down?.id === id;
  const key = ours ? down.key : headingKey(e.target, id);
  const line = ours ? down.line : itemLine(e.target, id);
  down = null;
  const adding = e.ctrlKey || e.metaKey || isSelecting();
  const partly = noteState(entries(), state.selected, id) !== "all";
  if (e.shiftKey) key ? selectSectionRange(key) : selectRange(id);
  // A fully selected note is deselected by any tap on it, also on a heading or an item.
  else if (key && adding && partly) toggleSection(key, { ownNote: true });
  // An item in a selected section takes the section out.
  else if (line !== null && adding && partly) state.selected.has(sectionOf(e.target, id)) ? toggleSection(sectionOf(e.target, id), { ownNote: true }) : toggleListItem(id, line);
  else if (adding || state.view === "trash" || (frameDown && onFrame(e.target))) toggle(id);
  else return false;
  return true;
}

// A card toggles its whole note (a partly selected one becomes whole).
function toggle(id) {
  if (!isSelecting()) begin();
  state.selected = toggleNote(entries(), state.selected, id);
  anchorNote = id;
  changed();
}

// A long hold: the note's sections below its title one by one.
function splitNote(id) {
  if (!isSelecting()) begin();
  state.selected = selectSections(entries(), state.selected, id);
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

// A list item in a card: toggles it with its sub-items.
function toggleListItem(id, line) {
  if (!isSelecting()) begin();
  state.selected = toggleItem(state.selected, id, line);
  changed();
}

/** Contents entry (ui/toc.js), or a heading in a card (`ownNote`): toggles the section with what is below it. */
export function toggleSection(key, { ownNote = false } = {}) {
  const all = entries();
  const i = all.findIndex(e => e.key === key);
  if (i < 0) return;
  if (!isSelecting()) begin();
  state.selected = toggleEntry(all, state.selected, i, { ownNote });
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
  pushEntry({ selecting: true });
}

/** Ends multi-select; `fromHistory` when the back button already left the entry. */
export function endSelection({ fromHistory = false } = {}) {
  if (!active) return;
  active = false;
  closeDialog();
  state.selected.clear();
  anchorNote = anchorKey = null;
  update();
  if (!fromHistory) leaveEntry("selecting");
}

/** After a render: forget selected sections that are no longer in view. */
export function syncSelection(visible) {
  if (!isSelecting()) return;
  const keys = new Set(tableOfContents(visible).entries.map(e => e.key));
  const byId = Object.fromEntries(visible.map(n => [refOf(n), n]));
  const isItem = k => { const at = parseItemKey(k); return at && byId[at.noteId] && listItems(byId[at.noteId].body).some(it => it.line === at.line); };
  for (const k of state.selected) if (!keys.has(k) && !isItem(k)) state.selected.delete(k);
  if (state.selected.size === 0) endSelection();
  else update();
}

/** The selected parts that move along when `at` (ui/drag-drop.js → draggableAt) is dragged: all of them when
 *  `at` is one and every one is of its kind (list items, or sections — a whole note by its title's section),
 *  as [{ noteId, lines: [a, b), from }] (from: the item's indent, the heading's level); else null. */
export function dragGroup(at) {
  if (!isSelecting()) return null;
  const { parts } = current();
  if (parts.length < 2) return null;
  const group = [];
  for (const p of parts) {
    if ((at.kind === "item") !== !!p.item) return null;
    if (p.item) { group.push({ noteId: p.noteId, lines: p.lines, from: p.indent }); continue; }
    const ss = sections(note(p.noteId).body);
    if (!ss[p.from]?.depth) return null;
    group.push({ noteId: p.noteId, lines: [ss[p.from].start, ss[p.to - 1].end], from: ss[p.from].depth });
  }
  return group.some(g => g.noteId === at.noteId && g.lines[0] === at.line) ? group : null;
}

/** The notes that move when note `id` is dragged by its grip (the Shelves): the selected whole notes in the
 *  list's order when it is one of them and only whole notes are selected, else just `id`. */
export function noteDragIds(id) {
  if (!isSelecting()) return [id];
  const { parts } = current();
  return parts.every(p => p.whole) && parts.some(p => p.noteId === id) ? parts.map(p => p.noteId) : [id];
}

// The selection as parts with their notes.
function current() {
  const bodies = Object.fromEntries(selectedItemNotes().map(id => [id, note(id)?.body ?? ""]));
  const parts = selectedParts(entries(), state.selected, bodies);
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
  const archive = state.view === "closed", trash = state.view === "trash";
  const canShift = delta => byNote.some(([n, ps]) => canShiftHeadings(n.body, ps, delta))
    && byNote.every(([n, ps]) => canShiftHeadings(n.body, ps, delta) || !hasHeadings(n.body, ps));
  // Close, Share, Permanent and Delete act on whole notes; `menu` = under ⋮ in every tier.
  const ids = byNote.map(([n]) => refOf(n));
  const permanent = ids.some(id => note(id)?.status !== "permanent");
  // Reordering: the selection is list items of one note that are consecutive siblings.
  const movable = movableItems(parts);
  const reorder = (delta, label) => ({ id: delta < 0 ? "up" : "down", label, run: () => moveSelected(delta),
    disabled: !movable || !moveItems(note(movable).body, selectedItemLines(state.selected, movable), delta), menu: true });
  // News posts are read-only and only this user's: close or reopen, copy, delete.
  const news = byNote.every(([n]) => n.news);
  const actions = trash ? [
    { id: "restore", label: "Restore", run: () => withIds(restore) },
    ids.some(id => keptCircle(id).length) && { id: "lock", label: "Restore as my own", run: () => withIds(restoreOwn) },
    { id: "copy", label: "Copy", run: copy },
  ].filter(Boolean) : news ? [
    archive ? { id: "reopen", label: "Reopen", run: reopen } : { id: "done", label: "Close", run: close, disabled: !whole },
    { id: "copy", label: "Copy", run: copy },
    { id: "trash", label: "Delete", run: remove, disabled: !whole },
  ] : [
    archive ? { id: "reopen", label: "Reopen", run: reopen } : { id: "done", label: "Close", run: close, disabled: !whole || !permanent },
    archive ? { id: "backtonote", label: "Back to note", run: backToNote, disabled: !whole || !ids.every(doneSource) }
      : { id: "cleardone", label: "Clear done tasks", run: clearDoneTasks, disabled: !byNote.some(([n, ps]) => countDone(n.body, ps)) },
    { id: "copy", label: "Copy", run: copy },
    { id: "download", label: "Export", run: exportParts, menu: true },
    !archive && { id: "share", label: "Share", run: share, disabled: !whole },
    !archive && { id: "moveto", label: "Move into…", run: moveParts },
    !archive && movable && reorder(-1, "Move up"),
    !archive && movable && reorder(1, "Move down"),
    // A private copy of shared notes, linked back to the original (backlog #45).
    !archive && { id: "privatecopy", label: "Private copy", run: privateCopies, disabled: !whole || !ids.every(id => circleOf(id).length), menu: true },
    !archive && { id: permanent ? "permanent" : "closable", label: permanent ? "Make permanent" : "Make closable", run: () => setPermanent(permanent), disabled: !whole, menu: true },
    { id: "trash", label: "Delete", run: remove, disabled: !whole },
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
  $("selMore").onclick = () => openMenu($("selMore"), more.map(a => ({ label: a.label, icon: a.id, disabled: a.disabled, onSelect: a.run })));
}

const noteIds = () => current().parts.map(p => p.noteId);

// The notes with selected list items.
const selectedItemNotes = () => [...new Set([...state.selected].map(parseItemKey).filter(Boolean).map(k => k.noteId))];

// The note whose selected items can move (the whole selection is items of that note, one block of siblings), else null.
function movableItems(parts) {
  if (!parts.length || !parts.every(p => p.item && p.noteId === parts[0].noteId)) return null;
  const id = parts[0].noteId;
  return itemBlocks(note(id).body, selectedItemLines(state.selected, id)).length === 1 ? id : null;
}

// Moves the selected items one place up or down among their siblings (Alt+↑ / ↓, Move up / down).
function moveSelected(delta, steps = 1) {
  const id = movableItems(current().parts);
  if (!id) return;
  let body = note(id).body, shift = 0, keys = state.selected;
  for (let i = 0; i < steps; i++) {
    const r = moveItems(body, selectedItemLines(keys, id), delta);
    if (!r) break;
    body = r.body;
    shift += r.shift;
    keys = shiftItemKeys(keys, id, r.shift);
  }
  if (!shift) return;
  state.selected = keys;   // before the note renders anew, so it marks the items in their new place
  setBody(id, body);
  update();
}

const count = (n, word) => n === 1 ? `Note ${word}` : `${n} notes ${word}`;

// Runs `fn` on the selected notes once the selection has ended (its history entry gone, as `fn` may open a dialog).
function withIds(fn) {
  const ids = [...new Set(noteIds())];
  endSelection();
  afterLeave(() => fn(ids));
}

/** The trash's bin: deletes the selected notes permanently after asking; Cancel keeps the selection. */
export function purgeSelected() {
  const ids = [...new Set(noteIds())];
  if (ids.length) purge(ids, { onDone: () => endSelection() });
}

// Permanent notes stay open: Close leaves them alone.
function close() {
  const ids = noteIds().filter(id => note(id)?.status !== "permanent");
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
  endSelection();
  afterLeave(() => openShareDialog(ids));
}

// Private copies of the selected shared notes, on top of the private notes; each links back to its original.
function privateCopies() {
  const ids = noteIds();
  endSelection();
  const { notes, undo } = makePrivateCopies(ids);
  if (notes.length) opts.onMerged(notes[0], undo, notes.length === 1 ? "Private copy made" : `${notes.length} private copies made`);
}

function setPermanent(on) {
  const ids = noteIds();
  endSelection();
  showSnackbar(on ? count(ids.length, "made permanent") : count(ids.length, "made closable"), setStatuses(ids, on ? "permanent" : "open"));
}

// Moves the notes into the trash at once, with Undo (shared ones go for everyone in their circle and wait in
// everyone's trash); news posts are only hidden for this user.
function remove() {
  const ids = [...new Set(noteIds())];
  const news = ids.every(id => note(id)?.news);
  endSelection();
  showSnackbar(news ? (ids.length === 1 ? "Post deleted" : `${ids.length} posts deleted`) : count(ids.length, "moved to trash"), removeNotes(ids));
}

// Clear done tasks: the ticked tasks of the selection (whole notes, or only the selected sections) leave their
// notes after asking and go into the archive, one closed note per source note, with Undo.
function clearDoneTasks() {
  const changes = current().byNote.map(([n, ps]) => ({ id: refOf(n), ...clearDone(n.body, ps) })).filter(c => c.count);
  const total = changes.reduce((sum, c) => sum + c.count, 0);
  const tasks = total === 1 ? "1 done task" : `${total} done tasks`;
  const from = changes.length === 1 ? `“${noteTitle(note(changes[0].id).body).text || "Untitled"}”` : `${changes.length} notes`;
  endSelection();
  afterLeave(() => openConfirm({
    title: `Clear ${tasks}?`,
    text: `They leave ${from} and go to the archive as ${changes.length === 1 ? "a note" : "notes"} of their own; Back to note there puts them back.`,
    okLabel: () => "Clear", danger: false,
    onConfirm: () => showSnackbar(`${tasks[0].toUpperCase()}${tasks.slice(1)} archived`, archiveDone(changes)),
  }));
}

// Back to note: archived done tasks go back into the notes they came from (at the end of their section).
function backToNote() {
  const ids = [...new Set(noteIds())];
  endSelection();
  const title = ids.length === 1 && noteTitle(doneSource(ids[0]).body).text;
  showSnackbar(title ? `Tasks back in “${title}”` : "Tasks back in their notes", returnDoneTasks(ids));
}

function shift(delta) {
  for (const [n, ps] of current().byNote) setBody(refOf(n), shiftHeadings(n.body, ps, delta));
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

// Export: the selected parts in contents order as one Markdown file; the selection stays.
function exportParts() {
  const { parts, notes, whole } = current();
  openExport({ label: parts.length === 1 ? (whole ? "note" : "section") : what(parts, whole), items: parts.map(p => ({ note: notes[p.noteId], text: partText(notes[p.noteId].body, p) })) });
}

// Move into…: the parts go to the end of a section of another note (or of one of theirs), in contents order;
// or to "New note" — merging several parts, splitting one off: they become a new note, in contents order (the
// order is changed after by the grips), and leave their notes. Across circles the picker asks where the new
// note goes (core/sharing.js → mergeCircle): a private copy that leaves the shared notes as they are, or shared
// with everyone involved.
function moveParts() {
  const { parts, notes, whole } = current();
  const candidates = opts.viewNotes().filter(n => n.status !== "closed");
  const circles = Object.keys(notes).map(circleOf);
  const across = mergeCircle(circles, "copy").keepShared;
  const newNote = parts.length === 1 && whole ? null : {
    shareWith: across ? mergeCircle(circles, "share").members : null,
    run: mode => {
      const m = mergeParts(notes, parts);
      const { note: created, undo } = applyMerge(m.changes, m, mode);
      const message = across && mode === "copy" ? "Merged into a private note" : whole ? "Notes merged" : "Moved to a new note";
      opts.onMerged(created, undo, message);
    },
  };
  endSelection();
  afterLeave(() => moveTo({ parts, sources: notes, candidates, onDone: opts.onMoved, newNote }));
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

// Copy's order dialog: onConfirm gets the parts in the order the dialog shows.
function openDialog(title, okLabel, parts, notes, onConfirm) {
  dialog = { onConfirm, parts, notes };
  $("orderTitle").textContent = title;
  $("orderOk").textContent = okLabel;
  $("orderHint").hidden = parts.length < 2;
  $("orderList").replaceChildren(...parts.map((p, i) => orderItem(partPreview(notes[p.noteId].body, p), i)));
  $("orderDialog").hidden = false;
  $("orderOk").focus({ preventScroll: true, focusVisible: false });
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
  li.append(label, orderGrip(li));
  return li;
}

/** The drag handle of an order row (also the custom order's arrange dialog). */
export function orderGrip(li) {
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
  return grip;
}

// Drag by the grip: the row follows the pointer and the others make room.
// The row stays inside the list's visible area; near its top or bottom edge
// the list scrolls along.
const EDGE = 48; // px from the list's edge where it starts scrolling
function startDrag(e, li) {
  e.preventDefault();
  const grip = e.currentTarget;
  const list = li.parentElement;
  grip.setPointerCapture(e.pointerId);
  li.classList.add("dragging");
  let lastY = e.clientY;
  let offset = 0; // where the row should be, relative to its slot
  let shown = 0;  // the translation currently applied
  let frame = 0;
  const slot = () => li.getBoundingClientRect().top - shown;
  // Moves the row past a neighbour; the offset follows the slot's real shift.
  const swap = move => { const t = slot(); move(); offset -= slot() - t; };
  const place = () => {
    // Past a neighbour's middle the row takes its place.
    let prev, next;
    while ((prev = li.previousElementSibling) && offset < (prev.getBoundingClientRect().top - slot()) / 2) swap(() => prev.before(li));
    while ((next = li.nextElementSibling) && offset > (next.getBoundingClientRect().bottom - slot() - li.offsetHeight) / 2) swap(() => next.after(li));
    if (!li.previousElementSibling) offset = Math.max(offset, 0);
    if (!li.nextElementSibling) offset = Math.min(offset, 0);
    const box = list.getBoundingClientRect();
    const top = slot();
    offset = Math.min(Math.max(offset, box.top - top), box.bottom - li.offsetHeight - top);
    shown = offset;
    li.style.transform = `translateY(${offset}px)`;
  };
  const scroll = () => {
    const box = list.getBoundingClientRect();
    const step = lastY < box.top + EDGE ? -8 : lastY > box.bottom - EDGE ? 8 : 0;
    const before = list.scrollTop;
    list.scrollTop += step;
    // The row moved with the content; keep it under the pointer.
    offset += list.scrollTop - before;
    if (step) place();
    frame = step ? requestAnimationFrame(scroll) : 0;
  };
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    offset += ev.clientY - lastY;
    lastY = ev.clientY;
    place();
    if (!frame) frame = requestAnimationFrame(scroll);
  };
  const up = ev => {
    if (ev.pointerId !== e.pointerId) return;
    cancelAnimationFrame(frame);
    li.classList.remove("dragging");
    li.style.transform = "";
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
  // On the window: moving the row in the DOM ends the grip's pointer capture.
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
