// Multi-select over the note list and the table of contents: one selection
// of sections (core/selection.js). A long-press on a note (or Ctrl+click, or
// a mouse click on the card's frame) selects it whole, held on longer — or a
// long-press on a further note while selecting — its sections one by one; a
// long-press on a contents entry selects that section with everything below
// it; then taps add or remove in either place (any tap on a fully selected
// note deselects it), and Shift+click selects a range. The
// selection bar acts on the selection; Copy and Merge first confirm the
// order in a dialog where it can be changed by drag and drop. Ends with ✕,
// Esc, the back button, an empty selection or an action that removes the
// notes from view. Delete moves notes into the trash with Undo. In the trash a
// tap selects; the bar restores, the red bin at the bottom left deletes the
// selection permanently after asking (ui/trash.js) — kept apart on purpose.
import { tableOfContents, sectionKey } from "../core/query.js";
import {
  rangeIds, toggleEntry, selectEntryRange, noteState, toggleNote, selectNotes, selectSections, selectedParts, partText, partPreview,
  copyText, mergeParts, hasHeadings, canShiftHeadings, shiftHeadings, movingParts, targetSections, mergeInto,
} from "../core/selection.js";
import { state, note, removeNotes, setStatuses, setBody, applyMerge, applyMergeInto, circleOf, keptCircle, archiveDone, doneSource, returnDoneTasks } from "../store.js";
import { countDone, clearDone } from "../core/tasks.js";
import { noteTitle } from "../core/markdown.js";
import { restore, restoreOwn, purge } from "./trash.js";
import { mergeCircle, keepsPart } from "../core/sharing.js";
import { membersLabel, avatarStackHtml, esc } from "./people.js";
import { endEdit, markSelected } from "./note-list.js";
import { showSnackbar } from "./snackbar.js";
import { openShareDialog } from "./share-dialog.js";
import { openMenu, pickButton } from "./menu.js";
import { openConfirm, isConfirmOpen } from "./confirm.js";
import { openExport } from "./export.js";
import { icon } from "./icons.js";
import { pushEntry, leaveEntry, afterLeave } from "./dom.js";

const HOLD_MS = 450;
const SPLIT_MS = 900;   // held this long, a note's sections are selected one by one instead of the whole note
const MOVE_TOLERANCE = 10;

const $ = id => document.getElementById(id);
const list = () => $("list");
let opts = null;      // { viewNotes, onMerged, onChange }
let anchorNote = null; // last note toggled, start of a Shift range in the list
let anchorKey = null;  // same for the contents
let press = null;     // { id, key, split, x, y, timer } while a finger / button is down
let down = null;      // { id, key }: the card and heading under the last pointerdown (the click may be moved by the browser's touch adjustment)
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
    const fn = dialog.onConfirm, ordered = orderedFromDialog(), target = dialog.target;
    const mode = $("orderChoice").querySelector("input:checked")?.value || "copy";
    closeDialog();
    fn(ordered, mode, target);
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
    if (dialog) { closeDialog(); pushEntry({ selecting: true }); return; }
    endSelection({ fromHistory: true });
  });
}

// The section a heading in a card starts (main view only: the archive selects whole notes), else null.
function headingKey(target, id) {
  const h = state.view === "open" && target.closest(".note-body h1, .note-body h2, .note-body h3, .note-body h4, .note-body h5, .note-body h6");
  return h ? sectionKey(id, h.closest(".md-section").dataset.section) : null;
}

// A card's frame: its margin and the free part of the meta line, outside the
// text and the controls.
const onFrame = target => !target.closest(".note-body, button, a, input");

function onPointerDown(e) {
  swallowClick = false;
  // Only with the mouse: on touch the frame is a small target and the long-press stays.
  frameDown = e.pointerType === "mouse" && onFrame(e.target);
  const el = e.target.closest(".note");
  down = el && { id: el.dataset.id, key: headingKey(e.target, el.dataset.id) };
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
  const { id, key, split, x, y } = press;
  press = null;
  swallowClick = true; // the click that follows the release
  buzz();
  window.getSelection()?.removeAllRanges();
  if (split) return splitNote(id);
  if (key) return toggleSection(key, { ownNote: true });
  toggle(id);
  // Held on: the note's sections one by one instead (main view, a note with sections below its title).
  if (state.view !== "open" || entries().filter(e => e.noteId === id).length < 2) return;
  press = { id, x, y, timer: setTimeout(() => { press = null; buzz(); splitNote(id); }, SPLIT_MS - HOLD_MS) };
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
  const key = down?.id === id ? down.key : headingKey(e.target, id);
  down = null;
  if (e.shiftKey) key ? selectSectionRange(key) : selectRange(id);
  // A fully selected note is deselected by any tap on it, also on a heading.
  else if (key && (e.ctrlKey || e.metaKey || isSelecting()) && noteState(entries(), state.selected, id) !== "all") toggleSection(key, { ownNote: true });
  else if (e.ctrlKey || e.metaKey || isSelecting() || state.view === "trash" || (frameDown && onFrame(e.target))) toggle(id);
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
  const archive = state.view === "closed", trash = state.view === "trash";
  const canShift = delta => byNote.some(([n, ps]) => canShiftHeadings(n.body, ps, delta))
    && byNote.every(([n, ps]) => canShiftHeadings(n.body, ps, delta) || !hasHeadings(n.body, ps));
  // Close, Share, Permanent and Delete act on whole notes; `menu` = under ⋮ in every tier.
  const ids = byNote.map(([n]) => n.id);
  const permanent = ids.some(id => note(id)?.status !== "permanent");
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
    !archive && { id: "merge", label: "Merge", run: merge, disabled: whole && parts.length < 2 },
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
  $("selMore").onclick = () => openMenu($("selMore"), more.map(a => ({ label: a.label, disabled: a.disabled, onSelect: a.run })));
}

const noteIds = () => current().parts.map(p => p.noteId);
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
  const changes = current().byNote.map(([n, ps]) => ({ id: n.id, ...clearDone(n.body, ps) })).filter(c => c.count);
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

// Export: the selected parts in contents order as one Markdown file; the selection stays.
function exportParts() {
  const { parts, notes, whole } = current();
  openExport({ label: parts.length === 1 ? (whole ? "note" : "section") : what(parts, whole), items: parts.map(p => ({ note: notes[p.noteId], text: partText(notes[p.noteId].body, p) })) });
}

// Merge and "move to a new note" are one mechanism: the parts, in the
// confirmed order, become a new note and leave their notes. Across circles
// the dialog asks where it goes (core/sharing.js → mergeCircle): a private
// copy that leaves the shared notes as they are, or shared with everyone involved.
// Instead of a new note the dialog can take one of the notes involved as the
// target: the parts are placed between its sections, in its circle.
function merge() {
  const { parts, notes, whole } = current();
  const single = parts.length === 1;
  const circles = Object.keys(notes).map(circleOf);
  const across = mergeCircle(circles, "copy").keepShared;
  const choice = across ? mergeCircle(circles, "share").members : null;
  const into = {
    targets: Object.keys(notes).filter(id => movingParts(parts, id).length > 0),
    title: id => single ? (id ? "Move into a note" : "Move to a new note") : `Merge ${what(parts, whole)}`,
    keeps: id => {
      const kept = Object.keys(notes).filter(x => x !== id && keepsPart(circleOf(x), circleOf(id))).flatMap(circleOf);
      return kept.length ? `Notes shared with ${membersLabel([...new Set(kept)])} keep their part for them.` : null;
    },
  };
  openDialog(into.title(null), single ? "Move" : "Merge", parts, notes, (ordered, mode, target) => {
    endSelection();
    if (target) {
      const m = mergeInto(notes, parts, target, ordered);
      const undo = applyMergeInto(target, m.body, m.changes);
      opts.onMerged(note(target), undo, `${single ? "Moved" : "Merged"} into “${noteTitle(note(target).body).text || "Untitled"}”`);
      return;
    }
    const m = mergeParts(notes, ordered);
    const { note: created, undo } = applyMerge(m.changes, m, mode);
    const message = across && mode === "copy" ? "Merged into a private note" : whole ? "Notes merged" : "Moved to a new note";
    opts.onMerged(created, undo, message);
  }, choice, into);
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
// `into` ({ targets, title, keeps }) offers merging into one of the notes involved.
function openDialog(title, okLabel, parts, notes, onConfirm, shareWith = null, into = null) {
  dialog = { onConfirm, parts, notes, shareWith, into, target: null };
  $("orderTitle").textContent = title;
  $("orderOk").textContent = okLabel;
  $("orderChoice").innerHTML = shareWith ? choiceHtml("copy", "Private copy", "Shared notes stay as they are.", true)
    + choiceHtml("share", `Share with ${esc(membersLabel(shareWith))}`, "Everything merged becomes visible to them.", false, avatarStackHtml(shareWith)) : "";
  $("orderTargetRow").hidden = !into?.targets.length;
  $("orderTargetRow").replaceChildren("Into", pickButton("", [["", "New note"],
    ...(into?.targets || []).map(id => [id, noteTitle(notes[id].body).text || "Untitled"])], v => renderDialog(v || null), { label: "Into" }));
  $("orderList").replaceChildren();
  renderDialog(null);
  $("orderDialog").hidden = false;
  $("orderOk").focus({ preventScroll: true, focusVisible: false });
}

// The rows for a new note (null) or a target note: its remaining sections
// as fixed rows, the moving parts after them in their current order.
function renderDialog(target) {
  const { parts, notes, shareWith, into } = dialog;
  dialog.target = target;
  const placed = [...$("orderList").querySelectorAll("[data-part]")].map(li => Number(li.dataset.part));
  const order = placed.length ? placed : parts.map((_, i) => i);
  const moving = target ? new Set(movingParts(parts, target)) : null;
  const rows = order.filter(i => !moving || moving.has(parts[i])).map(i => orderItem(partPreview(notes[parts[i].noteId].body, parts[i]), i));
  const fixed = target ? targetSections(notes, parts, target) : [];
  const top = Math.min(...fixed.map(f => f.depth || 99));
  $("orderList").replaceChildren(...fixed.map((f, i) => fixedItem(f, i, f.depth ? f.depth - top : 0)), ...rows);
  if (into) $("orderTitle").textContent = into.title(target);
  $("orderHint").textContent = target ? "Drag the parts to where they go." : "Drag to change the order.";
  $("orderHint").hidden = !target && parts.length < 2;
  $("orderChoice").hidden = !shareWith || !!target;
  const keep = target && into.keeps(target);
  $("orderKeep").hidden = !keep;
  $("orderKeep").textContent = keep || "";
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
  return [...$("orderList").children].map(li => "section" in li.dataset ? { section: Number(li.dataset.section) } : dialog.parts[Number(li.dataset.part)]);
}

// A section of the target note: stays in place, the parts move around it.
function fixedItem({ text, fromHeading }, i, indent) {
  const li = document.createElement("li");
  li.className = "order-item fixed";
  li.dataset.section = i;
  li.style.setProperty("--indent", indent);
  const label = document.createElement("span");
  label.className = "order-text" + (fromHeading ? "" : " plain");
  label.textContent = text || "Untitled";
  li.append(label);
  return li;
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
